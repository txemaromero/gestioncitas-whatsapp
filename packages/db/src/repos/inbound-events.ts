/**
 * Durable inbox of webhook events (F11). The webhook stores each event before answering 200;
 * workers claim them with `FOR UPDATE SKIP LOCKED`, strictly in order per conversation
 * (tenant + phone): an event is only claimable when no older event of the same conversation is
 * still pending or processing. A claim is a lease (`locked_until`): if the worker dies, another
 * one takes the event over once the lease expires. `attempts` doubles as a fencing token, so a
 * stale worker can never complete or reschedule an event that was taken over.
 *
 * Exception to the "tenantId first" rule: claiming is a cross-tenant system operation (like the
 * reminder claims); every event still carries its tenant_id (FK, cascade on tenant deletion).
 */
import type { Db } from '../client';
import type { Prisma } from '../generated/prisma/client';

export type InboundEventSource = 'whatsapp' | 'chatwoot' | 'internal';

export interface NewInboundEvent {
  source: InboundEventSource;
  externalId: string;
  tenantId: string;
  phone: string;
  payload: Prisma.InputJsonValue;
}

export interface ClaimedInboundEvent {
  id: number;
  source: InboundEventSource;
  externalId: string;
  tenantId: string;
  phone: string;
  payload: unknown;
  /** Attempt number of this claim (1 = first try). Also the fencing token. */
  attempts: number;
  receivedAt: Date;
}

export interface InboundQueueStats {
  pending: number;
  processing: number;
  failedLast24h: number;
  /** Seconds since the oldest unfinished event was received (0 when the queue is empty). */
  lagSeconds: number;
}

interface ClaimRow {
  id: bigint;
  source: InboundEventSource;
  external_id: string;
  tenant_id: string;
  phone: string;
  payload: unknown;
  attempts: number;
  received_at: Date;
}

const MAX_ERROR_LENGTH = 2000;
const clipError = (error: string): string => (error.length > MAX_ERROR_LENGTH ? error.slice(0, MAX_ERROR_LENGTH) : error);

export function inboundEventsRepo(db: Db) {
  return {
    /** Stores an event. Returns false when it already existed (duplicate delivery). */
    async enqueue(event: NewInboundEvent): Promise<boolean> {
      const result = await db.inboundEvent.createMany({ data: [event], skipDuplicates: true });
      return result.count > 0;
    },

    /** WhatsApp events stored for a conversation since `since` (cross-instance rate limit). */
    countRecent(tenantId: string, phone: string, since: Date): Promise<number> {
      return db.inboundEvent.count({ where: { tenantId, phone, source: 'whatsapp', receivedAt: { gt: since } } });
    },

    /**
     * Claims the next processable event (oldest first) for `leaseMs`, or null. Pending events
     * whose backoff has elapsed and processing events whose lease expired are claimable, unless
     * an older event of the same conversation is still unfinished.
     */
    async claimNext(leaseMs: number): Promise<ClaimedInboundEvent | null> {
      const rows = await db.$queryRaw<ClaimRow[]>`
        WITH next AS (
          SELECT e.id
          FROM inbound_events e
          WHERE ((e.status = 'pending' AND e.available_at <= now())
              OR (e.status = 'processing' AND e.locked_until < now()))
            AND NOT EXISTS (
              SELECT 1 FROM inbound_events p
              WHERE p.tenant_id = e.tenant_id
                AND p.phone = e.phone
                AND p.id < e.id
                AND p.status IN ('pending', 'processing')
            )
          ORDER BY e.id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE inbound_events u
        SET status = 'processing',
            attempts = u.attempts + 1,
            locked_until = now() + (${leaseMs}::int * interval '1 millisecond')
        FROM next
        WHERE u.id = next.id
        RETURNING u.id, u.source, u.external_id, u.tenant_id, u.phone, u.payload, u.attempts, u.received_at`;
      const row = rows[0];
      if (!row) return null;
      return {
        id: Number(row.id),
        source: row.source,
        externalId: row.external_id,
        tenantId: row.tenant_id,
        phone: row.phone,
        payload: row.payload,
        attempts: row.attempts,
        receivedAt: row.received_at,
      };
    },

    /** Renews the lease of a claimed event (heartbeat). False when it was taken over. */
    async extendLease(id: number, attempts: number, leaseMs: number): Promise<boolean> {
      const count = await db.$executeRaw`
        UPDATE inbound_events
        SET locked_until = now() + (${leaseMs}::int * interval '1 millisecond')
        WHERE id = ${BigInt(id)} AND attempts = ${attempts} AND status = 'processing'`;
      return count > 0;
    },

    /** Marks a claimed event as done and clears its payload (data minimisation). */
    async complete(id: number, attempts: number): Promise<boolean> {
      const { count } = await db.inboundEvent.updateMany({
        where: { id: BigInt(id), attempts, status: 'processing' },
        data: { status: 'done', payload: {}, lockedUntil: null, lastError: null, finishedAt: new Date() },
      });
      return count > 0;
    },

    /** Puts a claimed event back in the queue, claimable again after `delayMs`. */
    async retry(id: number, attempts: number, delayMs: number, error: string): Promise<boolean> {
      const count = await db.$executeRaw`
        UPDATE inbound_events
        SET status = 'pending',
            available_at = now() + (${delayMs}::int * interval '1 millisecond'),
            locked_until = NULL,
            last_error = ${clipError(error)}
        WHERE id = ${BigInt(id)} AND attempts = ${attempts} AND status = 'processing'`;
      return count > 0;
    },

    /** Gives up on a claimed event (kept with its payload for inspection). */
    async fail(id: number, attempts: number, error: string): Promise<boolean> {
      const { count } = await db.inboundEvent.updateMany({
        where: { id: BigInt(id), attempts, status: 'processing' },
        data: { status: 'failed', lockedUntil: null, lastError: clipError(error), finishedAt: new Date() },
      });
      return count > 0;
    },

    async stats(): Promise<InboundQueueStats> {
      const rows = await db.$queryRaw<
        { pending: number; processing: number; failed_last_24h: number; lag_seconds: number | null }[]
      >`
        SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
               count(*) FILTER (WHERE status = 'processing')::int AS processing,
               count(*) FILTER (WHERE status = 'failed' AND finished_at > now() - interval '1 day')::int AS failed_last_24h,
               extract(epoch FROM now() - min(received_at) FILTER (WHERE status IN ('pending', 'processing')))::float8 AS lag_seconds
        FROM inbound_events
        WHERE status IN ('pending', 'processing', 'failed')`;
      const row = rows[0];
      return {
        pending: row?.pending ?? 0,
        processing: row?.processing ?? 0,
        failedLast24h: row?.failed_last_24h ?? 0,
        lagSeconds: Math.max(0, Math.round(row?.lag_seconds ?? 0)),
      };
    },

    /** Deletes done events finished before `doneBefore` and failed ones before `failedBefore`. */
    async purge(doneBefore: Date, failedBefore: Date): Promise<number> {
      const { count } = await db.inboundEvent.deleteMany({
        where: {
          OR: [
            { status: 'done', finishedAt: { lt: doneBefore } },
            { status: 'failed', finishedAt: { lt: failedBefore } },
          ],
        },
      });
      return count;
    },
  };
}

export type InboundEventsRepo = ReturnType<typeof inboundEventsRepo>;
