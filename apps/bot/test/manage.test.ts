/**
 * F13 — clients manage their existing appointments from WhatsApp (see, cancel, change date).
 * Fixed clock: Tuesday 6 May 2025, 09:15 Europe/Madrid.
 */
import { createAppointment, createClient, createEmployee, createTenant, uniquePhone } from '@clinicai/db/testing';
import { zonedTimeToUtc, type ScheduleSlot } from '@clinicai/shared';
import { describe, expect, it } from 'vitest';
import { createConversationEngine } from '../src/engine/engine';
import { detectManageRequest } from '../src/engine/matching';
import { CANCEL_ID } from '../src/flows/employeeFlow';
import { CONFIRM_EXIT, CONFIRM_YES } from '../src/flows/confirmationFlow';
import {
  MANAGE_CANCEL,
  MANAGE_CANCEL_YES,
  MANAGE_CHANGE,
  MANAGE_KEEP,
  MANAGE_LIST_ID,
  MANAGE_PICK,
  NEW_BOOKING_ID,
} from '../src/flows/manageFlow';
import type { AIService } from '../src/services/aiServices';
import { createMockAIService } from '../src/services/mockAi';
import { Chat, joined, optionIds } from './chat';
import { createTestDeps, getTestDb } from './helpers';

const TZ = 'Europe/Madrid';
const at = (d: number, h: number, mi = 0) => zonedTimeToUtc({ year: 2025, month: 5, day: d, hour: h, minute: mi }, TZ);
const WEEKDAYS_9_14: ScheduleSlot[] = (['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const).map((day) => ({
  day,
  start: '09:00',
  end: '14:00',
}));

async function setup(options: { minNoticeHours?: number } = {}) {
  const db = getTestDb();
  let llmCalls = 0;
  const mock = createMockAIService();
  const ai: AIService = {
    ...mock,
    detectIntent: (...args) => ((llmCalls += 1), mock.detectIntent(...args)),
    answerFaq: (...args) => ((llmCalls += 1), mock.answerFaq(...args)),
    parseDate: (...args) => mock.parseDate(...args),
  };
  const deps = createTestDeps({ overrides: { ai } });
  const tenantRow = await createTenant(db, {
    clinicName: 'Fisio Cambios',
    settings: {
      contactPhone: '965 000 000',
      slotMinutes: 60,
      ...(options.minNoticeHours === undefined ? {} : { minNoticeHours: options.minNoticeHours }),
    },
  });
  const ana = await createEmployee(db, tenantRow.id, { name: 'Ana', schedule: WEEKDAYS_9_14 });
  const luis = await createEmployee(db, tenantRow.id, { name: 'Luis', schedule: WEEKDAYS_9_14 });
  const phone = uniquePhone();
  const client = await createClient(db, tenantRow.id, { name: 'Laura Martínez', phone });
  const tenant = (await deps.systemRepos.tenants.findById(tenantRow.id))!;
  const chat = new Chat(deps, createConversationEngine(deps), tenant, phone);
  const book = (date: Date, extra: { employeeId?: string; status?: 'pending' | 'confirmed' | 'cancelled'; clientId?: string } = {}) =>
    createAppointment(db, {
      tenantId: tenant.id,
      clientId: extra.clientId ?? client.id,
      employeeId: extra.employeeId ?? ana.id,
      date,
      ...(extra.status ? { status: extra.status } : {}),
    });
  return { db, deps, tenant, ana, luis, client, chat, book, llmCalls: () => llmCalls };
}

describe('detectManageRequest (rules, no LLM)', () => {
  it('recognises requests about existing appointments and leaves new bookings and FAQs alone', () => {
    expect(detectManageRequest('Quiero cancelar mi cita')).toBe('cancel');
    expect(detectManageRequest('¿Podéis anularla? Ya no me hace falta la sesión')).toBe('cancel');
    expect(detectManageRequest('Necesito cambiar la cita del jueves')).toBe('change');
    expect(detectManageRequest('¿Puedo mover mi sesión al viernes?')).toBe('change');
    expect(detectManageRequest('Tengo cita mañana pero quiero aplazarla')).toBe('change');
    expect(detectManageRequest('mis citas')).toBe('list');
    expect(detectManageRequest('¿Cuándo tengo cita?')).toBe('list');
    expect(detectManageRequest('No podré ir el jueves')).toBe('list');
    expect(detectManageRequest('Cancelar o cambiar mi cita')).toBe('list');
    expect(detectManageRequest('Quiero pedir cita para mañana a las 10')).toBeNull();
    expect(detectManageRequest('¿Cuánto cuesta una sesión?')).toBeNull();
    expect(detectManageRequest('Quiero cambiar de fisioterapeuta')).toBeNull();
    // A bare "cancelar" is the global escape word, handled by the engine.
    expect(detectManageRequest('cancelar')).toBeNull();
  });
});

