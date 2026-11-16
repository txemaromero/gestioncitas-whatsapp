import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createRepos, type Db } from '../index';
import { createTenant, createTestDb, resetInboundQueue, uniquePhone } from '../testing';

let db: Db;
let repos: ReturnType<typeof createRepos>;

beforeAll(() => {
  db = createTestDb(inject('databaseUrl'));
  repos = createRepos(db);
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await resetInboundQueue(db);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function enqueue(tenantId: string, phone: string, text = 'hola'): Promise<string> {
  const externalId = `wamid.${randomUUID()}`;
  expect(await repos.inboundEvents.enqueue({ source: 'whatsapp', externalId, tenantId, phone, payload: { text } })).toBe(true);
  return externalId;
}

async function rowOf(externalId: string) {
  return db.inboundEvent.findUniqueOrThrow({ where: { source_externalId: { source: 'whatsapp', externalId } } });
}

describe('inbound events queue', () => {
  it('is idempotent per (source, external id)', async () => {
    const tenant = await createTenant(db);
    const event = { source: 'whatsapp' as const, externalId: `wamid.${randomUUID()}`, tenantId: tenant.id, phone: uniquePhone(), payload: {} };
    expect(await repos.inboundEvents.enqueue(event)).toBe(true);
    expect(await repos.inboundEvents.enqueue(event)).toBe(false);
    expect(await repos.inboundEvents.enqueue({ ...event, source: 'chatwoot' })).toBe(true);
  });

  it('claims oldest first and keeps each conversation in order', async () => {
    const tenant = await createTenant(db);
    const [a, b] = [uniquePhone(), uniquePhone()];
    const a1 = await enqueue(tenant.id, a, 'a1');
    const a2 = await enqueue(tenant.id, a, 'a2');
    const b1 = await enqueue(tenant.id, b, 'b1');

    const first = await repos.inboundEvents.claimNext(60_000);
    expect(first).toMatchObject({ externalId: a1, phone: a, attempts: 1, payload: { text: 'a1' }, tenantId: tenant.id });
    // a2 waits for a1; the other conversation is not blocked.
    expect((await repos.inboundEvents.claimNext(60_000))?.externalId).toBe(b1);
    expect(await repos.inboundEvents.claimNext(60_000)).toBeNull();

    expect(await repos.inboundEvents.complete(first!.id, first!.attempts)).toBe(true);
    expect((await repos.inboundEvents.claimNext(60_000))?.externalId).toBe(a2);
  });

  it('never hands the same event or two events of one conversation to concurrent workers', async () => {
    const tenant = await createTenant(db);
    const phones = [uniquePhone(), uniquePhone(), uniquePhone()];
    const firsts: string[] = [];
    for (let round = 0; round < 3; round++) {
      for (const phone of phones) {
        const id = await enqueue(tenant.id, phone, `${phone}-${round}`);
        if (round === 0) firsts.push(id);
      }
    }
    const claims = await Promise.all(Array.from({ length: 8 }, () => repos.inboundEvents.claimNext(60_000)));
    const claimed = claims.filter((c) => c !== null);
    expect(claimed.map((c) => c.externalId).sort()).toEqual([...firsts].sort());
    expect(new Set(claimed.map((c) => c.phone)).size).toBe(3);
  });

  it('takes over an event whose lease expired and fences the stale worker', async () => {
    const tenant = await createTenant(db);
    const externalId = await enqueue(tenant.id, uniquePhone());

    const stale = await repos.inboundEvents.claimNext(1);
    expect(stale?.attempts).toBe(1);
    await sleep(20);
    const takeover = await repos.inboundEvents.claimNext(60_000);
    expect(takeover).toMatchObject({ externalId, attempts: 2 });

    // The worker that "died" cannot finish or reschedule it any more.
    expect(await repos.inboundEvents.complete(stale!.id, stale!.attempts)).toBe(false);
    expect(await repos.inboundEvents.retry(stale!.id, stale!.attempts, 0, 'late')).toBe(false);
    expect(await repos.inboundEvents.complete(takeover!.id, takeover!.attempts)).toBe(true);

    const row = await rowOf(externalId);
    expect(row).toMatchObject({ status: 'done', attempts: 2, payload: {}, lockedUntil: null });
    expect(row.finishedAt).toBeInstanceOf(Date);
  });

  it('retries after the backoff and keeps failed events (with payload) without blocking the conversation', async () => {
    const tenant = await createTenant(db);
    const phone = uniquePhone();
    const first = await enqueue(tenant.id, phone, 'first');
    const second = await enqueue(tenant.id, phone, 'second');

    const claim1 = (await repos.inboundEvents.claimNext(60_000))!;
    expect(await repos.inboundEvents.retry(claim1.id, claim1.attempts, 60_000, 'boom')).toBe(true);
    // Backoff not elapsed: neither it nor the next message of the conversation is claimable.
    expect(await repos.inboundEvents.claimNext(60_000)).toBeNull();
    expect(await rowOf(first)).toMatchObject({ status: 'pending', lastError: 'boom' });

    await db.inboundEvent.update({ where: { id: BigInt(claim1.id) }, data: { availableAt: new Date(Date.now() - 1000) } });
    const claim2 = (await repos.inboundEvents.claimNext(60_000))!;
    expect(claim2).toMatchObject({ externalId: first, attempts: 2 });
    expect(await repos.inboundEvents.fail(claim2.id, claim2.attempts, 'gave up')).toBe(true);
    expect(await rowOf(first)).toMatchObject({ status: 'failed', lastError: 'gave up', payload: { text: 'first' } });

    expect((await repos.inboundEvents.claimNext(60_000))?.externalId).toBe(second);
  });

  it('reports stats, counts recent messages per conversation and purges old events', async () => {
    const tenant = await createTenant(db);
    const phone = uniquePhone();
    await enqueue(tenant.id, phone);
    await enqueue(tenant.id, phone);
    const since = new Date(Date.now() - 60_000);
    expect(await repos.inboundEvents.countRecent(tenant.id, phone, since)).toBe(2);
    expect(await repos.inboundEvents.countRecent(tenant.id, uniquePhone(), since)).toBe(0);

    const claim = (await repos.inboundEvents.claimNext(60_000))!;
    expect(await repos.inboundEvents.stats()).toMatchObject({ pending: 1, processing: 1 });
    await repos.inboundEvents.complete(claim.id, claim.attempts);

    const old = new Date(Date.now() - 40 * 24 * 3600_000);
    await db.inboundEvent.update({ where: { id: BigInt(claim.id) }, data: { finishedAt: old } });
    const future = new Date(Date.now() + 1000);
    expect(await repos.inboundEvents.purge(new Date(old.getTime() + 1000), future)).toBeGreaterThanOrEqual(1);
    expect(await db.inboundEvent.findUnique({ where: { id: BigInt(claim.id) } })).toBeNull();
  });

  it('deletes the events of a tenant together with the tenant', async () => {
    const tenant = await createTenant(db);
    const externalId = await enqueue(tenant.id, uniquePhone());
    await db.tenantConfig.delete({ where: { id: tenant.id } });
    expect(
      await db.inboundEvent.findUnique({ where: { source_externalId: { source: 'whatsapp', externalId } } }),
    ).toBeNull();
  });
});
