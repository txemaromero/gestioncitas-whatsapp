import { randomUUID } from 'node:crypto';
import { recordUsage } from '@clinicai/db';
import { PRIVACY_NOTICE_VERSION, serviceRefCode, zonedTimeToUtc } from '@clinicai/shared';
import { describe, expect, it, vi } from 'vitest';
import { loadBookingPage } from '../src/server/booking-page';
import { calendarFeedResponse } from '../src/server/calendar-feed';
import { isPlatformAdmin, loadPlatformConsole, platformMonth } from '../src/server/platform';
import { verifyWhatsAppNumber } from '../src/server/whatsapp-number';
import { callerFor, getTestAppDb, getTestDb, newOwner } from './helpers';

const TZ = 'Europe/Madrid';
// 2031-01-06 is a Monday.
const at = (d: number, h: number, mi = 0) => zonedTimeToUtc({ year: 2031, month: 1, day: d, hour: h, minute: mi }, TZ);
const MON_9_14 = [{ day: 'monday' as const, start: '09:00', end: '14:00' }];

describe('authentication and tenancy', () => {
  it('rejects anonymous users and users without a clinic', async () => {
    const anonymous = await callerFor(null);
    await expect(anonymous.clients.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const orphan = await callerFor({ id: `kp_${randomUUID()}` });
    await expect(orphan.clients.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(orphan.tenant.get()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('onboarding creates the clinic and the owner membership, only once', async () => {
    const { user, tenant, caller } = await newOwner('Fisio Onboarding');
    expect(tenant).toMatchObject({ clinicName: 'Fisio Onboarding', contactPhone: '965 000 000', slotMinutes: 60 });
    expect((await caller.tenant.get()).id).toBe(tenant.id);
    const again = await callerFor(user);
    await expect(again.tenant.onboarding({ clinicName: 'Otra', contactPhone: '600000000' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const member = await getTestDb().tenantMember.findUnique({ where: { kindeUserId: user.id } });
    expect(member).toMatchObject({ tenantId: tenant.id, role: 'owner' });
  });
});

describe('tenant router (RF-A4)', () => {
  it('updates name and settings', async () => {
    const { caller } = await newOwner();
    const updated = await caller.tenant.update({
      clinicName: 'Nuevo Nombre',
      contactPhone: '965 000 000',
      slotMinutes: 30,
      reminderHour: '09:00',
    });
    expect(updated).toMatchObject({ clinicName: 'Nuevo Nombre', slotMinutes: 30, contactPhone: '965 000 000', minNoticeHours: 24 });
    // F13: notice period for cancelling/changing by WhatsApp (only listed options).
    const withNotice = await caller.tenant.update({
      clinicName: 'Nuevo Nombre',
      contactPhone: '965 000 000',
      slotMinutes: 30,
      reminderHour: '09:00',
      minNoticeHours: 48,
    });
    expect(withNotice).toMatchObject({ minNoticeHours: 48, slotMinutes: 30 });
    await expect(
      caller.tenant.update({ clinicName: 'Nuevo Nombre', contactPhone: '', slotMinutes: 30, reminderHour: '09:00', minNoticeHours: 5 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.tenant.update({ clinicName: 'X', contactPhone: '', slotMinutes: 33, reminderHour: '09:00' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('stores the uploaded FAQ prompt (≤ 20 KB) and restores the default', async () => {
    const { caller } = await newOwner('Fisio FAQ');
    const initial = await caller.tenant.getFaqPrompt();
    expect(initial.isDefault).toBe(true);
    expect(initial.content).toContain('recepcionista virtual de Fisio FAQ');
    await caller.tenant.uploadFaqPrompt({ content: 'Eres la recepcionista de Fisio FAQ.\r\nHorario: 9-14' });
    expect(await caller.tenant.getFaqPrompt()).toEqual({ content: 'Eres la recepcionista de Fisio FAQ.\nHorario: 9-14', isDefault: false });
    await expect(caller.tenant.uploadFaqPrompt({ content: 'x'.repeat(21 * 1024) })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.tenant.uploadFaqPrompt({ content: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await caller.tenant.uploadFaqPrompt({ content: null });
    expect((await caller.tenant.getFaqPrompt()).isDefault).toBe(true);
  });

  it('encrypts the WhatsApp token and only returns it masked', async () => {
    const { caller, tenant } = await newOwner();
    const view = await caller.tenant.updateWhatsApp({
      waPhoneNumberId: `pnid-${randomUUID()}`,
      phoneNormalized: '965 000 000',
      waAccessToken: 'EAAG-super-secret-token-1234',
    });
    expect(view.waTokenMasked).toBe('EAAG••••••1234');
    expect(view.phoneNormalized).toBe('+34965000000');
    const row = await getTestDb().tenantConfig.findUnique({ where: { id: tenant.id } });
    expect(row?.waAccessTokenEnc).toMatch(/^v1\./);
    expect(row?.waAccessTokenEnc).not.toContain('super-secret');
  });
});

describe('employees router (RF-A3)', () => {
  it('creates, searches, updates and validates schedules', async () => {
    const { caller } = await newOwner();
    const ana = await caller.employees.create({ name: 'Ana Ruiz', role: 'fisioterapeuta', schedule: MON_9_14 });
    await caller.employees.create({ name: 'Óscar', role: 'admin', schedule: [] });
    expect((await caller.employees.list({ search: 'ruiz' })).map((e) => e.name)).toEqual(['Ana Ruiz']);
    const updated = await caller.employees.update({
      id: ana.id,
      name: 'Ana Ruiz',
      role: 'osteópata',
      schedule: [...MON_9_14, { day: 'monday', start: '16:00', end: '20:00' }],
    });
    expect(updated.schedule).toHaveLength(2);
    await expect(
      caller.employees.create({
        name: 'Solapado',
        role: 'fisioterapeuta',
        schedule: [
          { day: 'monday', start: '09:00', end: '12:00' },
          { day: 'monday', start: '11:00', end: '13:00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.employees.create({ name: 'Al revés', role: 'fisioterapeuta', schedule: [{ day: 'monday', start: '14:00', end: '09:00' }] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('requires confirmation to delete an employee with future appointments (or deactivates it)', async () => {
    const { caller } = await newOwner();
    const emp = await caller.employees.create({ name: 'Luis', role: 'fisioterapeuta', schedule: MON_9_14 });
    const client = await caller.clients.create({ name: 'Paciente', phone: '611 222 333' });
    await caller.appointments.create({ clientId: client.id, employeeId: emp.id, start: at(6, 10), status: 'pending' });
    expect(await caller.employees.futureAppointments({ id: emp.id })).toBe(1);
    await expect(caller.employees.delete({ id: emp.id })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await caller.employees.setActive({ id: emp.id, active: false })).active).toBe(false);
    await caller.employees.delete({ id: emp.id, force: true });
    expect(await caller.employees.list()).toEqual([]);
  });
});

describe('clients router (RF-A3)', () => {
  it('normalizes phones to E.164 and rejects duplicates in the same clinic', async () => {
    const { caller } = await newOwner();
    const client = await caller.clients.create({ name: 'Laura', email: 'Laura@Mail.com', phone: '611 111 111', notes: '' });
    expect(client).toMatchObject({ phone: '+34611111111', email: 'laura@mail.com', notes: null });
    await expect(caller.clients.create({ name: 'Otra', phone: '+34 611-111-111' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(caller.clients.create({ name: 'Mal', phone: '12' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.clients.create({ name: 'Mal', email: 'nope' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const noPhone = await caller.clients.create({ name: 'Sin Teléfono' });
    expect(noPhone.phone).toBeNull();
    expect((await caller.clients.list({ search: 'laura' })).map((c) => c.name)).toEqual(['Laura']);
  });

  it('returns past and future appointments in the detail and deletes', async () => {
    const { caller } = await newOwner();
    const emp = await caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const client = await caller.clients.create({ name: 'Pedro', phone: '622 333 444' });
    await caller.appointments.create({ clientId: client.id, employeeId: emp.id, start: at(6, 9), status: 'confirmed' });
    await caller.appointments.create({ clientId: client.id, employeeId: emp.id, start: at(13, 9), status: 'pending' });
    const detail = await caller.clients.get({ id: client.id });
    expect(detail.appointments).toHaveLength(2);
    expect(detail.appointments[0]?.employee.name).toBe('Ana');
    expect(await caller.clients.futureAppointments({ id: client.id })).toBe(2);
    await caller.clients.delete({ id: client.id });
    await expect(caller.clients.get({ id: client.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('appointments router (RF-A2)', () => {
  it('creates, lists by range, updates and deletes', async () => {
    const { caller } = await newOwner();
    const emp = await caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const client = await caller.clients.create({ name: 'Laura', phone: '611 999 888' });
    const appt = await caller.appointments.create({
      clientId: client.id,
      employeeId: emp.id,
      start: at(6, 10),
      status: 'pending',
      notes: 'Primera visita',
    });
    expect(appt).toMatchObject({ source: 'web', durationMinutes: 60, notes: 'Primera visita' });
    const listed = await caller.appointments.list({ from: at(6, 0), to: at(7, 0) });
    expect(listed.map((a) => a.id)).toEqual([appt.id]);
    expect(listed[0]?.client.name).toBe('Laura');
    const moved = await caller.appointments.update({ id: appt.id, clientId: client.id, employeeId: emp.id, start: at(6, 12), status: 'confirmed' });
    expect(moved.status).toBe('confirmed');
    expect(moved.date.toISOString()).toBe(at(6, 12).toISOString());
    await caller.appointments.delete({ id: appt.id });
    expect(await caller.appointments.list({ from: at(6, 0), to: at(7, 0) })).toEqual([]);
  });

  it('applies the shared availability rule (conflicts, schedule, admin override)', async () => {
    const { caller } = await newOwner();
    const emp = await caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const client = await caller.clients.create({ name: 'Laura', phone: '611 777 666' });
    await caller.appointments.create({ clientId: client.id, employeeId: emp.id, start: at(6, 10), status: 'pending' });
    await expect(
      caller.appointments.create({ clientId: client.id, employeeId: emp.id, start: at(6, 10, 30), status: 'pending' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      caller.appointments.create({ clientId: client.id, employeeId: emp.id, start: at(6, 18), status: 'pending' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'La cita queda fuera del horario del empleado' });
    const forced = await caller.appointments.create({ clientId: client.id, employeeId: emp.id, start: at(6, 18), status: 'pending', force: true });
    expect(forced.id).toBeTruthy();

    const availability = await caller.appointments.checkAvailability({ start: at(6, 10), employeeId: emp.id });
    expect(availability).toMatchObject({ availableEmployeeIds: [], check: { withinSchedule: true, conflict: true }, durationMinutes: 60 });
    const free = await caller.appointments.checkAvailability({ start: at(6, 11) });
    expect(free.availableEmployeeIds).toEqual([emp.id]);
  });
});

describe('tenant isolation (web)', () => {
  it('a user of tenant 2 cannot read or modify data of tenant 1', async () => {
    const t1 = await newOwner('Clínica Uno');
    const t2 = await newOwner('Clínica Dos');
    const emp = await t1.caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const client = await t1.caller.clients.create({ name: 'Laura', phone: '633 000 111' });
    const appt = await t1.caller.appointments.create({ clientId: client.id, employeeId: emp.id, start: at(6, 10), status: 'pending' });

    // Read
    expect(await t2.caller.clients.list()).toEqual([]);
    expect(await t2.caller.employees.list()).toEqual([]);
    expect(await t2.caller.appointments.list({ from: at(1, 0), to: at(31, 0) })).toEqual([]);
    expect(await t2.caller.appointments.upcoming()).toEqual([]);
    await expect(t2.caller.clients.get({ id: client.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await t2.caller.tenant.get()).clinicName).toBe('Clínica Dos');
    expect((await t2.caller.appointments.checkAvailability({ start: at(6, 11) })).availableEmployeeIds).toEqual([]);

    // Write
    await expect(t2.caller.clients.update({ id: client.id, name: 'Hackeado' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(t2.caller.clients.delete({ id: client.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      t2.caller.employees.update({ id: emp.id, name: 'Hackeado', role: 'admin', schedule: [] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(t2.caller.employees.delete({ id: emp.id, force: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(t2.caller.appointments.delete({ id: appt.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      t2.caller.appointments.update({ id: appt.id, clientId: client.id, employeeId: emp.id, start: at(6, 11), status: 'cancelled' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      t2.caller.appointments.create({ clientId: client.id, employeeId: emp.id, start: at(6, 11), status: 'pending', force: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Tenant 1 data is intact.
    expect((await t1.caller.clients.get({ id: client.id })).name).toBe('Laura');
    expect((await t1.caller.appointments.list({ from: at(6, 0), to: at(7, 0) }))[0]?.status).toBe('pending');
  });
});

describe('data protection (F12, GDPR)', () => {
  it('records the privacy notice acceptance given outside WhatsApp and lets it be withdrawn', async () => {
    const { caller } = await newOwner();
    const withConsent = await caller.clients.create({ name: 'Con Aceptación', phone: '633 100 200', consent: true });
    expect(withConsent).toMatchObject({ consentChannel: 'web', consentVersion: PRIVACY_NOTICE_VERSION });
    const acceptedAt = withConsent.consentAt;
    // Saving again keeps the original acceptance date.
    const kept = await caller.clients.update({ id: withConsent.id, name: 'Con Aceptación', consent: true });
    expect(kept.consentAt).toEqual(acceptedAt);
    const withdrawn = await caller.clients.update({ id: withConsent.id, name: 'Con Aceptación', consent: false });
    expect(withdrawn).toMatchObject({ consentAt: null, consentChannel: null });
    const without = await caller.clients.create({ name: 'Sin Aceptación', phone: '633 100 201' });
    expect(without.consentAt).toBeNull();
  });

  it('deleting a client erases the appointments and every trace of the WhatsApp conversation', async () => {
    const { caller, tenant } = await newOwner();
    const db = getTestDb();
    const emp = await caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const client = await caller.clients.create({ name: 'Borrar Todo', phone: '644 555 666' });
    await caller.appointments.create({ clientId: client.id, employeeId: emp.id, start: at(6, 9), status: 'pending' });
    const phone = client.phone!;
    await db.conversationState.create({ data: { tenantId: tenant.id, phone, flow: 'cita', step: 'askDate', expiresAt: new Date(Date.now() + 60_000) } });
    await db.botBlacklist.create({ data: { tenantId: tenant.id, phone } });
    await db.chatwootLink.create({ data: { tenantId: tenant.id, phone, accountId: 7, inboxId: 5, contactId: 91, conversationId: 92 } });

    expect(await caller.clients.delete({ id: client.id })).toMatchObject({ appointments: 1, conversationState: 1, botPause: 1, chatwootContactQueued: true });
    expect(await db.appointment.count({ where: { clientId: client.id } })).toBe(0);
    expect(await db.conversationState.count({ where: { tenantId: tenant.id, phone } })).toBe(0);
    expect(await db.botBlacklist.count({ where: { tenantId: tenant.id, phone } })).toBe(0);
    expect(await db.chatwootLink.count({ where: { tenantId: tenant.id, phone } })).toBe(0);
    expect(await db.inboundEvent.count({ where: { tenantId: tenant.id, source: 'internal', status: 'pending' } })).toBe(1);
  });

  it('exports the client data as JSON, only within the clinic', async () => {
    const { caller } = await newOwner('Clínica Exporta');
    const emp = await caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const client = await caller.clients.create({ name: 'Exportar', email: 'exp@test.es', phone: '655 000 111', consent: true });
    await caller.appointments.create({ clientId: client.id, employeeId: emp.id, start: at(6, 9), status: 'confirmed' });
    const data = await caller.clients.export({ id: client.id });
    expect(data).toMatchObject({
      controller: { clinic: 'Clínica Exporta' },
      client: { name: 'Exportar', email: 'exp@test.es', privacyNotice: { channel: 'web' } },
      appointments: [{ professional: 'Ana', status: 'confirmed', start: '2031-01-06T09:00:00+01:00' }],
    });
    const other = await newOwner('Otra Clínica');
    await expect(other.caller.clients.export({ id: client.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('stores the privacy policy URL and the retention period', async () => {
    const { caller } = await newOwner();
    expect(await caller.tenant.get()).toMatchObject({ privacyPolicyUrl: null, retentionMonths: null });
    const updated = await caller.tenant.updatePrivacy({ privacyPolicyUrl: 'https://clinica.es/privacidad', retentionMonths: 24 });
    expect(updated).toMatchObject({ privacyPolicyUrl: 'https://clinica.es/privacidad', retentionMonths: 24 });
    await expect(caller.tenant.updatePrivacy({ privacyPolicyUrl: 'javascript:alert(1)', retentionMonths: null })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.tenant.updatePrivacy({ privacyPolicyUrl: '', retentionMonths: 7 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await caller.tenant.updatePrivacy({ privacyPolicyUrl: '', retentionMonths: null })).toMatchObject({ privacyPolicyUrl: null, retentionMonths: null });
  });
});

describe('services and time off (F14)', () => {
  it('manages services: unique names, valid durations, used services only deactivated', async () => {
    const { caller } = await newOwner();
    const puncion = await caller.services.create({ name: 'Punción seca', durationMinutes: 30 });
    await expect(caller.services.create({ name: 'Punción seca', durationMinutes: 45 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(caller.services.create({ name: 'Raro', durationMinutes: 33 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.services.create({ name: 'Eterno', durationMinutes: 600 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const emp = await caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const client = await caller.clients.create({ name: 'Laura', phone: '611 222 333' });
    // The service duration is used when none is given.
    const appt = await caller.appointments.create({ clientId: client.id, employeeId: emp.id, start: at(6, 9), status: 'pending', serviceId: puncion.id });
    expect(appt).toMatchObject({ durationMinutes: 30, service: { name: 'Punción seca' } });
    expect((await caller.services.list()).find((s) => s.id === puncion.id)?.appointments).toBe(1);

    await expect(caller.services.delete({ id: puncion.id })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await caller.services.setActive({ id: puncion.id, active: false })).toMatchObject({ active: false });
    const unused = await caller.services.create({ name: 'Sin usar', durationMinutes: 60 });
    expect(await caller.services.delete({ id: unused.id })).toEqual({ id: unused.id });

    const other = await newOwner('Otra Clínica');
    expect(await other.caller.services.list()).toEqual([]);
    await expect(other.caller.services.update({ id: puncion.id, name: 'Hackeado', durationMinutes: 30 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const otherEmp = await other.caller.employees.create({ name: 'Eva', role: 'fisioterapeuta', schedule: MON_9_14 });
    const otherClient = await other.caller.clients.create({ name: 'Pablo' });
    await expect(
      other.caller.appointments.create({ clientId: otherClient.id, employeeId: otherEmp.id, start: at(6, 9), status: 'pending', serviceId: puncion.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('absences and closures block bookings (no override) and warn about existing appointments', async () => {
    const { caller } = await newOwner();
    const emp = await caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const client = await caller.clients.create({ name: 'Laura', phone: '611 444 555' });
    await caller.appointments.create({ clientId: client.id, employeeId: emp.id, start: at(13, 10), status: 'confirmed' });

    const absence = await caller.timeOff.create({ employeeId: emp.id, startsAt: at(13, 0), endsAt: at(14, 0), reason: 'Vacaciones' });
    expect(absence.overlapping).toMatchObject([{ client: 'Laura', employee: 'Ana' }]);
    await expect(
      caller.appointments.create({ clientId: client.id, employeeId: emp.id, start: at(13, 12), status: 'pending', force: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'El empleado está ausente o la clínica está cerrada en ese horario' });
    const check = await caller.appointments.checkAvailability({ start: at(13, 12), employeeId: emp.id });
    expect(check).toMatchObject({ availableEmployeeIds: [], check: { timeOff: { clinicWide: false, reason: 'Vacaciones' } } });

    const closure = await caller.timeOff.create({ employeeId: null, startsAt: at(20, 0), endsAt: at(21, 0), reason: 'Festivo local' });
    expect(closure.overlapping).toEqual([]);
    await expect(
      caller.appointments.create({ clientId: client.id, employeeId: emp.id, start: at(20, 10), status: 'pending' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await caller.timeOff.upcoming({ employeeId: null })).map((t) => t.reason)).toEqual(['Festivo local']);
    expect((await caller.timeOff.upcoming({ employeeId: emp.id })).map((t) => t.reason)).toEqual(['Vacaciones']);
    expect((await caller.timeOff.list({ from: at(1, 0), to: at(31, 0) })).map((t) => t.employee?.name ?? 'clínica')).toEqual(['Ana', 'clínica']);

    await expect(caller.timeOff.create({ employeeId: null, startsAt: at(20, 10), endsAt: at(20, 9) })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const other = await newOwner('Otra Clínica');
    expect(await other.caller.timeOff.list({ from: at(1, 0), to: at(31, 0) })).toEqual([]);
    await expect(other.caller.timeOff.create({ employeeId: emp.id, startsAt: at(27, 0), endsAt: at(28, 0) })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(other.caller.timeOff.delete({ id: closure.timeOff.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await caller.timeOff.delete({ id: closure.timeOff.id })).toEqual({ id: closure.timeOff.id });
  });
});

describe('attendance and metrics (F15)', () => {
  it('marks attendance only on started, non-cancelled appointments of the clinic and lists the unmarked ones', async () => {
    const { caller } = await newOwner();
    const db = getTestDb();
    const emp = await caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const client = await caller.clients.create({ name: 'Laura', phone: '611 777 888' });
    // Appointments in the past (yesterday) are created directly: the web form only books on schedule.
    const yesterday = new Date(Date.now() - 86_400_000);
    const tenantId = (await caller.tenant.get()).id;
    const past = await db.appointment.create({ data: { tenantId, clientId: client.id, employeeId: emp.id, date: yesterday, source: 'web' } });
    const future = await caller.appointments.create({ clientId: client.id, employeeId: emp.id, start: at(6, 9), status: 'pending' });

    expect((await caller.appointments.unmarked()).map((a) => a.id)).toEqual([past.id]);
    expect(await caller.appointments.setAttendance({ id: past.id, attendance: 'no_show' })).toEqual({ id: past.id, attendance: 'no_show', pack: null });
    expect(await caller.appointments.unmarked()).toEqual([]);
    await expect(caller.appointments.setAttendance({ id: future.id, attendance: 'attended' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const other = await newOwner('Otra Clínica');
    await expect(other.caller.appointments.setAttendance({ id: past.id, attendance: 'attended' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await other.caller.appointments.unmarked()).toEqual([]);
  });

  it('returns the month figures and the trend of the previous months', async () => {
    const { caller } = await newOwner();
    const emp = await caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const client = await caller.clients.create({ name: 'Laura', phone: '611 999 000' });
    await caller.appointments.create({ clientId: client.id, employeeId: emp.id, start: at(6, 9), status: 'confirmed' });
    await caller.appointments.create({ clientId: client.id, employeeId: emp.id, start: at(13, 9), status: 'cancelled' });
    const m = await caller.metrics.month({ month: '2031-01' });
    expect(m).toMatchObject({ month: '2031-01', total: 2, cancelled: 1, active: 1, future: 1, channels: { web: 1, whatsapp: 0 } });
    // Mondays of January 2031: 6, 13, 20, 27 → 4 × 300 min.
    expect(m.employees).toMatchObject([{ name: 'Ana', appointments: 1, bookedMinutes: 60, scheduledMinutes: 1200 }]);
    expect(m.trend.map((t) => t.month)).toEqual(['2030-08', '2030-09', '2030-10', '2030-11', '2030-12', '2031-01']);
    expect(m.trend.at(-1)).toMatchObject({ active: 1, cancelled: 1 });
    await expect(caller.metrics.month({ month: '2031-13' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const other = await newOwner('Otra Clínica');
    expect(await other.caller.metrics.month({ month: '2031-01' })).toMatchObject({ total: 0, employees: [] });
  });
});

describe('waiting list (F17)', () => {
  it('turns the waiting list on, lists who is waiting and removes them, only within the clinic', async () => {
    const { caller } = await newOwner();
    const tenant = await caller.tenant.get();
    expect(tenant.waitlistEnabled).toBe(false);
    expect(await caller.waitlist.list()).toEqual({ enabled: false, entries: [] });
    const updated = await caller.tenant.update({
      clinicName: tenant.clinicName,
      contactPhone: '965 000 000',
      slotMinutes: 60,
      reminderHour: '08:00',
      waitlistEnabled: true,
    });
    expect(updated.waitlistEnabled).toBe(true);

    // Clients join from WhatsApp; here the entry is created directly.
    const client = await caller.clients.create({ name: 'Laura', phone: '611 555 444' });
    const db = getTestDb();
    const entry = await db.waitlistEntry.create({
      data: {
        tenantId: tenant.id,
        clientId: client.id,
        durationMinutes: 60,
        windowStart: at(6, 0),
        windowEnd: at(6, 23, 59),
        wholeDay: true,
        preferredStart: at(6, 10),
      },
    });
    expect(await caller.waitlist.list()).toMatchObject({
      enabled: true,
      entries: [{ id: entry.id, clientName: 'Laura', wholeDay: true, windowStart: at(6, 0), offer: null }],
    });

    const other = await newOwner('Otra Clínica');
    expect((await other.caller.waitlist.list()).entries).toEqual([]);
    await expect(other.caller.waitlist.remove({ id: entry.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await caller.waitlist.remove({ id: entry.id })).toEqual({ ok: true });
    expect((await caller.waitlist.list()).entries).toEqual([]);
    await expect(caller.waitlist.remove({ id: entry.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('roles: administrators and professionals (F18)', () => {
  const uniqueEmail = (name: string) => `${name}-${randomUUID().slice(0, 8)}@clinica.test`;
  let phoneCounter = 0;

  /** A clinic with two professionals (Ana, Luis), one appointment each and Ana signed in. */
  async function teamClinic() {
    const owner = await newOwner('Clínica Equipo');
    const ana = await owner.caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const luis = await owner.caller.employees.create({ name: 'Luis', role: 'fisioterapeuta', schedule: MON_9_14 });
    phoneCounter += 1;
    const client = await owner.caller.clients.create({ name: 'Laura', phone: `611 300 ${String(100 + phoneCounter)}` });
    const anaEmail = uniqueEmail('ana');
    await owner.caller.team.invite({ email: anaEmail.toUpperCase(), role: 'professional', employeeId: ana.id });
    const anaUser = { id: `kp_${randomUUID()}`, email: anaEmail };
    const pro = await callerFor(anaUser);
    const own = await owner.caller.appointments.create({ clientId: client.id, employeeId: ana.id, start: at(6, 9), status: 'pending' });
    const others = await owner.caller.appointments.create({ clientId: client.id, employeeId: luis.id, start: at(6, 10), status: 'pending' });
    return { owner, ana, luis, client, anaUser, pro, own: own!, others: others! };
  }

  it('an invited professional joins on first sign-in and only sees their own appointments', async () => {
    const c = await teamClinic();
    const range = { from: at(6, 0), to: at(7, 0) };
    expect((await c.pro.appointments.list(range)).map((a) => a.id)).toEqual([c.own.id]);
    expect((await c.owner.caller.appointments.list(range)).map((a) => a.id)).toEqual([c.own.id, c.others.id]);
    expect((await c.pro.appointments.upcoming()).map((a) => a.employeeId)).toEqual([c.ana.id]);

    // Attendance to mark: only their own past appointments.
    const db = getTestDb();
    const tenantId = c.ana.tenantId;
    const past = { tenantId, clientId: c.client.id, date: new Date(Date.now() - 86_400_000), source: 'web' as const };
    const mine = await db.appointment.create({ data: { ...past, employeeId: c.ana.id } });
    const theirs = await db.appointment.create({ data: { ...past, employeeId: c.luis.id } });
    expect((await c.pro.appointments.unmarked()).map((a) => a.id)).toEqual([mine.id]);
    expect(await c.pro.appointments.setAttendance({ id: mine.id, attendance: 'attended' })).toMatchObject({ attendance: 'attended' });
    await expect(c.pro.appointments.setAttendance({ id: theirs.id, attendance: 'attended' })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Clients to book: name and phone only.
    const [option] = await c.pro.clients.options();
    expect(Object.keys(option!).sort()).toEqual(['id', 'name', 'phone']);

    // Absences: theirs and the clinic closures, not the colleagues'.
    await c.owner.caller.timeOff.create({ employeeId: c.luis.id, startsAt: at(6, 9), endsAt: at(6, 10), reason: 'Médico' });
    await c.owner.caller.timeOff.create({ employeeId: null, startsAt: at(7, 0), endsAt: at(8, 0), reason: 'Festivo' });
    expect((await c.pro.timeOff.list({ from: at(6, 0), to: at(9, 0) })).map((t) => t.reason)).toEqual(['Festivo']);

    const team = await c.owner.caller.team.list();
    expect(team.invitations).toEqual([]);
    expect(team.members.map((m) => [m.role, m.employee?.name ?? null, m.isYou])).toEqual([
      ['owner', null, true],
      ['professional', 'Ana', false],
    ]);
  });

  it('a professional cannot touch the appointments of other professionals', async () => {
    const c = await teamClinic();
    const base = { clientId: c.client.id, status: 'pending' as const };
    await expect(c.pro.appointments.create({ ...base, employeeId: c.luis.id, start: at(6, 11) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await c.pro.appointments.create({ ...base, employeeId: c.ana.id, start: at(6, 11) })).toMatchObject({ employeeId: c.ana.id });
    await expect(c.pro.appointments.update({ ...base, id: c.others.id, employeeId: c.luis.id, start: at(6, 12) })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // Nor hand their own appointment over to someone else.
    await expect(c.pro.appointments.update({ ...base, id: c.own.id, employeeId: c.luis.id, start: at(6, 9) })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await c.pro.appointments.update({ ...base, id: c.own.id, employeeId: c.ana.id, start: at(6, 12) })).toMatchObject({ date: at(6, 12) });
    await expect(c.pro.appointments.delete({ id: c.others.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await c.pro.appointments.delete({ id: c.own.id })).toEqual({ id: c.own.id });
  });

  it('closes the administrator sections to professionals', async () => {
    const c = await teamClinic();
    const forbidden = [
      () => c.pro.tenant.get(),
      () => c.pro.tenant.update({ clinicName: 'X', contactPhone: '', slotMinutes: 60, reminderHour: '08:00' }),
      () => c.pro.clients.list({}),
      () => c.pro.clients.get({ id: c.client.id }),
      () => c.pro.clients.export({ id: c.client.id }),
      () => c.pro.clients.delete({ id: c.client.id }),
      () => c.pro.employees.create({ name: 'Nuevo', role: 'fisioterapeuta', schedule: MON_9_14 }),
      () => c.pro.services.create({ name: 'Masaje', durationMinutes: 30 }),
      () => c.pro.timeOff.create({ employeeId: c.ana.id, startsAt: at(8, 9), endsAt: at(8, 10) }),
      () => c.pro.metrics.month({ month: '2031-01' }),
      () => c.pro.waitlist.list(),
      () => c.pro.team.list(),
      () => c.pro.team.invite({ email: uniqueEmail('x'), role: 'admin', employeeId: null }),
    ];
    for (const call of forbidden) await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // What the calendar needs stays available.
    expect((await c.pro.employees.list({})).length).toBe(2);
    expect(await c.pro.services.list()).toEqual([]);
  });

  it('manages the team: invitations, administrators and removals', async () => {
    const c = await teamClinic();
    const adminEmail = uniqueEmail('admin');
    await c.owner.caller.team.invite({ email: adminEmail, role: 'admin', employeeId: null });
    await expect(c.owner.caller.team.invite({ email: adminEmail, role: 'admin', employeeId: null })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(c.owner.caller.team.invite({ email: uniqueEmail('otra'), role: 'professional', employeeId: c.ana.id })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const pending = await c.owner.caller.team.invite({ email: uniqueEmail('luis'), role: 'professional', employeeId: c.luis.id });

    const adminUser = { id: `kp_${randomUUID()}`, email: adminEmail };
    const admin = await callerFor(adminUser);
    const team = await admin.team.list();
    const owner = team.members.find((m) => m.role === 'owner')!;
    const me = team.members.find((m) => m.isYou)!;
    const ana = team.members.find((m) => m.role === 'professional')!;
    expect(me.role).toBe('admin');
    await expect(admin.team.remove({ id: owner.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(admin.team.remove({ id: me.id })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // Another clinic cannot see or touch this team.
    const other = await newOwner('Otra Clínica');
    await expect(other.caller.team.remove({ id: ana.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(other.caller.team.cancelInvitation({ id: pending.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await admin.team.cancelInvitation({ id: pending.id })).toEqual({ ok: true });
    expect(await admin.team.remove({ id: ana.id })).toEqual({ ok: true });
    // Ana has no clinic any more.
    await expect((await callerFor(c.anaUser)).appointments.list({ from: at(6, 0), to: at(7, 0) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('pending improvements (F21)', () => {
  const uniqueEmail = (name: string) => `${name}-${randomUUID().slice(0, 8)}@clinica.test`;
  let phone = 0;
  const nextPhone = () => `611 400 ${String(100 + ++phone)}`;

  async function clinicWithWaitlist(waitlistEnabled = true) {
    const owner = await newOwner('Clínica Mejoras');
    const tenant = await owner.caller.tenant.get();
    await owner.caller.tenant.update({ clinicName: tenant.clinicName, contactPhone: '965 000 000', slotMinutes: 60, reminderHour: '08:00', waitlistEnabled });
    const ana = await owner.caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const laura = await owner.caller.clients.create({ name: 'Laura', phone: nextPhone(), consent: true });
    const jobs = () =>
      getTestDb().inboundEvent.findMany({ where: { tenantId: tenant.id, source: 'internal' }, orderBy: { id: 'asc' } });
    return { ...owner, tenant, ana, laura, jobs };
  }

  it('cancelling, moving or deleting in the panel asks the bot to offer the slot right away', async () => {
    const c = await clinicWithWaitlist();
    const base = { clientId: c.laura.id, employeeId: c.ana.id, status: 'pending' as const };
    const appointment = (await c.caller.appointments.create({ ...base, start: at(6, 9) }))!;
    expect(await c.jobs()).toEqual([]);
    await c.caller.appointments.update({ ...base, id: appointment.id, start: at(6, 10) });
    await c.caller.appointments.update({ ...base, id: appointment.id, start: at(6, 10), status: 'cancelled' });
    // Already cancelled: deleting it frees nothing new.
    await c.caller.appointments.delete({ id: appointment.id });
    const jobs = await c.jobs();
    expect(jobs.map((j) => (j.payload as { type: string; reason: string }).reason)).toEqual(['appointment changed', 'appointment changed']);
    expect(jobs.every((j) => (j.payload as { type: string }).type === 'waitlist.check' && j.phone === '')).toBe(true);

    // Without the waiting list nothing is queued.
    const off = await clinicWithWaitlist(false);
    const other = (await off.caller.appointments.create({ clientId: off.laura.id, employeeId: off.ana.id, status: 'pending', start: at(6, 9) }))!;
    await off.caller.appointments.delete({ id: other.id });
    expect(await off.jobs()).toEqual([]);
  });

  it('adds clients to the waiting list from the panel with the same rules as WhatsApp', async () => {
    const c = await clinicWithWaitlist();
    const input = { clientId: c.laura.id, day: '2031-01-06', time: '10:00', onlyThatTime: false, serviceId: null };
    const { id } = await c.caller.waitlist.add(input);
    expect(await getTestDb().waitlistEntry.findUniqueOrThrow({ where: { id } })).toMatchObject({
      wholeDay: true,
      windowStart: at(6, 0),
      preferredStart: at(6, 10),
      durationMinutes: 60,
    });
    expect((await c.jobs()).map((j) => (j.payload as { reason: string }).reason)).toEqual(['added from the panel']);
    await expect(c.caller.waitlist.add(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    const exact = await c.caller.waitlist.add({ ...input, onlyThatTime: true, time: '12:00' });
    expect(await getTestDb().waitlistEntry.findUniqueOrThrow({ where: { id: exact.id } })).toMatchObject({
      wholeDay: false,
      windowStart: at(6, 12),
      windowEnd: at(6, 12),
    });

    const noConsent = await c.caller.clients.create({ name: 'Sin aviso', phone: nextPhone() });
    await expect(c.caller.waitlist.add({ ...input, clientId: noConsent.id })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(c.caller.waitlist.add({ ...input, day: '2020-01-06' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(c.caller.waitlist.add({ ...input, time: null, onlyThatTime: true })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const off = await clinicWithWaitlist(false);
    await expect(off.caller.waitlist.add({ ...input, clientId: off.laura.id })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // A client of another clinic cannot be added.
    await expect(off.caller.waitlist.add({ ...input })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('changes the role of a team member without removing and inviting again', async () => {
    const c = await clinicWithWaitlist();
    const adminEmail = uniqueEmail('admin');
    await c.caller.team.invite({ email: adminEmail, role: 'admin', employeeId: null });
    const adminUser = { id: `kp_${randomUUID()}`, email: adminEmail };
    const admin = await callerFor(adminUser);
    const team = await admin.team.list();
    const me = team.members.find((m) => m.isYou)!;
    const owner = team.members.find((m) => m.role === 'owner')!;
    await expect(admin.team.changeRole({ id: owner.id, role: 'admin', employeeId: null })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(admin.team.changeRole({ id: me.id, role: 'professional', employeeId: c.ana.id })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(await c.caller.team.changeRole({ id: me.id, role: 'professional', employeeId: c.ana.id })).toEqual({ ok: true });
    // From the next request, the same person is a professional.
    const asProfessional = await callerFor(adminUser);
    await expect(asProfessional.team.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await asProfessional.appointments.list({ from: at(6, 0), to: at(7, 0) })).toEqual([]);
    expect(await c.caller.team.changeRole({ id: me.id, role: 'admin', employeeId: null })).toEqual({ ok: true });
    expect((await (await callerFor(adminUser)).team.list()).members.length).toBe(2);

    const other = await newOwner('Otra Clínica');
    await expect(other.caller.team.changeRole({ id: me.id, role: 'admin', employeeId: null })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('client import (F23)', () => {
  it('previews and imports a CSV, only for administrators', async () => {
    const { caller } = await newOwner('Clínica Importa');
    const csv = 'Nombre;Móvil;Email\nAna Import;600 800 001;ana@import.es\nLuis Import;600 800 002;\nMal Teléfono;12;';
    const preview = await caller.clients.importPreview({ csv });
    expect(preview).toMatchObject({ total: 3, toImport: 2, skippedCount: 1, ignoredColumns: [] });
    expect(preview.skipped).toEqual([{ row: 4, name: 'Mal Teléfono', reason: 'Teléfono no válido: 12' }]);
    expect((await caller.clients.list({})).length).toBe(0);

    expect(await caller.clients.import({ csv, consent: false })).toMatchObject({ total: 3, imported: 2, skippedCount: 1 });
    expect((await caller.clients.list({})).map((c) => c.name).sort()).toEqual(['Ana Import', 'Luis Import']);
    await expect(caller.clients.importPreview({ csv: 'Teléfono\n600800003' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // Professionals cannot import.
    const ana = await caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const email = `pro-${randomUUID().slice(0, 8)}@clinica.test`;
    await caller.team.invite({ email, role: 'professional', employeeId: ana.id });
    const pro = await callerFor({ id: `kp_${randomUUID()}`, email });
    await expect(pro.clients.import({ csv, consent: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('activity log (F24)', () => {
  it('records who changed what in the panel, without personal data, and shows it to administrators', async () => {
    const { caller, user } = await newOwner('Clínica Registro');
    const ana = await caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const client = await caller.clients.create({ name: 'Paciente Secreto', phone: '611 500 101', email: 'secreto@correo.es', notes: 'Lesión de rodilla' });
    const appointment = (await caller.appointments.create({ clientId: client.id, employeeId: ana.id, start: at(6, 9), status: 'pending' }))!;
    await caller.appointments.update({ id: appointment.id, clientId: client.id, employeeId: ana.id, start: at(6, 10), status: 'cancelled' });
    await caller.appointments.delete({ id: appointment.id });
    // Viewing the record twice in a row counts once; exporting is recorded too.
    await caller.clients.get({ id: client.id });
    await caller.clients.get({ id: client.id });
    await caller.clients.export({ id: client.id });

    const { items } = await caller.activity.list({});
    expect(items.map((i) => i.action)).toEqual([
      'clients.export',
      'clients.get',
      'appointments.delete',
      'appointments.update',
      'appointments.create',
      'clients.create',
      'employees.create',
    ]);
    const update = items.find((i) => i.action === 'appointments.update')!;
    expect(update).toMatchObject({
      actorType: 'member',
      actorLabel: user.email,
      label: 'Cambió una cita',
      clientName: 'Paciente Secreto',
      employeeName: 'Ana',
      details: { status: 'cancelled', start: at(6, 10).toISOString(), employeeId: ana.id },
    });
    // Nothing personal is stored: no name, phone, email or notes in any entry.
    const rows = await getTestDb().activityLog.findMany({ where: { tenantId: client.tenantId } });
    const stored = JSON.stringify(rows, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
    for (const secret of ['Paciente Secreto', '611500101', '+34611500101', 'secreto@correo.es', 'rodilla']) expect(stored).not.toContain(secret);

    expect((await caller.activity.list({ category: 'equipo' })).items).toEqual([]);
    // The deleted appointment is still described (snapshot taken before the change).
    expect(items.find((i) => i.action === 'appointments.delete')).toMatchObject({
      clientName: 'Paciente Secreto',
      employeeName: 'Ana',
      details: { start: at(6, 10).toISOString() },
    });
    expect((await caller.activity.list({ category: 'citas' })).items.map((i) => i.action)).toEqual([
      'appointments.delete',
      'appointments.update',
      'appointments.create',
    ]);

    // Erasing the client keeps the entries but not the link to that person.
    await caller.clients.delete({ id: client.id });
    const after = await caller.activity.list({});
    expect(after.items[0]).toMatchObject({ action: 'clients.delete', clientName: null });
    expect(after.items.every((i) => i.clientName === null)).toBe(true);
    expect(await getTestDb().activityLog.count({ where: { clientId: client.id } })).toBe(0);
  });

  it('only administrators can read it', async () => {
    const owner = await newOwner('Clínica Registro 2');
    const ana = await owner.caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const email = `pro-${randomUUID().slice(0, 8)}@clinica.test`;
    await owner.caller.team.invite({ email, role: 'professional', employeeId: ana.id });
    const pro = await callerFor({ id: `kp_${randomUUID()}`, email });
    await expect(pro.activity.list({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const other = await newOwner('Otra Clínica');
    expect((await other.caller.activity.list({})).items).toEqual([]);
  });
});

describe('treatments and packs (F26)', () => {
  // 2031: Mondays 6, 13, 20 and 27 of January and 3 of February.
  const feb = (d: number, h: number) => zonedTimeToUtc({ year: 2031, month: 2, day: d, hour: h, minute: 0 }, TZ);

  it('plans a treatment, books it all at once, cancels the rest, and logs it', async () => {
    const { caller } = await newOwner('Clínica Tratamientos');
    const ana = await caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const client = await caller.clients.create({ name: 'Paciente Serie', phone: '611 600 101' });
    const other = await caller.clients.create({ name: 'Otra Paciente', phone: '611 600 102' });
    await caller.appointments.create({ clientId: other.id, employeeId: ana.id, start: at(13, 9), status: 'pending' });
    const input = { clientId: client.id, employeeId: ana.id, serviceId: null, first: at(6, 9), weekdays: [1], intervalWeeks: 1 as const, sessions: 4 };

    const plan = (await caller.appointments.planSeries(input))!;
    expect(plan.sessions).toEqual([at(6, 9), at(20, 9), at(27, 9), feb(3, 9)]);
    expect(plan.skipped).toEqual([{ start: at(13, 9), reason: 'conflict' }]);
    // A plan that is no longer valid books nothing.
    await expect(
      caller.appointments.createSeries({ ...input, status: 'pending', notes: null, expected: [at(6, 9), at(13, 9), at(20, 9), at(27, 9)] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const booked = (await caller.appointments.createSeries({ ...input, status: 'confirmed', notes: 'Hombro', expected: plan.sessions }))!;
    expect(booked).toMatchObject({ sessions: 4, start: at(6, 9) });

    const mine = (await caller.appointments.list({ from: at(1, 0), to: feb(10, 0) })).filter((a) => a.clientId === client.id);
    expect(mine.map((a) => [a.date, a.status, a.seriesId])).toEqual(plan.sessions.map((d) => [d, 'confirmed', booked.seriesId]));
    expect((await caller.appointments.details({ id: mine[1]!.id })).series).toEqual({ seriesId: booked.seriesId, index: 2, total: 4 });

    expect(await caller.appointments.cancelFollowing({ id: mine[2]!.id })).toEqual({ id: mine[2]!.id, cancelled: 2 });
    expect((await caller.appointments.details({ id: mine[1]!.id })).series).toMatchObject({ index: 2, total: 2 });
    const single = (await caller.appointments.list({ from: at(1, 0), to: feb(10, 0) })).find((a) => a.clientId === other.id)!;
    await expect(caller.appointments.cancelFollowing({ id: single.id })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const activity = (await caller.activity.list({ category: 'citas' })).items;
    expect(activity[0]).toMatchObject({ action: 'appointments.cancelFollowing', clientName: 'Paciente Serie', details: { cancelled: 2 } });
    expect(activity[1]).toMatchObject({
      action: 'appointments.createSeries',
      label: 'Creó un tratamiento (varias citas)',
      clientName: 'Paciente Serie',
      employeeName: 'Ana',
      details: { sessions: 4, intervalWeeks: 1, start: at(6, 9).toISOString() },
    });
  });

  it('a professional only plans treatments in their own agenda', async () => {
    const owner = await newOwner('Clínica Tratamientos 2');
    const [ana, bea] = await Promise.all([
      owner.caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 }),
      owner.caller.employees.create({ name: 'Bea', role: 'fisioterapeuta', schedule: MON_9_14 }),
    ]);
    const client = await owner.caller.clients.create({ name: 'Paciente', phone: '611 600 201' });
    const email = `pro-${randomUUID().slice(0, 8)}@clinica.test`;
    await owner.caller.team.invite({ email, role: 'professional', employeeId: ana.id });
    const pro = await callerFor({ id: `kp_${randomUUID()}`, email });
    const input = { clientId: client.id, serviceId: null, first: at(6, 10), weekdays: [1], intervalWeeks: 2 as const, sessions: 2 };
    await expect(pro.appointments.planSeries({ ...input, employeeId: bea.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const plan = (await pro.appointments.planSeries({ ...input, employeeId: ana.id }))!;
    expect(plan.sessions).toEqual([at(6, 10), at(20, 10)]);
    await expect(pro.appointments.createSeries({ ...input, employeeId: ana.id, status: 'pending', notes: null, expected: plan.sessions })).resolves.toMatchObject({
      sessions: 2,
    });
  });

  it('packs: administrators manage them, attendance spends them, everyone sees what is left', async () => {
    const { caller } = await newOwner('Clínica Bonos');
    const ana = await caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const client = await caller.clients.create({ name: 'Paciente Bono', phone: '611 700 101' });
    const created = await caller.packs.create({ clientId: client.id, name: 'Bono 2 sesiones', totalSessions: 2, serviceId: null, expiresOn: null });
    expect((await caller.packs.list({ clientId: client.id })).map((p) => [p.name, p.remaining, p.state])).toEqual([['Bono 2 sesiones', 2, 'active']]);

    // A past Monday: 2 June 2025, 10:00.
    const past = zonedTimeToUtc({ year: 2025, month: 6, day: 2, hour: 10, minute: 0 }, TZ);
    const appointment = (await caller.appointments.create({ clientId: client.id, employeeId: ana.id, start: past, status: 'confirmed' }))!;
    expect(await caller.packs.hint({ clientId: client.id, serviceId: null, date: past })).toMatchObject({ remaining: 2, spentHere: false });
    expect((await caller.appointments.setAttendance({ id: appointment.id, attendance: 'attended' })).pack).toEqual({
      name: 'Bono 2 sesiones',
      remaining: 1,
      totalSessions: 2,
      spentHere: true,
    });
    expect((await caller.appointments.details({ id: appointment.id })).pack).toMatchObject({ remaining: 1, spentHere: true });
    await expect(caller.packs.delete({ id: created.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(caller.packs.update({ id: created.id, name: 'Bono', totalSessions: 0, serviceId: null, expiresOn: null })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller.packs.update({ id: created.id, name: 'Bono 1', totalSessions: 1, serviceId: null, expiresOn: '2031-12-31' })).resolves.toMatchObject({
      totalSessions: 1,
    });

    // The no-show setting.
    const settings = await caller.tenant.get();
    expect(settings.packNoShowSpends).toBe(false);
    const updated = await caller.tenant.update({
      clinicName: settings.clinicName,
      contactPhone: settings.contactPhone,
      slotMinutes: settings.slotMinutes,
      reminderHour: settings.reminderHour,
      packNoShowSpends: true,
    });
    expect(updated.packNoShowSpends).toBe(true);

    // A professional sees the hint but not the client's packs.
    const email = `pro-${randomUUID().slice(0, 8)}@clinica.test`;
    await caller.team.invite({ email, role: 'professional', employeeId: ana.id });
    const pro = await callerFor({ id: `kp_${randomUUID()}`, email });
    await expect(pro.packs.list({ clientId: client.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(pro.packs.create({ clientId: client.id, name: 'Bono', totalSessions: 5, serviceId: null, expiresOn: null })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await pro.packs.hint({ clientId: client.id, serviceId: null, date: past })).toBeNull();

    // Clearing the attendance gives the session back; then the pack can be deleted.
    expect((await caller.appointments.setAttendance({ id: appointment.id, attendance: null })).pack).toBeNull();
    await expect(caller.packs.delete({ id: created.id })).resolves.toMatchObject({ id: created.id });

    const activity = (await caller.activity.list({ category: 'clientes' })).items.map((i) => [i.action, i.clientName]);
    expect(activity.slice(0, 3)).toEqual([
      ['packs.delete', 'Paciente Bono'],
      ['packs.update', 'Paciente Bono'],
      ['packs.create', 'Paciente Bono'],
    ]);
  });
});

describe('public booking page (F27)', () => {
  const dbs = () => ({ system: getTestDb(), app: getTestAppDb() });

  it('is published with the WhatsApp number and a free address, and has a QR code', async () => {
    const { caller } = await newOwner('Clínica Página');
    const slug = `pagina-${randomUUID().slice(0, 8)}`;
    await expect(caller.tenant.updateBookingPage({ enabled: true, slug })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await caller.tenant.updateWhatsApp({ waPhoneNumberId: null, phoneNormalized: '965 111 222' });
    await expect(caller.tenant.updateBookingPage({ enabled: true, slug: 'Mal nombre' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const view = await caller.tenant.updateBookingPage({ enabled: true, slug });
    expect(view).toMatchObject({ bookingPageEnabled: true, publicSlug: slug, bookingPageUrl: expect.stringMatching(new RegExp(`/reservar/${slug}$`)) });
    const qr = (await caller.tenant.bookingPageQr())!;
    expect(qr.url).toBe(view.bookingPageUrl);
    expect(qr.svg.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(qr.png.startsWith('data:image/png;base64,')).toBe(true);

    const other = await newOwner('Otra Página');
    await other.caller.tenant.updateWhatsApp({ waPhoneNumberId: null, phoneNormalized: '965 111 333' });
    await expect(other.caller.tenant.updateBookingPage({ enabled: true, slug })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await other.caller.tenant.bookingPageQr()).toBeNull();
    expect((await caller.activity.list({ category: 'ajustes' })).items[0]).toMatchObject({
      action: 'tenant.updateBookingPage',
      details: { bookingPageEnabled: true },
    });
  });

  it('shows the free slots of each service by day, with links that open WhatsApp', async () => {
    const { caller } = await newOwner('Clínica Pública');
    const slug = `publica-${randomUUID().slice(0, 8)}`;
    await caller.tenant.updateWhatsApp({ waPhoneNumberId: null, phoneNormalized: '965 222 333' });
    await caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const physio = await caller.services.create({ name: 'Fisioterapia', durationMinutes: 60 });
    await caller.services.create({ name: 'Masaje', durationMinutes: 30 });
    await caller.tenant.updateBookingPage({ enabled: true, slug });
    // Monday 6 January 2031, 7:00: Mondays 6 and 13 are within the 14 days.
    const options = { db: dbs(), now: at(6, 7) };

    // Two services: choose one first.
    expect(await loadBookingPage(slug, {}, options)).toMatchObject({ clinicName: 'Clínica Pública', chooseService: true, days: [], day: null });
    const page = (await loadBookingPage(slug, { servicio: physio.id }, options))!;
    expect(page.service).toMatchObject({ id: physio.id, name: 'Fisioterapia' });
    expect(page.days.map((d) => [d.dayKey, d.count])).toEqual([
      ['2031-01-06', 5],
      ['2031-01-13', 5],
    ]);
    expect(page.day!.slots.map((s) => s.time)).toEqual(['09:00', '10:00', '11:00', '12:00', '13:00']);
    const [first] = page.day!.slots;
    expect(first!.href.startsWith('https://wa.me/34965222333?text=')).toBe(true);
    const message = decodeURIComponent(first!.href.split('?text=')[1]!);
    expect(message).toBe(
      `Hola, quiero pedir cita para Fisioterapia el lunes, 6 de enero de 2031 a las 09:00 (ref. W-310106-0900-${serviceRefCode(physio.id)}).`,
    );
    expect(first!.label).toBe('Pedir cita el lunes, 6 de enero de 2031 a las 09:00 por WhatsApp (se abre en otra pestaña)');
    expect((await loadBookingPage(slug, { servicio: physio.id, dia: '2031-01-13' }, options))!.day!.dayKey).toBe('2031-01-13');

    // Unpublished, or an address that is not valid: nothing.
    await caller.tenant.updateBookingPage({ enabled: false, slug });
    expect(await loadBookingPage(slug, {}, options)).toBeNull();
    expect(await loadBookingPage('../otra', {}, options)).toBeNull();
  });
});

describe('agenda links (F28)', () => {
  const dbs = () => ({ system: getTestDb(), app: getTestAppDb() });
  const tokenOf = (url: string) => url.split('/api/calendar/')[1]!;

  it('each professional manages their own, administrators choose whose, and the agenda is served', async () => {
    const owner = await newOwner('Clínica Agenda');
    const [ana, bea] = await Promise.all([
      owner.caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 }),
      owner.caller.employees.create({ name: 'Bea', role: 'fisioterapeuta', schedule: MON_9_14 }),
    ]);
    const email = `pro-${randomUUID().slice(0, 8)}@clinica.test`;
    await owner.caller.team.invite({ email, role: 'professional', employeeId: ana.id });
    const pro = await callerFor({ id: `kp_${randomUUID()}`, email });
    const client = await owner.caller.clients.create({ name: 'Paciente Calendario', phone: '611 800 101', notes: 'Hombro' });
    await owner.caller.appointments.create({ clientId: client.id, employeeId: ana.id, start: at(6, 10), status: 'confirmed' });

    // The professional: their own agenda only.
    expect((await pro.calendarFeed.get({})).feed).toBeNull();
    const created = await pro.calendarFeed.create({ fullNames: false });
    expect(created.url).toMatch(/\/api\/calendar\/[A-Za-z0-9_-]{43}\.ics$/);
    expect(created.webcalUrl.startsWith('webcal://')).toBe(true);
    expect((await pro.calendarFeed.get({})).feed).toMatchObject({ url: created.url, fullNames: false, employeeId: ana.id });
    await expect(pro.calendarFeed.get({ employeeId: bea.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Administrators choose the professional.
    await expect(owner.caller.calendarFeed.get({})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((await owner.caller.calendarFeed.get({ employeeId: ana.id })).feed?.url).toBe(created.url);

    // The agenda, with initials and nothing else about the client.
    const options = { db: dbs(), now: at(1, 9) };
    const response = await calendarFeedResponse(tokenOf(created.url), options);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    const ics = await response.text();
    expect(ics).toContain('X-WR-CALNAME:Ana · Clínica Agenda');
    expect(ics).toContain('SUMMARY:P. C.\r\n');
    expect(ics).not.toMatch(/Paciente|611800101|Hombro/);

    // A new link (by the owner, with full names): the old one stops working.
    const renewed = await owner.caller.calendarFeed.create({ employeeId: ana.id, fullNames: true });
    expect((await calendarFeedResponse(tokenOf(created.url), options)).status).toBe(404);
    expect(await (await calendarFeedResponse(tokenOf(renewed.url), options)).text()).toContain('SUMMARY:Paciente Calendario\r\n');
    expect(await pro.calendarFeed.setFullNames({ fullNames: false })).toEqual({ employeeId: ana.id, fullNames: false });

    // Revoked: gone.
    expect(await pro.calendarFeed.revoke({})).toEqual({ employeeId: ana.id, revoked: true });
    expect((await calendarFeedResponse(tokenOf(renewed.url), options)).status).toBe(404);
    expect((await calendarFeedResponse('cualquier-cosa.ics', options)).status).toBe(404);

    // The activity log records it, never the link.
    const items = (await owner.caller.activity.list({ category: 'equipo' })).items;
    expect(items.slice(0, 4).map((i) => i.action)).toEqual(['calendarFeed.revoke', 'calendarFeed.setFullNames', 'calendarFeed.create', 'calendarFeed.create']);
    expect(items[0]).toMatchObject({ actorLabel: email, employeeName: 'Ana' });
    const stored = JSON.stringify(items);
    for (const url of [created.url, renewed.url]) expect(stored).not.toContain(tokenOf(url).slice(0, 20));
  });
});

describe('assistant information (F29)', () => {
  const empty = { address: '', city: '', hours: '', payments: '', insurers: '', parking: '', services: [] as string[], notes: [] as string[] };

  it('generates the assistant text from the form, and an uploaded text takes priority', async () => {
    const { caller } = await newOwner('Clínica Información');
    await caller.services.create({ name: 'Fisioterapia', durationMinutes: 60 });
    expect(await caller.tenant.getAssistantInfo()).toEqual({ info: empty, suggestedServices: ['Fisioterapia (1 h)'], usesCustomPrompt: false });

    await caller.tenant.updateAssistantInfo({
      ...empty,
      address: 'C/ Sol, 2',
      city: 'Murcia',
      payments: 'Tarjeta y Bizum',
      services: ['Fisioterapia (1 h): 35 €'],
      notes: ['Trae ropa cómoda.'],
    });
    const faq = await caller.tenant.getFaqPrompt();
    expect(faq.isDefault).toBe(true);
    expect(faq.content).toContain('Clínica Información, una clínica de fisioterapia ubicada en Murcia.');
    expect(faq.content).toContain('Dirección: C/ Sol, 2\nTeléfono: 965 000 000');
    expect(faq.content).toContain('Servicios y tratamientos:\n- Fisioterapia (1 h): 35 €');
    expect(faq.content).toContain('Información importante:\n- Trae ropa cómoda.');
    expect((await caller.tenant.getAssistantInfo()).info).toMatchObject({ address: 'C/ Sol, 2', notes: ['Trae ropa cómoda.'] });
    await expect(caller.tenant.updateAssistantInfo({ ...empty, notes: Array.from({ length: 21 }, () => 'x') })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });

    // A text of one's own replaces it until going back to the form.
    await caller.tenant.uploadFaqPrompt({ content: 'Texto propio de la clínica' });
    expect(await caller.tenant.getFaqPrompt()).toEqual({ content: 'Texto propio de la clínica', isDefault: false });
    expect((await caller.tenant.getAssistantInfo()).usesCustomPrompt).toBe(true);
    await caller.tenant.uploadFaqPrompt({ content: null });
    expect((await caller.tenant.getFaqPrompt()).content).toContain('ubicada en Murcia');

    expect((await caller.activity.list({ category: 'ajustes' })).items.map((i) => i.action)).toContain('tenant.updateAssistantInfo');
  });
});

describe('configurable reminders (F30)', () => {
  it('saves when the reminders go out, and rejects other values', async () => {
    const { caller } = await newOwner('Clínica Recordatorios');
    const current = await caller.tenant.get();
    expect(current).toMatchObject({ reminderDaysBefore: 1, secondReminderHours: null });
    const base = { clinicName: current.clinicName, contactPhone: current.contactPhone, slotMinutes: current.slotMinutes, reminderHour: '09:30' };
    expect(await caller.tenant.update({ ...base, reminderDaysBefore: 2, secondReminderHours: 3 })).toMatchObject({
      reminderHour: '09:30',
      reminderDaysBefore: 2,
      secondReminderHours: 3,
    });
    expect(await caller.tenant.update({ ...base, secondReminderHours: null })).toMatchObject({ reminderDaysBefore: 2, secondReminderHours: null });
    await expect(caller.tenant.update({ ...base, reminderDaysBefore: 3 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.tenant.update({ ...base, secondReminderHours: 5 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('platform console (F31)', () => {
  it('is only for the emails in PLATFORM_ADMIN_EMAILS', () => {
    const list = ' Admin@Plataforma.test, otra@plataforma.test;tercera@plataforma.test ';
    expect(isPlatformAdmin('admin@plataforma.test', list)).toBe(true);
    expect(isPlatformAdmin('TERCERA@plataforma.test', list)).toBe(true);
    expect(isPlatformAdmin('dueno@clinica.test', list)).toBe(false);
    expect(isPlatformAdmin(null, list)).toBe(false);
    expect(isPlatformAdmin('admin@plataforma.test', '')).toBe(false);
  });

  it('shows a whole month, never one in the future', () => {
    const now = new Date('2026-01-20T10:00:00Z');
    expect(platformMonth(undefined, now)).toMatchObject({ key: '2026-01', previous: '2025-12', next: null });
    expect(platformMonth('2025-12', now)).toMatchObject({
      key: '2025-12',
      from: new Date('2025-12-01T00:00:00Z'),
      to: new Date('2026-01-01T00:00:00Z'),
      next: '2026-01',
    });
    for (const raw of ['2026-02', '2025-13', 'enero', '1999-05']) expect(platformMonth(raw, now).key).toBe('2026-01');
  });

  it('adds up the usage of each clinic with its estimated cost', async () => {
    const db = getTestDb();
    const { tenant } = await newOwner('Clínica Consola');
    const tenantId = tenant.id;
    // A month no other test writes to.
    const now = new Date('2031-03-15T10:00:00Z');
    await recordUsage(
      db,
      tenantId,
      [
        { metric: 'whatsapp.inbound', amount: 5 },
        { metric: 'whatsapp.outbound', amount: 7 },
        { metric: 'whatsapp.template', amount: 10 },
        { metric: 'llm.requests', model: 'gpt-4o-mini', amount: 3 },
        { metric: 'llm.prompt_tokens', model: 'gpt-4o-mini', amount: 2_000_000 },
        { metric: 'llm.completion_tokens', model: 'local-model', amount: 50 },
      ],
      new Date('2031-03-02T09:00:00Z'),
    );
    const data = await loadPlatformConsole('2031-03', { db, now, pricesRaw: undefined });
    const row = data.clinics.find((c) => c.id === tenantId)!;
    expect(row).toMatchObject({ active: true, ownerEmail: expect.stringContaining('@'), members: 1 });
    expect(row.cost.ai).toBeCloseTo(0.3, 6);
    expect(row.cost.whatsapp).toBeCloseTo(0.2, 6);
    expect(row.cost.unpriced).toEqual(['local-model']);
    expect(data.totals).toMatchObject({ active: 1, usage: { inbound: 5, outbound: 7, templates: 10 }, unpriced: ['local-model'] });
    expect(data.pricesError).toBeNull();

    const custom = await loadPlatformConsole('2031-03', { db, now, pricesRaw: '{"whatsapp":{"template":0.05}}' });
    expect(custom.clinics.find((c) => c.id === tenantId)!.cost.whatsapp).toBeCloseTo(0.5, 6);
    expect((await loadPlatformConsole('2031-03', { db, now, pricesRaw: 'no' })).pricesError).toMatch(/JSON/);
  });
});

describe('security fixes (F32)', () => {
  /** Runs `fn` with these environment variables, restoring them afterwards. */
  async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }
  const graph = (status: number, body: unknown) => vi.fn(async (..._args: unknown[]) => Response.json(body, { status }));
  const asFetch = (fn: unknown) => fn as typeof fetch;

  it('asks Meta whether the token reaches the phone_number_id', async () => {
    const ok = graph(200, { display_phone_number: '+34 965 111 444', id: '123' });
    expect(await verifyWhatsAppNumber({ phoneNumberId: '123', accessToken: 'EAAG-token' }, { env: {}, fetchFn: asFetch(ok) })).toEqual({
      ok: true,
      displayPhone: '+34 965 111 444',
    });
    expect(ok).toHaveBeenCalledWith(
      'https://graph.facebook.com/v27.0/123?fields=display_phone_number',
      expect.objectContaining({ headers: { authorization: 'Bearer EAAG-token' } }),
    );
    const fail = (status: number, body: unknown) =>
      verifyWhatsAppNumber({ phoneNumberId: '123', accessToken: 't' }, { env: {}, fetchFn: asFetch(graph(status, body)) });
    expect(await fail(401, { error: { code: 190 } })).toMatchObject({ ok: false, message: expect.stringMatching(/token de acceso/) });
    expect(await fail(400, { error: { code: 100 } })).toMatchObject({ ok: false, message: expect.stringMatching(/no reconoce ese phone_number_id/) });
    expect(await fail(503, {})).toMatchObject({ ok: false, message: expect.stringMatching(/no responde/) });
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await verifyWhatsAppNumber({ phoneNumberId: '1', accessToken: 't' }, { env: {}, fetchFn: asFetch(down) })).toMatchObject({ ok: false });
    expect(await verifyWhatsAppNumber({ phoneNumberId: '1', accessToken: 't' }, { env: { WHATSAPP_MODE: 'mock' }, fetchFn: asFetch(down) })).toEqual({
      ok: true,
      displayPhone: null,
    });
    expect(down).toHaveBeenCalledTimes(1);
  });

  it('a clinic only stores a WhatsApp number that Meta confirms is reachable with its token', async () => {
    const { caller, tenant } = await newOwner('Clínica Número');
    const id = `pnid-${randomUUID()}`;
    const stored = async () => (await getTestDb().tenantConfig.findUniqueOrThrow({ where: { id: tenant.id } })).waPhoneNumberId;
    await withEnv({ WHATSAPP_MODE: 'live', PLATFORM_ADMIN_EMAILS: undefined }, async () => {
      try {
        vi.stubGlobal('fetch', graph(400, { error: { code: 100 } }));
        await expect(caller.tenant.updateWhatsApp({ waPhoneNumberId: id, phoneNormalized: null, waAccessToken: 'EAAG-otra-cuenta' })).rejects.toMatchObject({
          code: 'BAD_REQUEST',
        });
        expect(await stored()).toBeNull();

        // Meta answers with another number than the one typed.
        vi.stubGlobal('fetch', graph(200, { display_phone_number: '+34 965 111 444' }));
        await expect(
          caller.tenant.updateWhatsApp({ waPhoneNumberId: id, phoneNormalized: '965 999 999', waAccessToken: 'EAAG-propio-1234' }),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/\+34 965 111 444/) });
        // Right token and number: stored, and the business number comes from Meta.
        const view = await caller.tenant.updateWhatsApp({ waPhoneNumberId: id, phoneNormalized: null, waAccessToken: 'EAAG-propio-1234' });
        expect(view).toMatchObject({ waPhoneNumberId: id, phoneNormalized: '+34965111444' });
        // Saving again without changing the number or the token asks Meta nothing.
        const unreachable = vi.fn(async () => {
          throw new TypeError('fetch failed');
        });
        vi.stubGlobal('fetch', unreachable);
        await caller.tenant.updateWhatsApp({ waPhoneNumberId: id, phoneNormalized: '965 111 444' });
        expect(unreachable).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  it('without its own token, only a platform administrator assigns the number', async () => {
    const owner = await newOwner('Clínica Sin Token');
    const id = `pnid-${randomUUID()}`;
    await withEnv({ WHATSAPP_MODE: 'live', PLATFORM_ADMIN_EMAILS: 'owner@test.es' }, async () => {
      const unverified = await callerFor({ ...owner.user, emailVerified: false });
      await expect(unverified.tenant.updateWhatsApp({ waPhoneNumberId: id, phoneNormalized: null })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await owner.caller.tenant.updateWhatsApp({ waPhoneNumberId: id, phoneNormalized: null })).toMatchObject({ waPhoneNumberId: id });
    });
    await withEnv({ PLATFORM_ADMIN_EMAILS: undefined }, async () => {
      await expect(owner.caller.tenant.updateWhatsApp({ waPhoneNumberId: `pnid-${randomUUID()}`, phoneNormalized: null })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringMatching(/administrador de la plataforma/),
      });
    });
  });

  it('only a verified email takes an invitation', async () => {
    const owner = await newOwner('Clínica Invita');
    const email = `nueva-${randomUUID().slice(0, 8)}@clinica.test`;
    await owner.caller.team.invite({ email, role: 'admin', employeeId: null });
    const user = { id: `kp_${randomUUID()}`, email };
    await expect((await callerFor({ ...user, emailVerified: false })).tenant.get()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await owner.caller.team.list()).invitations.map((i) => i.email)).toEqual([email]);
    expect((await (await callerFor(user)).tenant.get()).clinicName).toBe('Clínica Invita');
    expect((await owner.caller.team.list()).invitations).toEqual([]);
  });

  it('only administrators book outside a professional schedule; keeping a booking where it is needs no override', async () => {
    const owner = await newOwner('Clínica Horario');
    const ana = await owner.caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const email = `ana-${randomUUID().slice(0, 8)}@clinica.test`;
    await owner.caller.team.invite({ email, role: 'professional', employeeId: ana.id });
    const pro = await callerFor({ id: `kp_${randomUUID()}`, email });
    const client = await owner.caller.clients.create({ name: 'Laura', phone: '611 400 100' });
    const late = { clientId: client.id, employeeId: ana.id, start: at(6, 16), status: 'pending' as const, force: true };

    await expect(pro.appointments.create(late)).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/Solo un administrador/) });
    const forced = (await owner.caller.appointments.create(late))!;
    // The professional can still edit it (notes) while it stays where it is...
    await expect(pro.appointments.update({ ...late, id: forced.id, force: false, notes: 'Trae informe' })).resolves.toBeTruthy();
    // ...but cannot move it to another time outside the schedule.
    await expect(pro.appointments.update({ ...late, id: forced.id, start: at(6, 17), force: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('low findings of the audit (F34)', () => {
  async function clinicWithProfessional(name: string) {
    const owner = await newOwner(name);
    const ana = await owner.caller.employees.create({ name: 'Ana', role: 'fisioterapeuta', schedule: MON_9_14 });
    const luis = await owner.caller.employees.create({ name: 'Luis', role: 'fisioterapeuta', schedule: MON_9_14 });
    const email = `ana-${randomUUID().slice(0, 8)}@clinica.test`;
    await owner.caller.team.invite({ email, role: 'professional', employeeId: ana.id });
    const anaUser = { id: `kp_${randomUUID()}`, email };
    return { owner, ana, luis, email, anaUser, pro: await callerFor(anaUser) };
  }

  it('a professional only learns about their own agenda when checking availability', async () => {
    const { owner, ana, luis, pro } = await clinicWithProfessional('Clínica Disponibilidad');
    await expect(pro.appointments.checkAvailability({ start: at(6, 10), employeeId: luis.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await pro.appointments.checkAvailability({ start: at(6, 10) })).availableEmployeeIds).toEqual([ana.id]);
    expect((await owner.caller.appointments.checkAvailability({ start: at(6, 10) })).availableEmployeeIds.sort()).toEqual([ana.id, luis.id].sort());
  });

  it('an invitation expires after 14 days; inviting the same email again replaces it', async () => {
    const owner = await newOwner('Clínica Caducidad');
    const email = `vieja-${randomUUID().slice(0, 8)}@clinica.test`;
    const { id } = await owner.caller.team.invite({ email, role: 'admin', employeeId: null });
    await getTestDb().tenantInvitation.update({ where: { id }, data: { createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) } });
    expect((await owner.caller.team.list()).invitations).toEqual([expect.objectContaining({ email, expired: true })]);
    const user = { id: `kp_${randomUUID()}`, email };
    await expect((await callerFor(user)).tenant.get()).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await owner.caller.team.invite({ email, role: 'admin', employeeId: null });
    expect((await owner.caller.team.list()).invitations).toEqual([expect.objectContaining({ email, expired: false })]);
    expect((await (await callerFor(user)).tenant.get()).clinicName).toBe('Clínica Caducidad');
  });

  it('anyone but the owner can leave the clinic, and then create their own', async () => {
    const { owner, anaUser, pro } = await clinicWithProfessional('Clínica Salida');
    await expect(owner.caller.team.leave()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await pro.team.leave()).toEqual({ ok: true });
    const after = await callerFor(anaUser);
    await expect(after.tenant.get()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await owner.caller.team.list()).members.map((m) => m.role)).toEqual(['owner']);
    await expect(after.tenant.onboarding({ clinicName: 'Fisio Propia', contactPhone: '965 000 111' })).resolves.toMatchObject({ clinicName: 'Fisio Propia' });
  });

  it('the calendar lists accept at most 100 days', async () => {
    const { caller } = await newOwner('Clínica Rango');
    await expect(caller.appointments.list({ from: at(1, 0), to: new Date(at(1, 0).getTime() + 120 * 24 * 60 * 60 * 1000) })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.timeOff.list({ from: at(1, 0), to: new Date(at(1, 0).getTime() + 120 * 24 * 60 * 60 * 1000) })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.appointments.list({ from: at(1, 0), to: new Date(at(1, 0).getTime() + 99 * 24 * 60 * 60 * 1000) })).resolves.toEqual([]);
  });
});