describe('F13 — "Mis citas" from the greeting', () => {
  it('offers the shortcut only to clients with upcoming appointments and shows the appointment', async () => {
    const ctx = await setup();
    const appt = await ctx.book(at(8, 12));
    const greeting = await ctx.chat.say('Hola');
    expect(joined(greeting)).toContain('¿En qué puedo ayudarte hoy? Tienes 1 cita próxima.');
    expect(optionIds(greeting)).toEqual([MANAGE_LIST_ID, NEW_BOOKING_ID]);

    const shown = await ctx.chat.press(MANAGE_LIST_ID, 'Mis citas');
    expect(joined(shown)).toContain(
      'Tu próxima cita:\n📅 jueves, 8 de mayo de 2025, 12:00\n👤 Ana\n📌 Pendiente\n\n¿Qué quieres hacer?',
    );
    expect(optionIds(shown)).toEqual([`${MANAGE_CHANGE}${appt.id}`, `${MANAGE_CANCEL}${appt.id}`, MANAGE_KEEP]);
    expect(joined(await ctx.chat.press(MANAGE_KEEP, 'Nada, gracias'))).toBe(
      'Perfecto, la dejamos como está. ¿Te puedo ayudar en algo más?',
    );

    // "Pedir cita" goes straight to the date question.
    await ctx.deps.systemRepos.conversations.clear(ctx.tenant.id, ctx.chat.phone);
    await ctx.chat.say('Hola');
    expect(joined(await ctx.chat.press(NEW_BOOKING_ID, 'Pedir cita'))).toContain('Por favor, indícame la fecha para tu cita en Fisio Cambios');
    expect(ctx.llmCalls()).toBe(0);
  });

  it('lists several appointments (no past or cancelled ones) and acts on the chosen one', async () => {
    const ctx = await setup();
    await ctx.book(at(5, 10)); // past
    await ctx.book(at(7, 10), { status: 'cancelled' });
    const first = await ctx.book(at(8, 12));
    const second = await ctx.book(at(13, 9), { employeeId: ctx.luis.id, status: 'confirmed' });
    const list = await ctx.chat.say('¿Qué citas tengo?');
    expect(joined(list)).toContain('Estas son tus próximas citas. Elige una para cambiarla o cancelarla:');
    expect(optionIds(list)).toEqual([`${MANAGE_PICK}${first.id}`, `${MANAGE_PICK}${second.id}`]);
    expect(joined(list)).toContain('con Luis · Confirmada');

    const chosen = await ctx.chat.pick(`${MANAGE_PICK}${second.id}`, 'mar 13 may 09:00');
    expect(joined(chosen)).toContain('📅 martes, 13 de mayo de 2025, 09:00');
    expect(optionIds(chosen)).toEqual([`${MANAGE_CHANGE}${second.id}`, `${MANAGE_CANCEL}${second.id}`, MANAGE_KEEP]);
  });
});

