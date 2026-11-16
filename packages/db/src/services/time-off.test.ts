/**
 * F14 — services with their own duration and time off (absences, clinic closures) over the DB.
 */
import { localDaysRange, zonedTimeToUtc } from '@clinicai/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createRepos, isForeignKeyViolation, type Db } from '../index';
import {
  createAppointment,
  createClient,
  createEmployee,
  createService,
  createTenant,
  createTestDb,
  createTimeOff,
} from '../testing';
import { checkEmployeeSlot, findNearbySlots, getAvailableEmployees } from './availability';
import { bookAppointment, SlotUnavailableError } from './booking';

const TZ = 'Europe/Madrid';
// 2031-01-06 is a Monday (the default test schedule covers every day).
const at = (d: number, h: number, mi = 0) => zonedTimeToUtc({ year: 2031, month: 1, day: d, hour: h, minute: mi }, TZ);

let db: Db;
beforeAll(() => {
  db = createTestDb(inject('databaseUrl'));
});
afterAll(async () => {
  await db.$disconnect();
});

function dayRange(day: string) {
  const range = localDaysRange(day, day, TZ)!;
  return { startsAt: range.start, endsAt: range.end };
}

async function clinic() {
  const tenant = await createTenant(db);
  const ana = await createEmployee(db, tenant.id, { name: 'Ana' });
  const luis = await createEmployee(db, tenant.id, { name: 'Luis' });
  const client = await createClient(db, tenant.id);
  return { tenant, ana, luis, client };
}

function book(
  tenantId: string,
  input: {
    employeeId: string;
    clientId: string;
    start: Date;
    durationMinutes?: number;
    appointmentId?: string;
    notes?: string;
    serviceId?: string | null;
  },
) {
  return bookAppointment(db, tenantId, { durationMinutes: 60, source: 'web', ...input });
}

