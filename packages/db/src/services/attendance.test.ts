/**
 * F15 — attendance of past appointments and period metrics.
 */
import { localDaysRange, zonedTimeToUtc } from '@clinicai/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Db } from '../index';
import { createAppointment, createClient, createEmployee, createService, createTenant, createTestDb, createTimeOff } from '../testing';
import { getMetrics, listUnmarked, markAttendance } from './attendance';
import { bookAppointment } from './booking';

const TZ = 'Europe/Madrid';
// March 2031: Monday 3, 10, 17, 24 and 31.
const at = (d: number, h: number, mi = 0) => zonedTimeToUtc({ year: 2031, month: 3, day: d, hour: h, minute: mi }, TZ);
const NOW = at(15, 12);
const MONDAY_9_13 = [{ day: 'monday' as const, start: '09:00', end: '13:00' }];

let db: Db;
beforeAll(() => {
  db = createTestDb(inject('databaseUrl'));
});
afterAll(async () => {
  await db.$disconnect();
});

async function clinic() {
  const tenant = await createTenant(db);
  const ana = await createEmployee(db, tenant.id, { name: 'Ana', schedule: MONDAY_9_13 });
  const luis = await createEmployee(db, tenant.id, { name: 'Luis', schedule: MONDAY_9_13 });
  const client = await createClient(db, tenant.id);
  const appt = (date: Date, extra: { employeeId?: string; status?: 'pending' | 'confirmed' | 'cancelled'; source?: 'whatsapp' | 'web'; serviceId?: string; durationMinutes?: number } = {}) =>
    createAppointment(db, { tenantId: tenant.id, clientId: client.id, employeeId: extra.employeeId ?? ana.id, date, ...extra });
  return { tenant, ana, luis, client, appt };
}

describe('markAttendance', () => {
  it('only for started, non-cancelled appointments of the tenant; can be cleared', async () => {
    const c = await clinic();
    const past = await c.appt(at(10, 9));
    const future = await c.appt(at(17, 9));
    const cancelled = await c.appt(at(3, 9), { status: 'cancelled' });

    expect(await markAttendance(db, c.tenant.id, past.id, 'no_show', NOW)).toBe('ok');
    expect(await db.appointment.findUniqueOrThrow({ where: { id: past.id } })).toMatchObject({ attendance: 'no_show', attendanceMarkedAt: NOW });
    expect(await markAttendance(db, c.tenant.id, future.id, 'attended', NOW)).toBe('not_started');
    expect(await markAttendance(db, c.tenant.id, cancelled.id, 'attended', NOW)).toBe('cancelled');
    const other = await createTenant(db);
    expect(await markAttendance(db, other.id, past.id, 'attended', NOW)).toBe('not_found');
    expect(await markAttendance(db, c.tenant.id, past.id, null, NOW)).toBe('ok');
    expect(await db.appointment.findUniqueOrThrow({ where: { id: past.id } })).toMatchObject({ attendance: null, attendanceMarkedAt: null });
  });

  it('lists the past appointments still to be marked', async () => {
    const c = await clinic();
    const unmarked = await c.appt(at(10, 9));
    const marked = await c.appt(at(10, 10));
    await markAttendance(db, c.tenant.id, marked.id, 'attended', NOW);
    await c.appt(at(10, 11), { status: 'cancelled' });
    await c.appt(at(17, 9));
    await c.appt(at(1, 9)); // before `since`
    expect((await listUnmarked(db, c.tenant.id, at(3, 0), NOW)).map((a) => a.id)).toEqual([unmarked.id]);
  });

  it('cancelling or moving an appointment clears its attendance', async () => {
    const c = await clinic();
    const appt = await c.appt(at(10, 9));
    await markAttendance(db, c.tenant.id, appt.id, 'attended', NOW);
    const base = { appointmentId: appt.id, clientId: c.client.id, employeeId: c.ana.id, durationMinutes: 60, source: 'web' as const };
    // Editing notes keeps it.
    await bookAppointment(db, c.tenant.id, { ...base, start: at(10, 9), notes: 'Ok', status: 'pending' });
    expect((await db.appointment.findUniqueOrThrow({ where: { id: appt.id } })).attendance).toBe('attended');
    await bookAppointment(db, c.tenant.id, { ...base, start: at(10, 10), status: 'pending' });
    expect((await db.appointment.findUniqueOrThrow({ where: { id: appt.id } })).attendance).toBeNull();
    await markAttendance(db, c.tenant.id, appt.id, 'no_show', NOW);
    await bookAppointment(db, c.tenant.id, { ...base, start: at(10, 10), status: 'cancelled' });
    expect((await db.appointment.findUniqueOrThrow({ where: { id: appt.id } })).attendance).toBeNull();
  });
});

