/**
 * F27 — free slots of the public booking page: same rules as the bot, from an hour from now,
 * 14 days (today included), grouped by local day; and the clinic of a page address.
 */
import { zonedTimeToUtc, type ScheduleSlot } from '@clinicai/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Db } from '../index';
import { tenantsRepo } from '../repos/tenants';
import { createAppointment, createClient, createEmployee, createTenant, createTestDb, createTimeOff } from '../testing';
import { bookingPageDays } from './booking-page';

let db: Db;
beforeAll(() => {
  db = createTestDb(inject('databaseUrl'));
});
afterAll(async () => {
  await db.$disconnect();
});

const TZ = 'Europe/Madrid';
const madrid = (month: number, day: number, hour: number, minute = 0) => zonedTimeToUtc({ year: 2026, month, day, hour, minute }, TZ);
// Monday 9 to 12 and Wednesday 10 to 12.
const SCHEDULE: ScheduleSlot[] = [
  { day: 'monday', start: '09:00', end: '12:00' },
  { day: 'wednesday', start: '10:00', end: '12:00' },
];

describe('booking page (F27)', () => {
  it('lists the free slots by day, skipping busy ones, closures and the next hour', async () => {
    const tenant = await createTenant(db);
    const employee = await createEmployee(db, tenant.id, { schedule: SCHEDULE });
    const client = await createClient(db, tenant.id);
    // Busy on Wednesday 18 at 10:00; the clinic closed on Monday 23.
    await createAppointment(db, { tenantId: tenant.id, clientId: client.id, employeeId: employee.id, date: madrid(11, 18, 10) });
    await createTimeOff(db, { tenantId: tenant.id, employeeId: null, startsAt: madrid(11, 23, 0), endsAt: madrid(11, 24, 0) });

    // Monday 16 November, 9:30: 10:00 starts within the hour, so the first slot is 11:00.
    const days = await bookingPageDays(db, tenant.id, { durationMinutes: 60, slotMinutes: 60, timeZone: TZ, now: madrid(11, 16, 9, 30) });
    expect(days.map((d) => [d.dayKey, d.slots.map((s) => s.toISOString())])).toEqual([
      ['2026-11-16', [madrid(11, 16, 11).toISOString()]],
      ['2026-11-18', [madrid(11, 18, 11).toISOString()]],
      ['2026-11-25', [madrid(11, 25, 10).toISOString(), madrid(11, 25, 11).toISOString()]],
    ]);
    // Day 14 is Sunday 29: Monday 30 is not shown.
    expect(days.at(-1)!.dayKey <= '2026-11-29').toBe(true);

    // 90 minutes: Monday at 9:00 or 10:00 (until 12:00); Wednesday only at 10:00, and not on the
    // 18th (busy at 10:00).
    const long = await bookingPageDays(db, tenant.id, { durationMinutes: 90, slotMinutes: 60, timeZone: TZ, now: madrid(11, 16, 7) });
    expect(long.map((d) => [d.dayKey, d.slots.map((s) => s.toISOString())])).toEqual([
      ['2026-11-16', [madrid(11, 16, 9).toISOString(), madrid(11, 16, 10).toISOString()]],
      ['2026-11-25', [madrid(11, 25, 10).toISOString()]],
    ]);
  });

  it('finds the clinic of a page address', async () => {
    const tenant = await createTenant(db);
    const slug = `clinica-${tenant.id.slice(0, 8)}`;
    await tenantsRepo(db).update(tenant.id, { publicSlug: slug, settings: { bookingPageEnabled: true } });
    expect(await tenantsRepo(db).findByPublicSlug(slug)).toMatchObject({ id: tenant.id, publicSlug: slug, settings: { bookingPageEnabled: true } });
    expect(await tenantsRepo(db).findByPublicSlug('no-existe-nunca')).toBeNull();
    // Two clinics cannot share an address.
    const other = await createTenant(db);
    await expect(tenantsRepo(db).update(other.id, { publicSlug: slug })).rejects.toThrow();
  });
});
