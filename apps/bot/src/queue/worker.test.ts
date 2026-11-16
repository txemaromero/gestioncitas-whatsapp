/**
 * F11 — durable inbound queue: no message is lost when an instance dies, every event is
 * processed once and in order per conversation, also with several instances.
 */
import { randomUUID } from 'node:crypto';
import type { ClaimedInboundEvent } from '@clinicai/db';
import { createClient, createTenant, uniquePhone } from '@clinicai/db/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDeps, getTestDb, resetQueue } from '../../test/helpers';
import { createConversationEngine } from '../engine/engine';
import { createMockWhatsAppClient, WhatsAppApiError } from '../services/whatsapp';
import { createInboundEventHandler } from './handler';
import { createInboundWorker, NonRetryableError, retryDelayMs, type InboundEventHandler } from './worker';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > until) throw new Error('timed out waiting for condition');
    await sleep(20);
  }
}

async function enqueue(tenantId: string, phone: string, payload: Record<string, string | number>): Promise<string> {
  const externalId = `wamid.${randomUUID()}`;
  await getTestDb().inboundEvent.create({ data: { source: 'whatsapp', externalId, tenantId, phone, payload } });
  return externalId;
}

const statusOf = (externalId: string) =>
  getTestDb().inboundEvent.findUniqueOrThrow({ where: { source_externalId: { source: 'whatsapp', externalId } } });

beforeEach(async () => {
  await resetQueue();
});

