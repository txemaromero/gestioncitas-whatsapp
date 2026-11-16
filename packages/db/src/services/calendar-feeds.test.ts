/**
 * F28 — agenda links of the professionals: create, show again, replace and revoke; what the feed
 * contains; revoked when the person leaves the team; isolation between clinics.
 */
import { randomBytes } from 'node:crypto';
import { zonedTimeToUtc } from '@clinicai/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Db } from '../index';
import { runWithTenant } from '../tenant-context';
import { createAppointment, createClient, createEmployee, createService, createTenant, createTestAppDb, createTestDb, createTimeOff } from '../testing';
import {
  calendarFeedEvents,
  createCalendarFeed,
  findCalendarFeedByToken,
  getCalendarFeed,
  revokeCalendarFeed,
  setCalendarFeedFullNames,
  touchCalendarFeed,
} from './calendar-feeds';
import { changeMemberRole, removeMember } from './team';

let db: Db;
let app: Db;
beforeAll(() => {
  db = createTestDb(inject('databaseUrl'));
  app = createTestAppDb(inject('appDatabaseUrl'));
});
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

const KEY = randomBytes(32).toString('base64');
const TZ = 'Europe/Madrid';
const madrid = (month: number, day: number, hour = 0) => zonedTimeToUtc({ year: 2026, month, day, hour, minute: 0 }, TZ);
const NOW = madrid(11, 13, 10);

