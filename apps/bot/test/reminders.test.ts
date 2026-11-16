/**
 * RF-W4 / CU-C8 / CU-C9 with a fixed clock: Tuesday 6 May 2025, 09:15 Europe/Madrid.
 */
import { bookAppointment } from '@clinicai/db';
import { createAppointment, createClient, createEmployee, createTenant, uniquePhone } from '@clinicai/db/testing';
import { zonedTimeToUtc } from '@clinicai/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createConversationEngine } from '../src/engine/engine';
import { checkAndSendReminders } from '../src/jobs/reminders';
import { registerJobRoutes } from '../src/jobs/routes';
import type { WhatsAppClient } from '../src/services/whatsapp';
import { Chat, joined, optionIds } from './chat';
import { CRON_SECRET, createTestDeps, getTestDb } from './helpers';

const TZ = 'Europe/Madrid';
const at = (d: number, h: number) => zonedTimeToUtc({ year: 2025, month: 5, day: d, hour: h }, TZ);

async function scenario(
  settings: { reminderHour?: string; reminderDaysBefore?: number; secondReminderHours?: number | null } = {},
  now?: string,
) {
  const db = getTestDb();
  const deps = createTestDeps(now ? { now } : {});
  const tenantRow = await createTenant(db, { clinicName: 'Fisio Recuerda', settings });
  const employee = await createEmployee(db, tenantRow.id, { name: 'Ana' });
  const phone = uniquePhone();
  const client = await createClient(db, tenantRow.id, { name: 'Laura Martínez', phone });
  const base = { tenantId: tenantRow.id, clientId: client.id, employeeId: employee.id };
  const tenant = (await deps.systemRepos.tenants.findById(tenantRow.id))!;
  return { db, deps, tenant, client, employee, phone, base };
}

describe('checkAndSendReminders (CU-C8)', () => {
  it('sends the template only for pending appointments of tomorrow, once', async () => {
    const { db, deps, tenant, base, phone } = await scenario();
    const due = await createAppointment(db, { ...base, date: at(7, 10) });
    await createAppointment(db, { ...base, date: at(7, 12), status: 'confirmed' });
    await createAppointment(db, { ...base, date: at(7, 13), status: 'cancelled' });
    await createAppointment(db, { ...base, date: at(6, 16) }); // today
    await createAppointment(db, { ...base, date: at(8, 10) }); // day after tomorrow
    await createAppointment(db, { ...base, date: at(7, 16), reminderSentAt: at(5, 8) }); // already reminded

    const first = await checkAndSendReminders(deps, { tenantId: tenant.id });
    expect(first).toMatchObject({ sent: 1, failed: 0 });
    expect(deps.whatsapp.outbox).toHaveLength(1);
    const sent = deps.whatsapp.outbox[0]!;
    expect(sent.to).toBe(phone);
    expect(sent.message).toMatchObject({
      type: 'template',
      name: 'recordatorio_cita',
      language: 'es',
      bodyParams: ['Laura', 'Fisio Recuerda', 'miércoles, 7 de mayo', '10:00'],
      quickReplyPayloads: [`REMINDER_CONFIRM:${due.id}`, `REMINDER_CANCEL:${due.id}`],
    });
    expect(joined([sent.message])).toContain('Hola Laura, te recordamos tu cita en Fisio Recuerda el miércoles, 7 de mayo a las 10:00.');
    const updated = await deps.systemRepos.appointments.findById(tenant.id, due.id);
    expect(updated?.reminderSentAt?.toISOString()).toBe(deps.clock.now().toISOString());

    const second = await checkAndSendReminders(deps, { tenantId: tenant.id });
    expect(second.sent).toBe(0);
    expect(deps.whatsapp.outbox).toHaveLength(1);
  });

  it('respects the tenant reminder hour unless forced', async () => {
    const { db, deps, tenant, base } = await scenario({ reminderHour: '10:00' });
    await createAppointment(db, { ...base, date: at(7, 10) });
    expect(await checkAndSendReminders(deps, { tenantId: tenant.id })).toMatchObject({ sent: 0, skipped: 1 });
    expect(await checkAndSendReminders(deps, { tenantId: tenant.id, force: true })).toMatchObject({ sent: 1 });
  });

  it('releases the claim when WhatsApp fails, so a later run retries', async () => {
    const { db, deps, tenant, base } = await scenario();
    const appt = await createAppointment(db, { ...base, date: at(7, 10) });
    const failing: WhatsAppClient = {
      ...deps.whatsapp,
      send: async () => {
        throw new Error('meta down');
      },
    };
    const result = await checkAndSendReminders({ ...deps, whatsapp: failing }, { tenantId: tenant.id });
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect((await deps.systemRepos.appointments.findById(tenant.id, appt.id))?.reminderSentAt).toBeNull();
    expect(await checkAndSendReminders(deps, { tenantId: tenant.id })).toMatchObject({ sent: 1 });
  });

  it('uses the tenant time zone to decide what "tomorrow" is', async () => {
    const db = getTestDb();
    const deps = createTestDeps({ now: '2025-05-06T23:30:00Z' }); // 01:30 Wed in Madrid, 19:30 Tue in New York
    const tenantRow = await createTenant(db, { timezone: 'America/New_York', settings: { reminderHour: '08:00' } });
    const employee = await createEmployee(db, tenantRow.id);
    const client = await createClient(db, tenantRow.id);
    const nyTomorrow = zonedTimeToUtc({ year: 2025, month: 5, day: 7, hour: 10 }, 'America/New_York');
    await createAppointment(db, { tenantId: tenantRow.id, clientId: client.id, employeeId: employee.id, date: nyTomorrow });
    expect(await checkAndSendReminders(deps, { tenantId: tenantRow.id })).toMatchObject({ sent: 1 });
  });
});

