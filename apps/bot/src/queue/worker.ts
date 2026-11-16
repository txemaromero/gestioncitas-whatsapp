/**
 * Inbound queue worker (F11). Each instance runs `concurrency` loops that claim events from
 * `inbound_events` and hand them to the handler. Order per conversation and exclusivity across
 * instances come from the claim query, so any number of instances can run side by side.
 *  - The claim is a lease, renewed while the handler runs (heartbeat); if the instance dies,
 *    another one takes the event over when the lease expires.
 *  - Errors are retried with exponential backoff up to `maxAttempts`, except NonRetryableError.
 *  - stop() stops claiming and waits for the events in progress (graceful shutdown).
 */
import type { ClaimedInboundEvent, Repos } from '@clinicai/db';
import { maskPhone } from '@clinicai/shared';
import type { Logger } from '../logger';
import type { Signal } from '../utils/signal';

/** Failures that must not be retried (e.g. the reply could not be delivered after the state changed). */
export class NonRetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NonRetryableError';
  }
}

export type InboundEventHandler = (event: ClaimedInboundEvent) => Promise<void>;

export interface InboundWorkerOptions {
  /** Parallel loops in this instance (different conversations are processed in parallel). */
  concurrency?: number;
  maxAttempts?: number;
  /** Poll interval when the queue is empty (the webhook wakes the loops up earlier). */
  pollMs?: number;
  /** Lease of a claimed event; renewed every leaseMs / 3 while it is being processed. */
  leaseMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface InboundWorker {
  start(): void;
  /** Processes claimable events one at a time until none is left (tests, simulator). */
  drain(): Promise<number>;
  /** Stops claiming new events and waits for the ones in progress. */
  stop(): Promise<void>;
}

export interface InboundWorkerDeps {
  /** Owner connection: the queue spans every clinic (F19). */
  systemRepos: Repos;
  logger: Logger;
  inboundSignal: Signal;
}

const DEFAULTS: Required<InboundWorkerOptions> = {
  concurrency: 4,
  maxAttempts: 5,
  pollMs: 1000,
  leaseMs: 30_000,
  retryBaseMs: 5000,
  retryMaxMs: 5 * 60_000,
};

/** 5 s, 10 s, 20 s, 40 s… capped at `max`. */
export function retryDelayMs(attempt: number, base: number, max: number): number {
  return Math.min(base * 2 ** Math.max(0, attempt - 1), max);
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createInboundWorker(
  deps: InboundWorkerDeps,
  handler: InboundEventHandler,
  options: InboundWorkerOptions = {},
): InboundWorker {
  const o = { ...DEFAULTS, ...options };
  // The queue spans every clinic (F19: owner connection).
  const queue = deps.systemRepos.inboundEvents;
  let running = false;
  let loops: Promise<void>[] = [];

  async function runWithHeartbeat(event: ClaimedInboundEvent): Promise<void> {
    const timer = setInterval(() => {
      queue
        .extendLease(event.id, event.attempts, o.leaseMs)
        .then((kept) => {
          if (!kept) deps.logger.warn({ eventId: event.id }, 'inbound event lease lost while processing');
        })
        .catch((error: unknown) => deps.logger.warn({ eventId: event.id, err: errorText(error) }, 'could not extend lease'));
    }, Math.max(10, Math.floor(o.leaseMs / 3)));
    timer.unref();
    try {
      await handler(event);
    } finally {
      clearInterval(timer);
    }
  }

  /** Claims and processes one event. False when there was nothing to claim. */
  async function processOne(): Promise<boolean> {
    const event = await queue.claimNext(o.leaseMs);
    if (!event) return false;
    const log = {
      eventId: event.id,
      source: event.source,
      tenantId: event.tenantId,
      phone: maskPhone(event.phone),
      attempt: event.attempts,
    };
    try {
      await runWithHeartbeat(event);
    } catch (error) {
      const reason = errorText(error);
      if (error instanceof NonRetryableError || event.attempts >= o.maxAttempts) {
        await queue.fail(event.id, event.attempts, reason);
        deps.logger.error({ ...log, err: reason }, 'inbound event failed');
      } else {
        const delay = retryDelayMs(event.attempts, o.retryBaseMs, o.retryMaxMs);
        await queue.retry(event.id, event.attempts, delay, reason);
        deps.logger.warn({ ...log, err: reason, retryInMs: delay }, 'inbound event failed: will retry');
      }
      return true;
    }
    if (!(await queue.complete(event.id, event.attempts))) {
      deps.logger.warn(log, 'inbound event was taken over by another worker (lease expired)');
    }
    return true;
  }

  async function loop(index: number): Promise<void> {
    while (running) {
      try {
        if (await processOne()) continue;
      } catch (error) {
        // Database unavailable or similar: the event (if any) is retried when its lease expires.
        deps.logger.error({ loop: index, err: errorText(error) }, 'inbound queue error');
      }
      if (running) await deps.inboundSignal.wait(o.pollMs);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      loops = Array.from({ length: o.concurrency }, (_, i) => loop(i));
      deps.logger.info({ concurrency: o.concurrency }, 'inbound queue worker started');
    },

    async drain() {
      let processed = 0;
      while (await processOne()) processed += 1;
      return processed;
    },

    async stop() {
      if (!running) return;
      running = false;
      for (let i = 0; i < o.concurrency; i++) deps.inboundSignal.notify();
      await Promise.all(loops);
      loops = [];
      deps.logger.info('inbound queue worker stopped');
    },
  };
}