describe('F13 — cancel', () => {
  it('cancels after confirmation, without the LLM, and the appointment disappears from the list', async () => {
    const ctx = await setup();
    const appt = await ctx.book(at(8, 12));
    const question = await ctx.chat.say('Hola, quiero cancelar mi cita');
    expect(joined(question)).toContain('¿Seguro que quieres cancelar tu cita del jueves, 8 de mayo de 2025, 12:00 con Ana?');
    expect(optionIds(question)).toEqual([`${MANAGE_CANCEL_YES}${appt.id}`, MANAGE_KEEP]);

    expect(joined(await ctx.chat.press(`${MANAGE_CANCEL_YES}${appt.id}`, 'Sí, cancelarla'))).toBe(
      '✅ Tu cita del jueves, 8 de mayo de 2025, 12:00 ha quedado cancelada. Si quieres pedir otra, dime qué día y a qué hora te viene bien.',
    );
    expect((await ctx.deps.systemRepos.appointments.findById(ctx.tenant.id, appt.id))?.status).toBe('cancelled');
    expect(joined(await ctx.chat.say('mis citas'))).toBe(
      'No tienes ninguna cita próxima. Si quieres pedir una, dime qué día y a qué hora te viene bien.',
    );
    expect(ctx.llmCalls()).toBe(0);
  });

  it('accepts a typed "sí" and keeps the appointment with "no"', async () => {
    const ctx = await setup();
    const appt = await ctx.book(at(8, 12));
    await ctx.chat.say('Quiero anular la cita');
    expect(joined(await ctx.chat.say('No'))).toBe('Perfecto, la dejamos como está. ¿Te puedo ayudar en algo más?');
    expect((await ctx.deps.systemRepos.appointments.findById(ctx.tenant.id, appt.id))?.status).toBe('pending');
    await ctx.chat.say('Quiero anular la cita');
    expect(joined(await ctx.chat.say('Sí'))).toContain('ha quedado cancelada');
    expect((await ctx.deps.systemRepos.appointments.findById(ctx.tenant.id, appt.id))?.status).toBe('cancelled');
  });
});

describe('F13 — change date', () => {
  it('moves the same appointment: new date, back to pending, new reminder, notes kept', async () => {
    const ctx = await setup();
    const appt = await ctx.book(at(8, 12));
    await ctx.db.appointment.update({
      where: { id: appt.id },
      data: { status: 'confirmed', reminderSentAt: at(7, 8), notes: 'Trae el informe' },
    });

    // First message of the conversation: the greeting comes first, then the answer.
    expect(joined(await ctx.chat.say('Necesito cambiar la cita'))).toContain(
      'Tu cita actual es el jueves, 8 de mayo de 2025, 12:00 con Ana. ¿Qué día y a qué hora te vendría mejor?',
    );
    const options = await ctx.chat.say('el viernes a las 11');
    expect(joined(options)).toContain('viernes, 9 de mayo de 2025, 11:00 está disponible');
    const summary = await ctx.chat.press(`EMP:${ctx.luis.id}`, 'Luis');
    expect(joined(summary)).toContain('🔁 Cambio de cita');
    expect(joined(summary)).toContain('¿Confirmas el cambio, prefieres otra fecha o lo dejas como estaba?');

    expect(joined(await ctx.chat.press(CONFIRM_YES, 'Sí ✅'))).toBe(
      '✅ ¡Hecho! Tu cita en Fisio Cambios ahora es el viernes, 9 de mayo de 2025, 11:00.',
    );
    const moved = await ctx.deps.systemRepos.appointments.findById(ctx.tenant.id, appt.id);
    expect(moved).toMatchObject({ status: 'pending', reminderSentAt: null, notes: 'Trae el informe', employeeId: ctx.luis.id });
    expect(moved?.date).toEqual(at(9, 11));
    expect(await ctx.db.appointment.count({ where: { clientId: ctx.client.id } })).toBe(1);
  });

  it('keeps the original appointment when the new slot is taken meanwhile, then retries', async () => {
    const ctx = await setup();
    const appt = await ctx.book(at(8, 12));
    await ctx.chat.say('Quiero mover mi cita');
    await ctx.chat.say('el viernes a las 11');
    await ctx.chat.press(`EMP:${ctx.ana.id}`, 'Ana');
    // Someone else books Ana at that time before the client confirms.
    const other = await createClient(ctx.db, ctx.tenant.id, { name: 'Otro Cliente' });
    await ctx.book(at(9, 11), { clientId: other.id });

    expect(joined(await ctx.chat.press(CONFIRM_YES, 'Sí ✅'))).toBe(
      'Lo siento, ese hueco acaba de ocuparse 😕. Tu cita sigue el jueves, 8 de mayo de 2025, 12:00. Indícame otra fecha, por ejemplo "mañana a las 10".',
    );
    expect((await ctx.deps.systemRepos.appointments.findById(ctx.tenant.id, appt.id))?.date).toEqual(at(8, 12));

    // Still a change (not a new booking): the next date moves the same appointment.
    await ctx.chat.say('el viernes a las 12');
    await ctx.chat.press(`EMP:${ctx.ana.id}`, 'Ana');
    expect(joined(await ctx.chat.press(CONFIRM_YES, 'Sí ✅'))).toContain('ahora es el viernes, 9 de mayo de 2025, 12:00');
    expect((await ctx.deps.systemRepos.appointments.findById(ctx.tenant.id, appt.id))?.date).toEqual(at(9, 12));
    expect(await ctx.db.appointment.count({ where: { clientId: ctx.client.id } })).toBe(1);
  });

  it('"Cancelar" or "Salir" during the change leaves the appointment as it was', async () => {
    const ctx = await setup();
    const appt = await ctx.book(at(8, 12));
    await ctx.chat.say('Quiero cambiar la cita');
    await ctx.chat.say('el viernes a las 11');
    expect(joined(await ctx.chat.press(CANCEL_ID, 'Cancelar'))).toBe('De acuerdo, no cambiamos nada: tu cita sigue como estaba.');

    await ctx.chat.say('Quiero cambiar la cita');
    await ctx.chat.say('el viernes a las 11');
    await ctx.chat.press(`EMP:${ctx.ana.id}`, 'Ana');
    expect(joined(await ctx.chat.press(CONFIRM_EXIT, 'Salir'))).toBe('De acuerdo, no cambiamos nada: tu cita sigue como estaba.');
    expect(await ctx.deps.systemRepos.appointments.findById(ctx.tenant.id, appt.id)).toMatchObject({ date: at(8, 12), status: 'pending' });
  });
});