describe('time off in availability and booking', () => {
  it('an absence removes only that professional; a closure removes everybody', async () => {
    const c = await clinic();
    await createTimeOff(db, { tenantId: c.tenant.id, employeeId: c.ana.id, startsAt: at(6, 9), endsAt: at(6, 12), reason: 'Médico' });
    expect((await getAvailableEmployees(db, c.tenant.id, at(6, 10), 60, TZ)).map((e) => e.name)).toEqual(['Luis']);
    expect((await getAvailableEmployees(db, c.tenant.id, at(6, 12), 60, TZ)).map((e) => e.name).sort()).toEqual(['Ana', 'Luis']);

    await createTimeOff(db, { tenantId: c.tenant.id, employeeId: null, ...dayRange('2031-01-07'), reason: 'Festivo local' });
    expect(await getAvailableEmployees(db, c.tenant.id, at(7, 10), 60, TZ)).toEqual([]);
    // Nearby slots jump over the closed day.
    const [first] = await findNearbySlots(db, c.tenant.id, { from: at(7, 10), durationMinutes: 60, slotMinutes: 60, timeZone: TZ, limit: 1 });
    expect(first?.getTime()).toBeGreaterThanOrEqual(dayRange('2031-01-08').startsAt.getTime());
  });

  it('bookAppointment refuses time off (no admin override) but still edits an appointment it overlaps', async () => {
    const c = await clinic();
    const appointment = await book(c.tenant.id, { employeeId: c.ana.id, clientId: c.client.id, start: at(6, 10) });
    // The absence is added afterwards over the existing appointment.
    await createTimeOff(db, { tenantId: c.tenant.id, employeeId: c.ana.id, startsAt: at(6, 9), endsAt: at(6, 14), reason: 'Baja' });

    await expect(book(c.tenant.id, { employeeId: c.ana.id, clientId: c.client.id, start: at(6, 12) })).rejects.toMatchObject({
      reason: 'time_off',
    });
    await expect(
      bookAppointment(db, c.tenant.id, {
        employeeId: c.ana.id,
        clientId: c.client.id,
        start: at(6, 12),
        durationMinutes: 60,
        source: 'web',
        allowOutsideSchedule: true,
        allowConflict: true,
      }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);
    // Same placement: notes can still be edited; moving it inside the absence cannot.
    const edited = await book(c.tenant.id, {
      appointmentId: appointment.id,
      employeeId: c.ana.id,
      clientId: c.client.id,
      start: at(6, 10),
      notes: 'Llamar',
    });
    expect(edited.notes).toBe('Llamar');
    await expect(
      book(c.tenant.id, { appointmentId: appointment.id, employeeId: c.ana.id, clientId: c.client.id, start: at(6, 11) }),
    ).rejects.toMatchObject({ reason: 'time_off' });
    // Moving it to Luis works.
    const moved = await book(c.tenant.id, { appointmentId: appointment.id, employeeId: c.luis.id, clientId: c.client.id, start: at(6, 11) });
    expect(moved.employeeId).toBe(c.luis.id);
  });

  it('the web diagnostic reports the time off', async () => {
    const c = await clinic();
    await createTimeOff(db, { tenantId: c.tenant.id, employeeId: null, ...dayRange('2031-01-06'), reason: 'Reyes' });
    const check = await checkEmployeeSlot(db, c.tenant.id, { employeeId: c.ana.id, start: at(6, 10), durationMinutes: 60, timeZone: TZ });
    expect(check.timeOff).toMatchObject({ clinicWide: true, reason: 'Reyes' });
    const free = await checkEmployeeSlot(db, c.tenant.id, { employeeId: c.ana.id, start: at(8, 10), durationMinutes: 60, timeZone: TZ });
    expect(free.timeOff).toBeNull();
  });
});

describe('time off repository', () => {
  it('lists, warns about overlapping appointments, deletes and is tenant-scoped', async () => {
    const c = await clinic();
    const repos = createRepos(db);
    await createAppointment(db, { tenantId: c.tenant.id, clientId: c.client.id, employeeId: c.ana.id, date: at(13, 10) });
    const input = { employeeId: c.ana.id, ...dayRange('2031-01-13') };
    expect((await repos.timeOff.overlappingAppointments(c.tenant.id, input)).map((a) => a.employee.name)).toEqual(['Ana']);
    expect(await repos.timeOff.overlappingAppointments(c.tenant.id, { ...input, employeeId: c.luis.id })).toEqual([]);
    const created = await repos.timeOff.create(c.tenant.id, { ...input, reason: 'Vacaciones' });
    expect(created.employee?.name).toBe('Ana');
    expect((await repos.timeOff.listUpcoming(c.tenant.id, c.ana.id, at(1, 0))).map((t) => t.reason)).toEqual(['Vacaciones']);
    expect(await repos.timeOff.listUpcoming(c.tenant.id, null, at(1, 0))).toEqual([]);

    const other = await createTenant(db);
    expect(await repos.timeOff.delete(other.id, created.id)).toBe(false);
    expect(await repos.timeOff.listOverlapping(other.id, at(1, 0), at(31, 0))).toEqual([]);
    // The composite FK refuses an absence for an employee of another tenant.
    const error = await repos.timeOff.create(other.id, input).catch((e: unknown) => e);
    expect(isForeignKeyViolation(error)).toBe(true);
    expect(await repos.timeOff.delete(c.tenant.id, created.id)).toBe(true);
  });

  it('the database rejects an empty or inverted range', async () => {
    const c = await clinic();
    await expect(createTimeOff(db, { tenantId: c.tenant.id, employeeId: null, startsAt: at(6, 10), endsAt: at(6, 10) })).rejects.toThrow();
  });
});

describe('services', () => {
  it('appointments keep their service; a used service cannot be deleted; tenant-scoped', async () => {
    const c = await clinic();
    const repos = createRepos(db);
    const puncion = await createService(db, c.tenant.id, { name: 'Punción seca', durationMinutes: 30 });
    const unused = await createService(db, c.tenant.id, { name: 'Sin usar' });
    const appointment = await book(c.tenant.id, {
      employeeId: c.ana.id,
      clientId: c.client.id,
      start: at(6, 10),
      durationMinutes: 30,
      serviceId: puncion.id,
    });
    expect(appointment.service).toEqual({ id: puncion.id, name: 'Punción seca' });
    // Updating without serviceId keeps it.
    const moved = await book(c.tenant.id, {
      appointmentId: appointment.id,
      employeeId: c.ana.id,
      clientId: c.client.id,
      start: at(6, 11),
      durationMinutes: 30,
    });
    expect(moved.serviceId).toBe(puncion.id);

    expect(await repos.services.delete(c.tenant.id, puncion.id)).toBe('in_use');
    expect((await repos.services.update(c.tenant.id, puncion.id, { active: false })).active).toBe(false);
    expect((await repos.services.list(c.tenant.id, { activeOnly: true })).map((s) => s.name)).toEqual(['Sin usar']);
    expect((await repos.services.listWithUsage(c.tenant.id)).find((s) => s.id === puncion.id)?._count.appointments).toBe(1);

    const other = await clinic();
    await expect(
      book(other.tenant.id, { employeeId: other.ana.id, clientId: other.client.id, start: at(6, 10), serviceId: unused.id }),
    ).rejects.toMatchObject({ reason: 'service_not_found' });
    expect(await repos.services.delete(other.tenant.id, unused.id)).toBe('not_found');
    expect(await repos.services.delete(c.tenant.id, unused.id)).toBe('deleted');
    // Names are unique per clinic, not globally.
    await expect(createService(db, c.tenant.id, { name: 'Punción seca' })).rejects.toThrow();
    await createService(db, other.tenant.id, { name: 'Punción seca' });
  });
});
