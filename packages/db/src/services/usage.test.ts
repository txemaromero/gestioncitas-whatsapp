/**
 * F31 — usage counters (add up per clinic, UTC day, metric and model; purge) and the platform
 * overview. The table is platform-only: the application role cannot read it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Db } from '../index';
import { runWithTenant } from '../tenant-context';
import { createAppointment, createClient, createEmployee, createTenant, createTestAppDb, createTestDb } from '../testing';
import { platformOverview, purgeUsage, recordUsage } from './usage';

let db: Db;
let app: Db;
beforeAll(() => {
  db = createTestDb(inject('databaseUrl'));
  app = createTestAppDb(inject('appDatabaseUrl'));
});
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

const at = (iso: string) => new Date(iso);

describe('usage counters (F31)', () => {
  it('add up per UTC day, metric and model, also when called concurrently', async () => {
    const tenant = await createTenant(db);
    const now = at('2026-11-13T23:30:00Z');
    await Promise.all([
      recordUsage(db, tenant.id, [{ metric: 'whatsapp.inbound', amount: 1 }], now),
      recordUsage(db, tenant.id, [{ metric: 'whatsapp.inbound', amount: 1 }], now),
      recordUsage(
        db,
        tenant.id,
        [
          { metric: 'llm.prompt_tokens', model: 'gpt-4o-mini', amount: 100 },
          { metric: 'llm.prompt_tokens', model: 'gpt-4o-mini', amount: 20 },
          { metric: 'llm.prompt_tokens', model: 'other', amount: 5 },
          { metric: 'whatsapp.outbound', amount: 0 },
        ],
        now,
      ),
    ]);
    // 00:30 in Madrid but still 13 November in UTC; the next UTC day is another row.
    await recordUsage(db, tenant.id, [{ metric: 'whatsapp.inbound', amount: 1 }], at('2026-11-14T00:10:00Z'));

    const rows = await db.usageDaily.findMany({ where: { tenantId: tenant.id }, orderBy: [{ day: 'asc' }, { metric: 'asc' }, { model: 'asc' }] });
    expect(rows.map((r) => [r.day.toISOString().slice(0, 10), r.metric, r.model, Number(r.amount)])).toEqual([
      ['2026-11-13', 'llm.prompt_tokens', 'gpt-4o-mini', 120],
      ['2026-11-13', 'llm.prompt_tokens', 'other', 5],
      ['2026-11-13', 'whatsapp.inbound', '', 2],
      ['2026-11-14', 'whatsapp.inbound', '', 1],
    ]);
  });

  it('are platform data: the application role cannot read them', async () => {
    const tenant = await createTenant(db);
    await recordUsage(db, tenant.id, [{ metric: 'whatsapp.inbound', amount: 1 }]);
    await expect(runWithTenant(tenant.id, () => app.usageDaily.count())).rejects.toThrow(/permission denied/i);
  });

  it('older than the cut-off are deleted', async () => {
    const tenant = await createTenant(db);
    await recordUsage(db, tenant.id, [{ metric: 'whatsapp.inbound', amount: 1 }], at('2024-10-31T12:00:00Z'));
    await recordUsage(db, tenant.id, [{ metric: 'whatsapp.inbound', amount: 1 }], at('2024-11-13T12:00:00Z'));
    expect(await purgeUsage(db, at('2024-11-13T18:00:00Z'))).toBeGreaterThanOrEqual(1);
    const left = await db.usageDaily.findMany({ where: { tenantId: tenant.id } });
    expect(left.map((r) => r.day.toISOString().slice(0, 10))).toEqual(['2024-11-13']);
  });
});

describe('platform overview (F31)', () => {
  it('has the figures of each clinic for the month, without client data', async () => {
    const now = at('2026-11-13T10:00:00Z');
    const period = { from: at('2026-11-01T00:00:00Z'), to: at('2026-12-01T00:00:00Z') };
    const busy = await createTenant(db, {
      clinicName: `Fisio Uso ${randomUUID().slice(0, 6)}`,
      settings: { bookingPageEnabled: true },
    });
    await db.tenantConfig.update({
      where: { id: busy.id },
      data: { waAccessTokenEnc: 'enc', publicSlug: `uso-${randomUUID().slice(0, 8)}`, phoneNormalized: '+34600000001' },
    });
    const quiet = await createTenant(db, { waPhoneNumberId: null });

    await db.tenantMember.createMany({
      data: [
        { tenantId: busy.id, kindeUserId: `kp_${randomUUID()}`, email: 'owner@uso.test', role: 'owner' },
        { tenantId: busy.id, kindeUserId: `kp_${randomUUID()}`, email: 'admin@uso.test', role: 'admin' },
      ],
    });
    const employee = await createEmployee(db, busy.id);
    const client = await createClient(db, busy.id);
    await createClient(db, busy.id);
    const base = { tenantId: busy.id, clientId: client.id, employeeId: employee.id };
    const wa = await createAppointment(db, { ...base, date: at('2026-11-20T09:00:00Z'), source: 'whatsapp' });
    const web = await createAppointment(db, { ...base, date: at('2026-11-21T09:00:00Z'), source: 'web' });
    const old = await createAppointment(db, { ...base, date: at('2026-11-22T09:00:00Z'), source: 'whatsapp' });
    await db.appointment.update({ where: { id: wa.id }, data: { createdAt: at('2026-11-05T10:00:00Z') } });
    await db.appointment.update({ where: { id: web.id }, data: { createdAt: at('2026-11-06T10:00:00Z') } });
    // Booked last month: not in this month's figures.
    await db.appointment.update({ where: { id: old.id }, data: { createdAt: at('2026-10-30T10:00:00Z') } });

    await recordUsage(
      db,
      busy.id,
      [
        { metric: 'whatsapp.inbound', amount: 3 },
        { metric: 'whatsapp.outbound', amount: 4 },
        { metric: 'whatsapp.template', amount: 1 },
        { metric: 'llm.requests', model: 'gpt-4o-mini', amount: 2 },
        { metric: 'llm.prompt_tokens', model: 'gpt-4o-mini', amount: 900 },
        { metric: 'llm.completion_tokens', model: 'gpt-4o-mini', amount: 10 },
        { metric: 'transcription.seconds', model: 'gpt-transcribe', amount: 30 },
      ],
      at('2026-11-10T12:00:00Z'),
    );
    // Last month: not added up, but it still is the last message of the quiet clinic.
    await recordUsage(db, busy.id, [{ metric: 'whatsapp.inbound', amount: 50 }], at('2026-10-20T12:00:00Z'));
    await recordUsage(db, quiet.id, [{ metric: 'whatsapp.inbound', amount: 1 }], at('2026-10-20T12:00:00Z'));

    const event = (status: 'failed' | 'done', finishedAt: Date) => ({
      source: 'whatsapp' as const,
      externalId: `wamid.${randomUUID()}`,
      tenantId: busy.id,
      phone: '+34600000002',
      payload: {},
      status,
      finishedAt,
    });
    await db.inboundEvent.createMany({
      data: [
        event('failed', at('2026-11-13T08:00:00Z')),
        event('failed', at('2026-11-11T08:00:00Z')),
        event('done', at('2026-11-13T08:00:00Z')),
      ],
    });

    const rows = await platformOverview(db, period, now);
    const b = rows.find((r) => r.id === busy.id);
    const q = rows.find((r) => r.id === quiet.id);
    expect(b).toMatchObject({
      clinicName: busy.clinicName,
      ownerEmail: 'owner@uso.test',
      members: 2,
      clients: 2,
      whatsapp: 'own',
      bookingPage: true,
      appointments: { whatsapp: 1, web: 1 },
      failedEvents24h: 1,
      usage: {
        inbound: 3,
        outbound: 4,
        templates: 1,
        llm: { 'gpt-4o-mini': { requests: 2, promptTokens: 900, completionTokens: 10 } },
        transcription: { 'gpt-transcribe': 30 },
      },
    });
    expect(b?.lastInboundDay?.toISOString().slice(0, 10)).toBe('2026-11-10');
    expect(q).toMatchObject({
      ownerEmail: null,
      members: 0,
      clients: 0,
      whatsapp: 'none',
      bookingPage: false,
      appointments: { whatsapp: 0, web: 0 },
      usage: { inbound: 0, outbound: 0, templates: 0, llm: {}, transcription: {} },
      failedEvents24h: 0,
    });
    expect(q?.lastInboundDay?.toISOString().slice(0, 10)).toBe('2026-10-20');
    // Only numbers and the owner's address: nothing of the clients.
    expect(JSON.stringify(b)).not.toMatch(/Cliente Test|cliente@test\.es|\+34600000002/);
  });
});
