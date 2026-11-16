import { zonedTimeToUtc, formatShortSlot } from '@clinicai/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createRepos, type Db } from '../index';
import {
  createAppointment,
  createClient,
  createEmployee,
  createTenant,
  createTestDb,
} from '../testing';
import { checkEmployeeSlot, findNearbySlots, getAvailableEmployees } from './availability';
import { bookAppointment, SlotUnavailableError } from './booking';
import { claimDueReminders } from './reminders';

const TZ = 'Europe/Madrid';
const at = (y: number, m: number, d: number, h: number, mi = 0): Date =>
  zonedTimeToUtc({ year: y, month: m, day: d, hour: h, minute: mi }, TZ);

let db: Db;

beforeAll(() => {
  db = createTestDb(inject('databaseUrl'));
});

afterAll(async () => {
  await db.$disconnect();
});

describe('getAvailableEmployees', () => {
  it('applies schedule, active flag and overlapping appointments', async () => {
    const tenant = await createTenant(db);
    const monday = [{ day: 'monday' as const, start: '09:00', end: '14:00' }];
    const ana = await createEmployee(db, tenant.id, { name: 'Ana', schedule: monday });
    const luis = await createEmployee(db, tenant.id, { name: 'Luis', schedule: monday });
    await createEmployee(db, tenant.id, { name: 'Inactivo', schedule: monday, active: false });
    await createEmployee(db, tenant.id, { name: 'Sin horario', schedule: [] });
    const client = await createClient(db, tenant.id);
    // 2025-05-05 is a Monday.
    await createAppointment(db, { tenantId: tenant.id, clientId: client.id, employeeId: ana.id, date: at(2025, 5, 5, 10) });
    await createAppointment(db, {
      tenantId: tenant.id,
      clientId: client.id,
      employeeId: luis.id,
      date: at(2025, 5, 5, 10),
      status: 'cancelled',
    });

    const at10 = await getAvailableEmployees(db, tenant.id, at(2025, 5, 5, 10), 60);
    expect(at10.map((e) => e.name)).toEqual(['Luis']);
    const at11 = await getAvailableEmployees(db, tenant.id, at(2025, 5, 5, 11), 60);
    expect(at11.map((e) => e.name).sort()).toEqual(['Ana', 'Luis']);
    const tuesday = await getAvailableEmployees(db, tenant.id, at(2025, 5, 6, 11), 60);
    expect(tuesday).toEqual([]);
  });

  it('never returns employees of another tenant', async () => {
    const t1 = await createTenant(db);
    const t2 = await createTenant(db);
    await createEmployee(db, t2.id, { name: 'Ajeno' });
    expect(await getAvailableEmployees(db, t1.id, at(2025, 5, 5, 10), 60)).toEqual([]);
  });
});

describe('findNearbySlots', () => {
  it('suggests up to 3 nearby free slots', async () => {
    const tenant = await createTenant(db);
    const emp = await createEmployee(db, tenant.id, {
      schedule: [{ day: 'monday', start: '09:00', end: '12:00' }],
    });
    const client = await createClient(db, tenant.id);
    await createAppointment(db, { tenantId: tenant.id, clientId: client.id, employeeId: emp.id, date: at(2025, 5, 5, 9) });
    const slots = await findNearbySlots(db, tenant.id, {
      from: at(2025, 5, 5, 9),
      durationMinutes: 60,
      slotMinutes: 60,
    });
    expect(slots.map((s) => formatShortSlot(s, TZ))).toEqual([
      'lun 5 may, 10:00',
      'lun 5 may, 11:00',
      'lun 12 may, 09:00',
    ]);
  });
});

