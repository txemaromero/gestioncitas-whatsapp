/**
 * F26 — treatments: planning a series with the booking rules, booking it all or nothing, its
 * position and cancelling an appointment and the following ones.
 */
import { zonedTimeToUtc, type ScheduleSlot } from '@clinicai/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Db } from '../index';
import { createAppointment, createClient, createEmployee, createTenant, createTestDb, createTimeOff } from '../testing';
import { markAttendance } from './attendance';
import { bookSeries, cancelFollowing, planSeries, SeriesChangedError, seriesPosition, type SeriesInput } from './series';

let db: Db;
beforeAll(() => {
  db = createTestDb(inject('databaseUrl'));
});
afterAll(async () => {
  await db.$disconnect();
});

const TZ = 'Europe/Madrid';
const madrid = (month: number, day: number, hour = 10, year = 2026) => zonedTimeToUtc({ year, month, day, hour, minute: 0 }, TZ);
const NOW = madrid(11, 1, 9);
const WEEKDAYS_9_14: ScheduleSlot[] = (['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const).map((day) => ({
  day,
  start: '09:00',
  end: '14:00',
}));
const keys = (dates: Date[]) => dates.map((d) => d.toISOString());

async function scenario(schedule: ScheduleSlot[] = WEEKDAYS_9_14) {
  const tenant = await createTenant(db);
  const employee = await createEmployee(db, tenant.id, { schedule });
  const client = await createClient(db, tenant.id);
  const base: SeriesInput = {
    clientId: client.id,
    employeeId: employee.id,
    serviceId: null,
    // Tuesday 3 November 2026, 10:00 — Tuesdays and Thursdays.
    first: madrid(11, 3),
    weekdays: [2, 4],
    intervalWeeks: 1,
    sessions: 6,
    durationMinutes: 60,
    now: NOW,
  };
  return { tenant, employee, client, base };
}