describe('POST /jobs/reminders/run', () => {
  it('requires the x-cron-secret header', async () => {
    const { deps, tenant, db, base } = await scenario();
    await createAppointment(db, { ...base, date: at(7, 11) });
    const app = buildApp(deps, { register: (i) => registerJobRoutes(i, deps) });
    const denied = await app.inject({ method: 'POST', url: '/jobs/reminders/run' });
    expect(denied.statusCode).toBe(401);
    const wrong = await app.inject({ method: 'POST', url: '/jobs/reminders/run', headers: { 'x-cron-secret': 'nope' } });
    expect(wrong.statusCode).toBe(401);
    const ok = await app.inject({
      method: 'POST',
      url: '/jobs/reminders/run',
      headers: { 'x-cron-secret': CRON_SECRET, 'content-type': 'application/json' },
      payload: JSON.stringify({ tenantId: tenant.id }),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ sent: 1, failed: 0 });
    await app.close();
  });
});

describe('reminderResponseFlow (CU-C9)', () => {
  async function remindedChat() {
    const s = await scenario();
    const appt = await createAppointment(s.db, { ...s.base, date: at(7, 10) });
    await checkAndSendReminders(s.deps, { tenantId: s.tenant.id });
    const chat = new Chat(s.deps, createConversationEngine(s.deps), s.tenant, s.phone);
    return { ...s, appt, chat };
  }

  it('"Sí, confirmo" confirms the appointment', async () => {
    const { chat, appt, deps, tenant } = await remindedChat();
    expect(joined(await chat.templateReply(`REMINDER_CONFIRM:${appt.id}`, 'Sí, confirmo'))).toBe(
      '¡Gracias! Tu cita en Fisio Recuerda ha sido confirmada ✅. ¡Nos vemos mañana!',
    );
    expect((await deps.systemRepos.appointments.findById(tenant.id, appt.id))?.status).toBe('confirmed');
  });

  it('"No puedo asistir" cancels it, and a second cancel says it already was', async () => {
    const { chat, appt, deps, tenant } = await remindedChat();
    expect(joined(await chat.templateReply(`REMINDER_CANCEL:${appt.id}`, 'No puedo asistir'))).toBe(
      'Tu cita ha sido cancelada. Si quieres reservar otra, escríbeme cuando quieras.',
    );
    expect((await deps.systemRepos.appointments.findById(tenant.id, appt.id))?.status).toBe('cancelled');
    expect(joined(await chat.templateReply(`REMINDER_CONFIRM:${appt.id}`, 'Sí, confirmo'))).toBe(
      'Esta cita ya estaba cancelada. Si quieres reservar otra, escríbeme cuando quieras.',
    );
  });

  it('the buttons of an old reminder do nothing once the appointment has started (F32)', async () => {
    const { appt, deps, tenant, phone } = await remindedChat();
    // Wednesday 7 May, 11:30 in Madrid: the 10:00 appointment has passed.
    const later = createTestDeps({ now: '2025-05-07T09:30:00Z' });
    const chat = new Chat(later, createConversationEngine(later), tenant, phone);
    for (const [payload, title] of [[`REMINDER_CANCEL:${appt.id}`, 'No puedo asistir'], [`REMINDER_CONFIRM:${appt.id}`, 'Sí, confirmo']] as const) {
      expect(joined(await chat.templateReply(payload, title))).toBe(
        'Esa cita ya ha pasado, así que no he cambiado nada. Si quieres reservar otra, escríbeme cuando quieras.',
      );
    }
    expect((await deps.systemRepos.appointments.findById(tenant.id, appt.id))?.status).toBe('pending');
  });

  it('a late confirmation never brings back an appointment cancelled meanwhile (F32)', async () => {
    const { appt, deps, tenant } = await remindedChat();
    const repo = deps.systemRepos.appointments;
    await repo.setStatus(tenant.id, appt.id, 'cancelled');
    expect(await repo.setStatus(tenant.id, appt.id, 'confirmed', { from: ['pending'] })).toBe(false);
    expect((await repo.findById(tenant.id, appt.id))?.status).toBe('cancelled');
    expect(await repo.setStatus(tenant.id, appt.id, 'pending')).toBe(true);
    expect(await repo.setStatus(tenant.id, appt.id, 'confirmed', { from: ['pending'] })).toBe(true);
  });

  it('cannot confirm an appointment of another phone or tenant', async () => {
    const { appt } = await remindedChat();
    const other = await scenario();
    const intruder = new Chat(other.deps, createConversationEngine(other.deps), other.tenant, other.phone);
    expect(joined(await intruder.templateReply(`REMINDER_CONFIRM:${appt.id}`, 'Sí, confirmo'))).toBe(
      'No he encontrado esa cita. Si necesitas ayuda, escríbeme cuando quieras.',
    );
    expect((await other.deps.systemRepos.appointments.findById(appt.tenantId, appt.id))?.status).toBe('pending');
  });

  it('interprets free-text answers within 24 h', async () => {
    const { chat, appt, deps, tenant } = await remindedChat();
    expect(joined(await chat.say('Sí, allí estaré'))).toContain('ha sido confirmada ✅');
    expect((await deps.systemRepos.appointments.findById(tenant.id, appt.id))?.status).toBe('confirmed');
  });

  it('cancels with "no podré ir" in free text', async () => {
    const { chat, appt, deps, tenant } = await remindedChat();
    expect(joined(await chat.say('Lo siento, no podré ir'))).toContain('Tu cita ha sido cancelada');
    expect((await deps.systemRepos.appointments.findById(tenant.id, appt.id))?.status).toBe('cancelled');
  });

  it('re-sends the buttons when a short answer is ambiguous', async () => {
    const { chat, appt } = await remindedChat();
    const replies = await chat.say('¿Cómo?');
    expect(joined(replies)).toBe(
      '¿Puedes confirmarme si asistirás a tu cita en Fisio Recuerda mañana a las 10:00?\n[Sí, confirmo] [No puedo asistir]',
    );
    expect(optionIds(replies)).toEqual([`REMINDER_CONFIRM:${appt.id}`, `REMINDER_CANCEL:${appt.id}`]);
    expect(joined(await chat.say('vale, confirmo'))).toContain('ha sido confirmada ✅');
  });

  it('after 24 h a text message follows the normal routing', async () => {
    const { chat, deps } = await remindedChat();
    deps.clock.advance(25 * 60 * 60 * 1000);
    expect(joined(await chat.say('Sí'))).toContain('Bienvenido/a de nuevo a Fisio Recuerda');
  });
});