describe('inbound queue worker', () => {
  it('processes, in order, messages stored while no instance was running (restart)', async () => {
    const tenant = await createTenant(getTestDb());
    const phone = uniquePhone();
    const ids = [await enqueue(tenant.id, phone, { n: 1 }), await enqueue(tenant.id, phone, { n: 2 })];

    const seen: unknown[] = [];
    const worker = createInboundWorker(createTestDeps(), async (event) => {
      seen.push(event.payload);
    });
    expect(await worker.drain()).toBe(2);
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
    for (const id of ids) expect(await statusOf(id)).toMatchObject({ status: 'done', attempts: 1 });
    expect(await worker.drain()).toBe(0);
  });

  it('takes over a message left half-done by an instance that died, once its lease expires', async () => {
    const deps = createTestDeps();
    const tenant = await createTenant(getTestDb());
    const id = await enqueue(tenant.id, uniquePhone(), { n: 1 });
    // Instance A claims the message and dies (never completes it).
    const dead = await deps.systemRepos.inboundEvents.claimNext(1);
    expect(dead?.externalId).toBe(id);
    await sleep(20);

    const calls: number[] = [];
    const worker = createInboundWorker(deps, async (event) => {
      calls.push(event.attempts);
    });
    expect(await worker.drain()).toBe(1);
    expect(calls).toEqual([2]);
    expect(await statusOf(id)).toMatchObject({ status: 'done', attempts: 2 });
    // A late completion from the dead instance is fenced off.
    expect(await deps.systemRepos.inboundEvents.complete(dead!.id, dead!.attempts)).toBe(false);
  });

  it('retries failures with backoff, gives up after maxAttempts and never retries NonRetryableError', async () => {
    const tenant = await createTenant(getTestDb());
    const flaky = await enqueue(tenant.id, uniquePhone(), { kind: 'flaky' });
    const broken = await enqueue(tenant.id, uniquePhone(), { kind: 'broken' });
    const fatal = await enqueue(tenant.id, uniquePhone(), { kind: 'fatal' });

    const attempts: Record<string, number> = {};
    const handler: InboundEventHandler = async (event) => {
      const kind = (event.payload as { kind: string }).kind;
      attempts[kind] = event.attempts;
      if (kind === 'flaky' && event.attempts < 3) throw new Error('database timeout');
      if (kind === 'broken') throw new Error('always failing');
      if (kind === 'fatal') throw new NonRetryableError('invalid payload');
    };
    const worker = createInboundWorker(createTestDeps(), handler, { maxAttempts: 4, retryBaseMs: 0 });
    await worker.drain();

    expect(attempts).toEqual({ flaky: 3, broken: 4, fatal: 1 });
    expect(await statusOf(flaky)).toMatchObject({ status: 'done', attempts: 3, lastError: null });
    expect(await statusOf(broken)).toMatchObject({ status: 'failed', attempts: 4, lastError: 'always failing' });
    expect(await statusOf(fatal)).toMatchObject({ status: 'failed', attempts: 1, lastError: 'invalid payload' });
    expect([1, 2, 3, 4, 10].map((a) => retryDelayMs(a, 5000, 300_000))).toEqual([5000, 10_000, 20_000, 40_000, 300_000]);
  });

  it('does not run a flow twice when the reply cannot be delivered after the state changed', async () => {
    const failingWhatsApp = {
      ...createMockWhatsAppClient(),
      send: async () => {
        throw new WhatsAppApiError('WhatsApp API 503: Service unavailable', 503, undefined, true);
      },
    };
    const deps = createTestDeps({ overrides: { whatsapp: failingWhatsApp } });
    const db = getTestDb();
    const tenantRow = await createTenant(db);
    const phone = uniquePhone();
    await createClient(db, tenantRow.id, { name: 'Laura Martínez', phone });
    const envelope = {
      phoneNumberId: tenantRow.waPhoneNumberId,
      message: { from: phone.slice(1), id: `wamid.${randomUUID()}`, timestamp: '1746515700', type: 'text', text: { body: 'Quiero cita' } },
    };
    const externalId = envelope.message.id;
    await db.inboundEvent.create({ data: { source: 'whatsapp', externalId, tenantId: tenantRow.id, phone, payload: envelope } });

    const engine = createConversationEngine(deps);
    let calls = 0;
    const handler = createInboundEventHandler(deps, { handle: (t, m) => ((calls += 1), engine.handle(t, m)) }, null);
    await createInboundWorker(deps, handler, { retryBaseMs: 0 }).drain();

    expect(calls).toBe(1);
    expect(await statusOf(externalId)).toMatchObject({ status: 'failed', attempts: 1 });
    expect((await statusOf(externalId)).lastError).toContain('reply delivery failed');
    // The state did advance (the date question was asked), so a retry would have skipped a step.
    expect(await deps.systemRepos.conversations.get(tenantRow.id, phone, deps.clock.now())).toMatchObject({ flow: 'cita' });
  });

  it('two instances in parallel: each message once, conversations in order and never concurrently', async () => {
    const tenant = await createTenant(getTestDb());
    const phones = [uniquePhone(), uniquePhone(), uniquePhone(), uniquePhone()];
    const expected = new Map<string, number[]>(phones.map((p) => [p, []]));
    for (let n = 1; n <= 6; n++) {
      for (const phone of phones) {
        await enqueue(tenant.id, phone, { n });
        expected.get(phone)!.push(n);
      }
    }

    const order = new Map<string, number[]>(phones.map((p) => [p, []]));
    const active = new Set<string>();
    let overlaps = 0;
    let maxParallel = 0;
    const handler: InboundEventHandler = async (event: ClaimedInboundEvent) => {
      if (active.has(event.phone)) overlaps += 1;
      active.add(event.phone);
      maxParallel = Math.max(maxParallel, active.size);
      await sleep(Math.floor(Math.random() * 15));
      order.get(event.phone)!.push((event.payload as { n: number }).n);
      active.delete(event.phone);
    };
    const options = { concurrency: 3, pollMs: 20 };
    const instances = [createInboundWorker(createTestDeps(), handler, options), createInboundWorker(createTestDeps(), handler, options)];
    instances.forEach((w) => w.start());
    await waitFor(() => [...order.values()].reduce((sum, list) => sum + list.length, 0) === 24);
    await Promise.all(instances.map((w) => w.stop()));

    expect(overlaps).toBe(0);
    expect(order).toEqual(expected);
    expect(maxParallel).toBeGreaterThan(1);
    expect(await getTestDb().inboundEvent.count({ where: { tenantId: tenant.id, status: 'done' } })).toBe(24);
  });

  it('graceful stop: finishes the message in progress and leaves the rest queued for the next instance', async () => {
    const tenant = await createTenant(getTestDb());
    const phone = uniquePhone();
    const first = await enqueue(tenant.id, phone, { n: 1 });
    const second = await enqueue(tenant.id, phone, { n: 2 });

    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let started = false;
    const worker = createInboundWorker(createTestDeps(), async () => {
      started = true;
      await released;
    }, { concurrency: 1, pollMs: 20 });
    worker.start();
    await waitFor(() => started);

    let stopped = false;
    const stopping = worker.stop().then(() => (stopped = true));
    await sleep(50);
    expect(stopped).toBe(false);
    release();
    await stopping;

    expect(await statusOf(first)).toMatchObject({ status: 'done' });
    expect(await statusOf(second)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('renews the lease while a slow message is processed, so no other instance takes it over', async () => {
    const deps = createTestDeps();
    const tenant = await createTenant(getTestDb());
    const id = await enqueue(tenant.id, uniquePhone(), { n: 1 });
    let calls = 0;
    const worker = createInboundWorker(deps, async () => {
      calls += 1;
      await sleep(300);
    }, { concurrency: 1, pollMs: 20, leaseMs: 90 });
    worker.start();
    await waitFor(() => calls === 1);
    for (let i = 0; i < 5; i++) {
      await sleep(50);
      expect(await deps.systemRepos.inboundEvents.claimNext(1000)).toBeNull();
    }
    await waitFor(async () => (await statusOf(id)).status === 'done');
    await worker.stop();
    expect(calls).toBe(1);
    expect(await statusOf(id)).toMatchObject({ attempts: 1 });
  });
});