describe('bookAppointment', () => {
  it('creates a pending appointment when the slot is free', async () => {
    const tenant = await createTenant(db);
    const emp = await createEmployee(db, tenant.id);
    const client = await createClient(db, tenant.id);
    const appt = await bookAppointment(db, tenant.id, {
      clientId: client.id,
      employeeId: emp.id,
      start: at(2030, 1, 7, 10),
      durationMinutes: 60,
      source: 'whatsapp',
    });
    expect(appt.status).toBe('pending');
    expect(appt.source).toBe('whatsapp');
    expect(appt.employee.name).toBe('Empleado Test');
  });

  it('prevents double booking under concurrency', async () => {
    const tenant = await createTenant(db);
    const emp = await createEmployee(db, tenant.id);
    const c1 = await createClient(db, tenant.id);
    const c2 = await createClient(db, tenant.id);
    const start = at(2030, 1, 8, 10);
    const results = await Promise.allSettled(
      [c1, c2, c1, c2].map((c) =>
        bookAppointment(db, tenant.id, { clientId: c.id, employeeId: emp.id, start, durationMinutes: 60, source: 'whatsapp' }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(3);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(SlotUnavailableError);
      expect((r.reason as SlotUnavailableError).reason).toBe('conflict');
    }
  });

  it('rejects slots outside the schedule unless the admin forces it', async () => {
    const tenant = await createTenant(db);
    const emp = await createEmployee(db, tenant.id, { schedule: [{ day: 'monday', start: '09:00', end: '12:00' }] });
    const client = await createClient(db, tenant.id);
    const input = { clientId: client.id, employeeId: emp.id, start: at(2030, 1, 7, 18), durationMinutes: 60, source: 'web' as const };
    await expect(bookAppointment(db, tenant.id, input)).rejects.toMatchObject({ reason: 'outside_schedule' });
    const forced = await bookAppointment(db, tenant.id, { ...input, allowOutsideSchedule: true });
    expect(forced.id).toBeTruthy();
  });

  it('cannot book with a client or employee of another tenant', async () => {
    const t1 = await createTenant(db);
    const t2 = await createTenant(db);
    const emp1 = await createEmployee(db, t1.id);
    const client2 = await createClient(db, t2.id);
    const emp2 = await createEmployee(db, t2.id);
    const client1 = await createClient(db, t1.id);
    await expect(
      bookAppointment(db, t1.id, { clientId: client2.id, employeeId: emp1.id, start: at(2030, 1, 7, 10), durationMinutes: 60, source: 'web' }),
    ).rejects.toMatchObject({ reason: 'client_not_found' });
    await expect(
      bookAppointment(db, t1.id, { clientId: client1.id, employeeId: emp2.id, start: at(2030, 1, 7, 10), durationMinutes: 60, source: 'web' }),
    ).rejects.toMatchObject({ reason: 'employee_not_found' });
  });

  it('the database itself rejects cross-tenant links (composite FKs)', async () => {
    const t1 = await createTenant(db);
    const t2 = await createTenant(db);
    const emp1 = await createEmployee(db, t1.id);
    const client2 = await createClient(db, t2.id);
    await expect(
      createAppointment(db, { tenantId: t1.id, clientId: client2.id, employeeId: emp1.id, date: at(2030, 1, 7, 10) }),
    ).rejects.toThrow();
  });

  it('updates an appointment ignoring its own slot and resets the reminder on date change', async () => {
    const tenant = await createTenant(db);
    const emp = await createEmployee(db, tenant.id);
    const client = await createClient(db, tenant.id);
    const original = await createAppointment(db, {
      tenantId: tenant.id,
      clientId: client.id,
      employeeId: emp.id,
      date: at(2030, 1, 7, 10),
      reminderSentAt: new Date(),
    });
    const sameSlot = await bookAppointment(db, tenant.id, {
      appointmentId: original.id,
      clientId: client.id,
      employeeId: emp.id,
      start: at(2030, 1, 7, 10),
      durationMinutes: 60,
      status: 'confirmed',
      source: 'web',
    });
    expect(sameSlot.status).toBe('confirmed');
    expect(sameSlot.reminderSentAt).not.toBeNull();
    const moved = await bookAppointment(db, tenant.id, {
      appointmentId: original.id,
      clientId: client.id,
      employeeId: emp.id,
      start: at(2030, 1, 7, 12),
      durationMinutes: 60,
      source: 'web',
    });
    expect(moved.reminderSentAt).toBeNull();
  });
});

describe('checkEmployeeSlot', () => {
  it('reports schedule and conflict separately', async () => {
    const tenant = await createTenant(db);
    const emp = await createEmployee(db, tenant.id, { schedule: [{ day: 'monday', start: '09:00', end: '12:00' }] });
    const client = await createClient(db, tenant.id);
    const appt = await createAppointment(db, { tenantId: tenant.id, clientId: client.id, employeeId: emp.id, date: at(2030, 1, 7, 9) });
    expect(await checkEmployeeSlot(db, tenant.id, { employeeId: emp.id, start: at(2030, 1, 7, 9), durationMinutes: 60 })).toEqual({
      exists: true,
      active: true,
      withinSchedule: true,
      conflict: true,
      timeOff: null,
    });
    expect(
      await checkEmployeeSlot(db, tenant.id, { employeeId: emp.id, start: at(2030, 1, 7, 9), durationMinutes: 60, ignoreAppointmentId: appt.id }),
    ).toMatchObject({ conflict: false });
    expect(await checkEmployeeSlot(db, tenant.id, { employeeId: emp.id, start: at(2030, 1, 7, 15), durationMinutes: 60 })).toMatchObject({
      withinSchedule: false,
    });
  });
});

describe('claimDueReminders', () => {
  it('claims only pending appointments in range, once', async () => {
    const tenant = await createTenant(db);
    const emp = await createEmployee(db, tenant.id);
    const client = await createClient(db, tenant.id);
    const range = { start: at(2030, 2, 5, 0), end: at(2030, 2, 6, 0) };
    const due = await createAppointment(db, { tenantId: tenant.id, clientId: client.id, employeeId: emp.id, date: at(2030, 2, 5, 10) });
    await createAppointment(db, { tenantId: tenant.id, clientId: client.id, employeeId: emp.id, date: at(2030, 2, 5, 12), status: 'confirmed' });
    await createAppointment(db, { tenantId: tenant.id, clientId: client.id, employeeId: emp.id, date: at(2030, 2, 5, 13), status: 'cancelled' });
    await createAppointment(db, { tenantId: tenant.id, clientId: client.id, employeeId: emp.id, date: at(2030, 2, 6, 10) });
    const now = at(2030, 2, 4, 8);

    const [first, second] = await Promise.all([
      claimDueReminders(db, tenant.id, range, now),
      claimDueReminders(db, tenant.id, range, now),
    ]);
    const claimed = [...first, ...second];
    expect(claimed.map((a) => a.id)).toEqual([due.id]);
    expect(await claimDueReminders(db, tenant.id, range, now)).toEqual([]);
  });
});

describe('repositories are tenant-scoped', () => {
  it('cannot read, update or delete data of another tenant', async () => {
    const repos = createRepos(db);
    const t1 = await createTenant(db);
    const t2 = await createTenant(db);
    const client1 = await createClient(db, t1.id, { name: 'Cliente T1' });
    const emp1 = await createEmployee(db, t1.id);
    const appt1 = await createAppointment(db, { tenantId: t1.id, clientId: client1.id, employeeId: emp1.id, date: at(2030, 1, 7, 10) });

    expect(await repos.clients.findById(t2.id, client1.id)).toBeNull();
    expect(await repos.clients.list(t2.id)).toEqual([]);
    expect(await repos.employees.findById(t2.id, emp1.id)).toBeNull();
    expect(await repos.appointments.findById(t2.id, appt1.id)).toBeNull();
    await expect(repos.clients.update(t2.id, client1.id, { name: 'hack' })).rejects.toThrow();
    await expect(repos.employees.delete(t2.id, emp1.id)).rejects.toThrow();
    expect(await repos.appointments.delete(t2.id, appt1.id)).toBe(false);
    expect(await repos.appointments.setStatus(t2.id, appt1.id, 'cancelled')).toBe(false);
    expect((await repos.clients.findById(t1.id, client1.id))?.name).toBe('Cliente T1');
    expect((await repos.appointments.findById(t1.id, appt1.id))?.status).toBe('pending');
  });

  it('keeps conversation state, blacklist and idempotency per tenant', async () => {
    const repos = createRepos(db);
    const t1 = await createTenant(db);
    const t2 = await createTenant(db);
    const phone = '+34600000001';
    const now = new Date('2030-01-01T10:00:00Z');
    await repos.conversations.save(t1.id, phone, { flow: 'cita', step: 'askDate', data: { a: 1 }, errorCount: 1 }, now);
    expect(await repos.conversations.get(t1.id, phone, now)).toMatchObject({ flow: 'cita', data: { a: 1 } });
    expect(await repos.conversations.get(t2.id, phone, now)).toBeNull();
    // Expires after 30 minutes.
    expect(await repos.conversations.get(t1.id, phone, new Date(now.getTime() + 31 * 60_000))).toBeNull();

    expect(await repos.blacklist.add(t1.id, phone, 'agent')).toBe(true);
    expect(await repos.blacklist.add(t1.id, phone, 'agent')).toBe(false);
    expect(await repos.blacklist.isBlocked(t1.id, phone)).toBe(true);
    expect(await repos.blacklist.isBlocked(t2.id, phone)).toBe(false);
    expect(await repos.blacklist.remove(t1.id, phone)).toBe(true);
  });

  it('merges tenant settings and creates tenants with an owner', async () => {
    const repos = createRepos(db);
    const tenant = await repos.tenants.createWithOwner({
      clinicName: 'Nueva',
      contactPhone: '600 000 000',
      kindeUserId: `kp_${Date.now()}`,
      email: 'owner@test.es',
    });
    expect(tenant.settings.contactPhone).toBe('600 000 000');
    const updated = await repos.tenants.update(tenant.id, { settings: { slotMinutes: 30 } });
    expect(updated.settings).toMatchObject({ slotMinutes: 30, contactPhone: '600 000 000' });
    const members = await repos.members.listByTenant(tenant.id);
    expect(members).toHaveLength(1);
    expect(members[0]?.role).toBe('owner');
  });
});