describe('configurable reminders (F30)', () => {
  /** The appointment was booked long before (the test database stamps the real date). */
  const bookedEarly = (db: ReturnType<typeof getTestDb>, id: string) =>
    db.appointment.update({ where: { id }, data: { createdAt: at(1, 8) } });
  const atMin = (d: number, h: number, minute: number) => zonedTimeToUtc({ year: 2025, month: 5, day: d, hour: h, minute }, TZ);

  it('the first reminder can go two days before (and still reaches tomorrow)', async () => {
    const { db, deps, tenant, base } = await scenario({ reminderDaysBefore: 2 });
    const tomorrow = await createAppointment(db, { ...base, date: at(7, 10) });
    const twoDays = await createAppointment(db, { ...base, date: at(8, 10) });
    await createAppointment(db, { ...base, date: at(9, 10) });
    expect(await checkAndSendReminders(deps, { tenantId: tenant.id })).toMatchObject({ sent: 2, second: 0 });
    expect(deps.whatsapp.outbox.map((e) => (e.message as { quickReplyPayloads: string[] }).quickReplyPayloads[0])).toEqual([
      `REMINDER_CONFIRM:${tomorrow.id}`,
      `REMINDER_CONFIRM:${twoDays.id}`,
    ]);
  });

  it('the second reminder goes the same day, hours before, to appointments booked before that', async () => {
    // Tuesday 6 May, 09:15; second reminder 2 hours before.
    const { db, deps, tenant, base } = await scenario({ reminderHour: '18:00', secondReminderHours: 2 });
    const confirmed = await createAppointment(db, { ...base, date: at(6, 11), status: 'confirmed' });
    const pending = await createAppointment(db, { ...base, date: atMin(6, 10, 30) });
    const later = await createAppointment(db, { ...base, date: at(6, 12) });
    const cancelled = await createAppointment(db, { ...base, date: at(6, 11), status: 'cancelled' });
    for (const a of [confirmed, pending, later, cancelled]) await bookedEarly(db, a.id);
    // Booked at 9:00 for 10:00: within the margin, no reminder.
    const lastMinute = await createAppointment(db, { ...base, date: at(6, 10) });
    await db.appointment.update({ where: { id: lastMinute.id }, data: { createdAt: at(6, 9) } });

    const run = await checkAndSendReminders(deps, { tenantId: tenant.id });
    expect(run).toMatchObject({ sent: 0, second: 2, failed: 0 });
    expect(deps.whatsapp.outbox.map((e) => (e.message as { quickReplyPayloads: string[] }).quickReplyPayloads[0])).toEqual([
      `REMINDER_CONFIRM:${pending.id}`,
      `REMINDER_CONFIRM:${confirmed.id}`,
    ]);
    expect(joined([deps.whatsapp.outbox[0]!.message])).toContain('el martes, 6 de mayo a las 10:30');
    expect(await checkAndSendReminders(deps, { tenantId: tenant.id })).toMatchObject({ second: 0 });
  });

  it('nothing goes before 8:00 or after 21:00', async () => {
    // 07:30 in Madrid (CEST): the 9:00 appointment waits until 8:00.
    const early = await scenario({ secondReminderHours: 2 }, '2025-05-06T05:30:00Z');
    const appt = await createAppointment(early.db, { ...early.base, date: at(6, 9) });
    await bookedEarly(early.db, appt.id);
    expect(await checkAndSendReminders(early.deps, { tenantId: early.tenant.id })).toMatchObject({ second: 0, skipped: 1 });
    const eight = createTestDeps({ now: '2025-05-06T06:00:00Z' });
    expect(await checkAndSendReminders(eight, { tenantId: early.tenant.id })).toMatchObject({ second: 1 });

    // 21:30: tomorrow's reminder (hour 08:00) is not sent at night.
    const late = await scenario({}, '2025-05-06T19:30:00Z');
    await createAppointment(late.db, { ...late.base, date: at(7, 10) });
    expect(await checkAndSendReminders(late.deps, { tenantId: late.tenant.id })).toMatchObject({ sent: 0, skipped: 1 });
  });

  it('a text answer after the second reminder applies to that appointment, also if it was confirmed', async () => {
    const { db, deps, tenant, base, phone } = await scenario({ reminderHour: '18:00', secondReminderHours: 2 });
    const appt = await createAppointment(db, { ...base, date: at(6, 11), status: 'confirmed' });
    await bookedEarly(db, appt.id);
    await checkAndSendReminders(deps, { tenantId: tenant.id });
    const chat = new Chat(deps, createConversationEngine(deps), tenant, phone);
    expect(joined(await chat.say('Lo siento, no podré ir'))).toContain('Tu cita ha sido cancelada');
    expect((await deps.systemRepos.appointments.findById(tenant.id, appt.id))?.status).toBe('cancelled');
  });

  it('moving an appointment arms both reminders again; the cron runs every 15 minutes', async () => {
    const { db, tenant, base, employee } = await scenario({ secondReminderHours: 2 });
    const appt = await createAppointment(db, { ...base, date: at(7, 10) });
    await db.appointment.update({ where: { id: appt.id }, data: { reminderSentAt: at(6, 8), secondReminderSentAt: at(6, 8) } });
    await bookAppointment(db, tenant.id, { appointmentId: appt.id, clientId: base.clientId, employeeId: employee.id, start: at(8, 10), durationMinutes: 60, source: 'web' });
    expect(await db.appointment.findUniqueOrThrow({ where: { id: appt.id } })).toMatchObject({ reminderSentAt: null, secondReminderSentAt: null });
    expect(loadConfig({ DATABASE_URL: 'postgresql://x/y', WHATSAPP_MODE: 'mock', LLM_MODE: 'mock' }).REMINDER_CRON).toBe('*/15 * * * *');
  });
});