describe('treatments (F26)', () => {
  it('skips the dates that cannot be booked, with their reason, and completes the sessions after', async () => {
    const { tenant, employee, base } = await scenario();
    const other = await createClient(db, tenant.id);
    await createAppointment(db, { tenantId: tenant.id, clientId: other.id, employeeId: employee.id, date: madrid(11, 5) });
    await createTimeOff(db, { tenantId: tenant.id, employeeId: null, startsAt: madrid(11, 10, 0), endsAt: madrid(11, 11, 0) });
    await createTimeOff(db, { tenantId: tenant.id, employeeId: employee.id, startsAt: madrid(11, 12, 0), endsAt: madrid(11, 13, 0) });

    const plan = await planSeries(db, tenant.id, base);
    expect(keys(plan.sessions)).toEqual(keys([madrid(11, 3), madrid(11, 17), madrid(11, 19), madrid(11, 24), madrid(11, 26), madrid(12, 1)]));
    expect(plan.skipped.map((s) => [s.start.toISOString(), s.reason])).toEqual([
      [madrid(11, 5).toISOString(), 'conflict'],
      [madrid(11, 10).toISOString(), 'time_off'],
      [madrid(11, 12).toISOString(), 'time_off'],
    ]);
    expect(plan.complete).toBe(true);

    // Tuesdays and Saturdays every two weeks from Tuesday 27 October (before «now»); Saturdays are
    // outside the schedule and Tuesday 10 November the clinic is closed.
    const biweekly = await planSeries(db, tenant.id, { ...base, first: madrid(10, 27), weekdays: [2, 6], intervalWeeks: 2, sessions: 3 });
    expect(keys(biweekly.sessions)).toEqual(keys([madrid(11, 24), madrid(12, 8), madrid(12, 22)]));
    expect(biweekly.skipped.map((s) => [s.start.toISOString(), s.reason])).toEqual([
      [madrid(10, 27).toISOString(), 'past'],
      [madrid(10, 31).toISOString(), 'past'],
      [madrid(11, 10).toISOString(), 'time_off'],
      [madrid(11, 14).toISOString(), 'outside_schedule'],
      [madrid(11, 28).toISOString(), 'outside_schedule'],
      [madrid(12, 12).toISOString(), 'outside_schedule'],
    ]);
  });

  it('says when it cannot find all the sessions in the weeks it looks at', async () => {
    const { tenant, base } = await scenario([{ day: 'monday', start: '09:00', end: '14:00' }]);
    const plan = await planSeries(db, tenant.id, { ...base, weekdays: [2], sessions: 3 });
    expect(plan.sessions).toEqual([]);
    expect(plan.complete).toBe(false);
    // The sessions asked for plus 8 extra weeks of the pattern.
    expect(plan.skipped).toHaveLength(3 + 8);
    expect(new Set(plan.skipped.map((s) => s.reason))).toEqual(new Set(['outside_schedule']));
  });

  it('books all or nothing, only the dates the user saw', async () => {
    const { tenant, employee, client, base } = await scenario();
    const plan = await planSeries(db, tenant.id, base);
    // Someone books one of those dates in the meantime.
    const other = await createClient(db, tenant.id);
    await createAppointment(db, { tenantId: tenant.id, clientId: other.id, employeeId: employee.id, date: madrid(11, 12) });
    const error = await bookSeries(db, tenant.id, { ...base, expected: plan.sessions, status: 'pending', notes: null }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeriesChangedError);
    expect(await db.appointment.count({ where: { tenantId: tenant.id, clientId: client.id } })).toBe(0);

    const newPlan = (error as SeriesChangedError).plan;
    expect(newPlan.skipped.map((s) => s.reason)).toEqual(['conflict']);
    const booked = await bookSeries(db, tenant.id, { ...base, expected: newPlan.sessions, status: 'confirmed', notes: 'Rodilla' });
    expect(booked.appointments).toHaveLength(6);
    const rows = await db.appointment.findMany({ where: { tenantId: tenant.id, clientId: client.id }, orderBy: { date: 'asc' } });
    expect(new Set(rows.map((r) => r.seriesId))).toEqual(new Set([booked.seriesId]));
    expect(rows.every((r) => r.status === 'confirmed' && r.notes === 'Rodilla' && r.source === 'web')).toBe(true);
    expect(await seriesPosition(db, tenant.id, rows[2]!)).toEqual({ seriesId: booked.seriesId, index: 3, total: 6 });
    expect(await seriesPosition(db, tenant.id, { id: 'x', seriesId: null })).toBeNull();
  });

  it('cancels an appointment and the following ones that were not marked', async () => {
    const { tenant, client, base } = await scenario();
    const plan = await planSeries(db, tenant.id, { ...base, sessions: 4 });
    const { seriesId } = await bookSeries(db, tenant.id, { ...base, sessions: 4, expected: plan.sessions, status: 'pending', notes: null });
    const rows = await db.appointment.findMany({ where: { tenantId: tenant.id, clientId: client.id }, orderBy: { date: 'asc' } });
    // The second one is already marked: it stays.
    expect(await markAttendance(db, tenant.id, rows[1]!.id, 'attended', madrid(12, 31))).toBe('ok');

    expect(await cancelFollowing(db, tenant.id, rows[0]!.id)).toEqual({ seriesId, cancelled: 3 });
    const after = await db.appointment.findMany({ where: { tenantId: tenant.id, clientId: client.id }, orderBy: { date: 'asc' } });
    expect(after.map((a) => a.status)).toEqual(['cancelled', 'pending', 'cancelled', 'cancelled']);
    expect(await seriesPosition(db, tenant.id, after[1]!)).toMatchObject({ index: 1, total: 1 });

    const single = await createAppointment(db, { tenantId: tenant.id, clientId: client.id, employeeId: rows[0]!.employeeId, date: madrid(12, 15) });
    expect(await cancelFollowing(db, tenant.id, single.id)).toBeNull();
  });
});