describe('getMetrics', () => {
  it('counts attendance, cancellations, channels, services and occupancy (minus time off)', async () => {
    const c = await clinic();
    const puncion = await createService(db, c.tenant.id, { name: 'Punción seca', durationMinutes: 30 });
    const a1 = await c.appt(at(3, 9), { source: 'whatsapp', serviceId: puncion.id, durationMinutes: 30 });
    const a2 = await c.appt(at(3, 10), { source: 'whatsapp' });
    const a3 = await c.appt(at(10, 9), { employeeId: c.luis.id });
    await c.appt(at(10, 10), { employeeId: c.luis.id }); // past, unmarked
    await c.appt(at(10, 11), { status: 'cancelled' });
    await c.appt(at(17, 9)); // future
    await c.appt(at(2, 9), { employeeId: c.luis.id }); // Sunday 2 March: in range, outside schedule but counted
    await c.appt(at(28, 23, 30)); // last days of February would be outside: this is 28 March
    await markAttendance(db, c.tenant.id, a1.id, 'attended', NOW);
    await markAttendance(db, c.tenant.id, a2.id, 'no_show', NOW);
    await markAttendance(db, c.tenant.id, a3.id, 'attended', NOW);
    // Ana is absent on Monday 24; the clinic closes on Monday 31.
    await createTimeOff(db, { tenantId: c.tenant.id, employeeId: c.ana.id, startsAt: at(24, 0), endsAt: at(25, 0) });
    const closure = localDaysRange('2031-03-31', '2031-03-31', TZ)!;
    await createTimeOff(db, { tenantId: c.tenant.id, employeeId: null, startsAt: closure.start, endsAt: closure.end });

    const month = localDaysRange('2031-03-01', '2031-03-31', TZ)!;
    const m = await getMetrics(db, c.tenant.id, { from: month.start, to: month.end, timeZone: TZ, now: NOW });
    expect(m).toMatchObject({
      total: 8,
      cancelled: 1,
      active: 7,
      past: 5,
      future: 2,
      attended: 2,
      noShow: 1,
      unmarked: 2,
      channels: { whatsapp: 2, web: 5 },
    });
    expect(m.noShowRate).toBeCloseTo(1 / 3);
    expect(m.cancellationRate).toBeCloseTo(1 / 8);
    expect(m.services).toEqual([
      { id: null, name: 'Sin servicio', appointments: 6 },
      { id: puncion.id, name: 'Punción seca', appointments: 1 },
    ]);
    // Mondays in March 2031: 3, 10, 17, 24, 31 → 5 × 240 min; Ana loses the 24th and both the 31st.
    const ana = m.employees.find((e) => e.name === 'Ana')!;
    const luis = m.employees.find((e) => e.name === 'Luis')!;
    expect(ana).toMatchObject({ appointments: 4, bookedMinutes: 30 + 60 + 60 + 60, scheduledMinutes: 3 * 240, attended: 1, noShow: 1 });
    expect(luis).toMatchObject({ appointments: 3, bookedMinutes: 180, scheduledMinutes: 4 * 240, attended: 1 });
    expect(ana.occupancy).toBeCloseTo(210 / 720);

    // Tenant-scoped.
    const other = await createTenant(db);
    expect(await getMetrics(db, other.id, { from: month.start, to: month.end, timeZone: TZ, now: NOW })).toMatchObject({
      total: 0,
      noShowRate: null,
      cancellationRate: null,
      employees: [],
    });
  });
});