describe('agenda links (F28)', () => {
  it('are created, shown again, replaced and revoked', async () => {
    const tenant = await createTenant(db);
    const ana = await createEmployee(db, tenant.id, { name: 'Ana' });
    expect(await getCalendarFeed(db, tenant.id, ana.id, KEY)).toBeNull();
    const first = (await createCalendarFeed(db, tenant.id, ana.id, { fullNames: false, encryptionKey: KEY }))!;
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await getCalendarFeed(db, tenant.id, ana.id, KEY)).toMatchObject({ token: first.token, fullNames: false, lastUsedAt: null });
    // Only the hash and the encrypted token are stored.
    const row = await db.calendarFeed.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(JSON.stringify(row)).not.toContain(first.token);
    expect(await findCalendarFeedByToken(db, first.token)).toMatchObject({ tenantId: tenant.id, employeeId: ana.id, employee: { name: 'Ana' } });

    // A new one replaces it: the old link stops working.
    const second = (await createCalendarFeed(db, tenant.id, ana.id, { fullNames: true, encryptionKey: KEY }))!;
    expect(second.token).not.toBe(first.token);
    expect(await findCalendarFeedByToken(db, first.token)).toBeNull();
    expect(await findCalendarFeedByToken(db, second.token)).toMatchObject({ fullNames: true });
    expect(await setCalendarFeedFullNames(db, tenant.id, ana.id, false)).toBe(true);
    expect(await findCalendarFeedByToken(db, second.token)).toMatchObject({ fullNames: false });

    // The use is recorded at most once an hour.
    const feed = (await findCalendarFeedByToken(db, second.token))!;
    await touchCalendarFeed(db, feed.id, NOW);
    await touchCalendarFeed(db, feed.id, new Date(NOW.getTime() + 10 * 60_000));
    expect((await getCalendarFeed(db, tenant.id, ana.id, KEY))!.lastUsedAt).toEqual(NOW);

    expect(await revokeCalendarFeed(db, tenant.id, ana.id)).toBe(true);
    expect(await findCalendarFeedByToken(db, second.token)).toBeNull();
    expect(await revokeCalendarFeed(db, tenant.id, ana.id)).toBe(false);
    expect(await findCalendarFeedByToken(db, 'no-es-un-token')).toBeNull();
    // A professional of another clinic cannot get one here.
    const other = await createTenant(db);
    expect(await createCalendarFeed(db, other.id, ana.id, { fullNames: false, encryptionKey: KEY })).toBeNull();
  });

  it('the feed has the agenda of that professional only, with initials and no notes', async () => {
    const tenant = await createTenant(db);
    const [ana, bea] = await Promise.all([createEmployee(db, tenant.id, { name: 'Ana' }), createEmployee(db, tenant.id, { name: 'Bea' })]);
    const client = await createClient(db, tenant.id, { name: 'Laura Martínez Pérez', notes: 'Lumbalgia' });
    const service = await createService(db, tenant.id, { name: 'Fisioterapia', durationMinutes: 45 });
    const base = { tenantId: tenant.id, clientId: client.id };
    const kept = await createAppointment(db, { ...base, employeeId: ana.id, date: madrid(11, 18, 10), serviceId: service.id, durationMinutes: 45, status: 'confirmed' });
    const pending = await createAppointment(db, { ...base, employeeId: ana.id, date: madrid(11, 19, 10) });
    await createAppointment(db, { ...base, employeeId: ana.id, date: madrid(11, 20, 10), status: 'cancelled' });
    await createAppointment(db, { ...base, employeeId: bea.id, date: madrid(11, 18, 11) });
    // Too old (more than 30 days ago) and too far (more than 6 months ahead).
    await createAppointment(db, { ...base, employeeId: ana.id, date: madrid(9, 1, 10) });
    await createAppointment(db, { ...base, employeeId: ana.id, date: zonedTimeToUtc({ year: 2027, month: 6, day: 1, hour: 10 }, TZ) });
    await createTimeOff(db, { tenantId: tenant.id, employeeId: ana.id, startsAt: madrid(11, 23), endsAt: madrid(11, 25), reason: 'Baja médica' });
    await createTimeOff(db, { tenantId: tenant.id, employeeId: null, startsAt: madrid(12, 8), endsAt: madrid(12, 9), reason: 'Festivo' });
    await createTimeOff(db, { tenantId: tenant.id, employeeId: bea.id, startsAt: madrid(11, 26), endsAt: madrid(11, 27) });

    const events = await runWithTenant(tenant.id, () =>
      calendarFeedEvents(app, tenant.id, { employeeId: ana.id, fullNames: false, clinicName: 'FisioDemo', timeZone: TZ, now: NOW }),
    );
    expect(events).toEqual([
      {
        uid: `${kept.id}@clinicai`,
        summary: 'L. M. · Fisioterapia',
        description: 'Cita en FisioDemo. Estado: confirmada.',
        start: madrid(11, 18, 10),
        end: new Date(madrid(11, 18, 10).getTime() + 45 * 60_000),
        status: 'CONFIRMED',
      },
      expect.objectContaining({ uid: `${pending.id}@clinicai`, summary: 'L. M.', status: 'TENTATIVE', description: 'Cita en FisioDemo. Estado: pendiente.' }),
      // The reason of an absence is not shown; a closure's is.
      expect.objectContaining({ summary: 'Ausencia', allDay: { startKey: '2026-11-23', endKey: '2026-11-25' } }),
      expect.objectContaining({ summary: 'Clínica cerrada: Festivo', allDay: { startKey: '2026-12-08', endKey: '2026-12-09' } }),
    ]);
    expect(JSON.stringify(events)).not.toMatch(/Lumbalgia|Baja|Laura/);

    const named = await runWithTenant(tenant.id, () =>
      calendarFeedEvents(app, tenant.id, { employeeId: ana.id, fullNames: true, clinicName: 'FisioDemo', timeZone: TZ, now: NOW }),
    );
    expect(named[0]!.summary).toBe('Laura Martínez Pérez · Fisioterapia');
  });

  it('is revoked when its professional leaves the team or changes professional', async () => {
    const tenant = await createTenant(db);
    const [ana, bea] = await Promise.all([createEmployee(db, tenant.id, { name: 'Ana' }), createEmployee(db, tenant.id, { name: 'Bea' })]);
    const owner = await db.tenantMember.create({ data: { tenantId: tenant.id, kindeUserId: `kp_${randomBytes(4).toString('hex')}`, email: 'o@c.test', role: 'owner' } });
    const pro = await db.tenantMember.create({
      data: { tenantId: tenant.id, kindeUserId: `kp_${randomBytes(4).toString('hex')}`, email: 'p@c.test', role: 'professional', employeeId: ana.id },
    });
    const feed = (await createCalendarFeed(db, tenant.id, ana.id, { fullNames: false, encryptionKey: KEY }))!;
    expect(await changeMemberRole(db, tenant.id, pro.id, owner.kindeUserId, { role: 'professional', employeeId: bea.id })).toBe('changed');
    expect(await findCalendarFeedByToken(db, feed.token)).toBeNull();

    const beaFeed = (await createCalendarFeed(db, tenant.id, bea.id, { fullNames: false, encryptionKey: KEY }))!;
    expect(await removeMember(db, tenant.id, pro.id, owner.kindeUserId)).toBe('removed');
    expect(await findCalendarFeedByToken(db, beaFeed.token)).toBeNull();
  });

  it('the application role only sees the links of its clinic', async () => {
    const a = await createTenant(db);
    const b = await createTenant(db);
    const ana = await createEmployee(db, a.id);
    await createCalendarFeed(db, a.id, ana.id, { fullNames: false, encryptionKey: KEY });
    await runWithTenant(b.id, async () => {
      expect(await app.calendarFeed.count()).toBe(0);
    });
    await runWithTenant(a.id, async () => {
      expect(await app.calendarFeed.count()).toBe(1);
    });
  });
});