describe('F13 — limits', () => {
  it('within the minimum notice it neither cancels nor changes, and gives the clinic phone', async () => {
    const ctx = await setup();
    const today = await ctx.book(at(6, 12)); // in 2 h 45 min, default notice 24 h
    const tooLate =
      'Lo siento, por aquí solo se pueden cancelar o cambiar las citas con al menos 24 h de antelación. Para hacerlo ahora, contacta con Fisio Cambios en el 965 000 000.';
    expect(joined(await ctx.chat.say('Quiero cancelar mi cita'))).toContain(tooLate);
    expect(joined(await ctx.chat.say('Quiero cambiar mi cita'))).toBe(tooLate);
    expect(await ctx.deps.systemRepos.appointments.findById(ctx.tenant.id, today.id)).toMatchObject({ status: 'pending', date: at(6, 12) });

    const noLimit = await setup({ minNoticeHours: 0 });
    const soon = await noLimit.book(at(6, 12));
    await noLimit.chat.say('Quiero cancelar mi cita');
    expect(joined(await noLimit.chat.press(`${MANAGE_CANCEL_YES}${soon.id}`, 'Sí, cancelarla'))).toContain('ha quedado cancelada');
  });

  it('without upcoming appointments it says so and lets the client book', async () => {
    const ctx = await setup();
    expect(joined(await ctx.chat.say('Quiero cambiar mi cita'))).toContain(
      'No tienes ninguna cita próxima. Si quieres pedir una, dime qué día y a qué hora te viene bien.',
    );
    expect(joined(await ctx.chat.say('Hola'))).not.toContain('Tienes');
  });

  it('never touches appointments of other clients, even with forged buttons', async () => {
    const ctx = await setup();
    await ctx.book(at(8, 12));
    const other = await createClient(ctx.db, ctx.tenant.id, { name: 'Otra Persona' });
    const foreign = await ctx.book(at(8, 13), { clientId: other.id });
    await ctx.chat.say('mis citas');
    expect(joined(await ctx.chat.press(`${MANAGE_CANCEL_YES}${foreign.id}`, 'Sí, cancelarla'))).toBe(
      'Esa cita ya no se puede modificar: puede que se haya cancelado o que ya haya pasado.',
    );
    await ctx.chat.say('mis citas');
    expect(joined(await ctx.chat.press(`${MANAGE_CHANGE}${foreign.id}`, 'Cambiar fecha'))).toContain('ya no se puede modificar');
    expect((await ctx.deps.systemRepos.appointments.findById(ctx.tenant.id, foreign.id))?.status).toBe('pending');
  });
});
