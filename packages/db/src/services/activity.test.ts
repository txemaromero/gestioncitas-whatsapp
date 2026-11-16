/**
 * F24 — activity log: listing, append-only for the application role, GDPR (erasure, anonymisation,
 * export) and retention.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Db } from '../index';
import { runWithTenant } from '../tenant-context';
import { createClient, createTenant, createTestAppDb, createTestDb } from '../testing';
import { listActivity, logActivity, purgeActivity } from './activity';
import { anonymizeInactiveClients, eraseClient, exportClientData } from './privacy';

let db: Db;
let app: Db;
beforeAll(() => {
  db = createTestDb(inject('databaseUrl'));
  app = createTestAppDb(inject('appDatabaseUrl'));
});
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

const member = (action: string, extra: object = {}) => ({ actorType: 'member' as const, actorLabel: 'admin@clinica.test', action, ...extra });

describe('activity log (F24)', () => {
  it('lists newest first, by category and with a cursor', async () => {
    const tenant = await createTenant(db);
    for (const action of ['appointments.create', 'clients.update', 'team.invite', 'whatsapp.appointment_booked', 'tenant.update']) {
      await logActivity(db, tenant.id, member(action));
    }
    const all = await listActivity(db, tenant.id, { limit: 10 });
    expect(all.map((a) => a.action)).toEqual(['tenant.update', 'whatsapp.appointment_booked', 'team.invite', 'clients.update', 'appointments.create']);
    expect((await listActivity(db, tenant.id, { limit: 10, category: 'citas' })).map((a) => a.action)).toEqual([
      'whatsapp.appointment_booked',
      'appointments.create',
    ]);
    const page = await listActivity(db, tenant.id, { limit: 2, before: all[1]!.id });
    expect(page.map((a) => a.action)).toEqual(['team.invite', 'clients.update']);
    const other = await createTenant(db);
    expect(await listActivity(db, other.id, { limit: 10 })).toEqual([]);
  });

  it('is append-only for the application role (it can only clear the client link)', async () => {
    const tenant = await createTenant(db);
    const client = await createClient(db, tenant.id);
    await runWithTenant(tenant.id, async () => {
      await logActivity(app, tenant.id, member('clients.get', { clientId: client.id, entityId: client.id }));
      await expect(app.activityLog.updateMany({ where: { tenantId: tenant.id }, data: { action: 'otra.cosa' } })).rejects.toThrow(/permission denied/);
      await expect(app.activityLog.deleteMany({ where: { tenantId: tenant.id } })).rejects.toThrow(/permission denied/);
      expect((await app.activityLog.updateMany({ where: { tenantId: tenant.id }, data: { clientId: null } })).count).toBe(1);
    });
  });

  it('erasure and anonymisation remove the link to the client; the export lists the entries', async () => {
    const tenant = await createTenant(db, { settings: { retentionMonths: 12 } });
    const erased = await createClient(db, tenant.id);
    const kept = await createClient(db, tenant.id);
    await logActivity(db, tenant.id, member('clients.update', { clientId: erased.id, entityId: erased.id }));
    await logActivity(db, tenant.id, member('clients.get', { clientId: kept.id, entityId: kept.id }));

    const exported = await exportClientData(db, tenant.id, kept.id);
    expect(exported.activity).toEqual([{ at: expect.any(String), action: 'clients.get', by: 'clinic staff' }]);

    await eraseClient(db, tenant.id, erased.id);
    expect(await db.activityLog.count({ where: { tenantId: tenant.id, clientId: erased.id } })).toBe(0);
    // The entry stays (accountability) with the id of a record that no longer exists.
    expect(await db.activityLog.count({ where: { tenantId: tenant.id, entityId: erased.id } })).toBe(1);

    // Retention: an old client without appointments is anonymised, and the job leaves its entry.
    await db.client.update({ where: { id: kept.id }, data: { createdAt: new Date('2020-01-01T00:00:00Z') } });
    await anonymizeInactiveClients(db, new Date());
    expect(await db.activityLog.count({ where: { tenantId: tenant.id, clientId: kept.id } })).toBe(0);
    expect(await db.activityLog.findFirst({ where: { tenantId: tenant.id, action: 'system.client_anonymized' } })).toMatchObject({
      actorType: 'system',
      entityId: kept.id,
      details: { retentionMonths: 12 },
    });
  });

  it('purges entries older than the retention period', async () => {
    const tenant = await createTenant(db);
    await logActivity(db, tenant.id, member('tenant.update'));
    await db.activityLog.updateMany({ where: { tenantId: tenant.id }, data: { createdAt: new Date('2020-01-01T00:00:00Z') } });
    await logActivity(db, tenant.id, member('team.invite'));
    await purgeActivity(db, new Date('2021-01-01T00:00:00Z'));
    expect((await listActivity(db, tenant.id, { limit: 10 })).map((a) => a.action)).toEqual(['team.invite']);
  });
});
