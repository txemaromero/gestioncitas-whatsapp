/**
 * End-to-end conversations against the engine (mock WhatsApp + rule-based LLM + real DB).
 * Fixed clock: Tuesday 6 May 2025, 09:15 Europe/Madrid.
 */
import { createAppointment, createClient, createEmployee, createTenant, uniquePhone } from '@clinicai/db/testing';
import { PRIVACY_NOTICE_VERSION, zonedTimeToUtc, type ScheduleSlot } from '@clinicai/shared';
import { describe, expect, it } from 'vitest';
import { createConversationEngine } from '../src/engine/engine';
import { createSilentLogger } from '../src/logger';
import { AIUnavailableError, createAIService, type AIService } from '../src/services/aiServices';
import { createMockAIService } from '../src/services/mockAi';
import { Chat, joined, optionIds } from './chat';
import { createTestDeps, getTestDb, testConfig, type TestDeps } from './helpers';

const TZ = 'Europe/Madrid';
const at = (d: number, h: number, mi = 0) => zonedTimeToUtc({ year: 2025, month: 5, day: d, hour: h, minute: mi }, TZ);
const WEEKDAYS_9_14: ScheduleSlot[] = (['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const).map((day) => ({
  day,
  start: '09:00',
  end: '14:00',
}));
const FAQ_PROMPT = [
  'Actúas como recepcionista virtual de Fisio Test.',
  'Teléfono: 965 000 000',
  'Horario: lunes a viernes, de 9:00 a 14:00',
].join('\n');

async function setup(options: { employees?: number; ai?: AIService; deps?: Partial<TestDeps> } = {}) {
  const db = getTestDb();
  const deps = createTestDeps({ overrides: { ...(options.ai ? { ai: options.ai } : {}), ...options.deps } });
  const tenantRow = await createTenant(db, {
    clinicName: 'Fisio Test',
    settings: { contactPhone: '965 000 000', faqPrompt: FAQ_PROMPT, slotMinutes: 60 },
  });
  const names = ['Ana', 'Luis', 'Inés', 'Marta'].slice(0, options.employees ?? 2);
  const employees = [];
  for (const name of names) employees.push(await createEmployee(db, tenantRow.id, { name, schedule: WEEKDAYS_9_14 }));
  const tenant = (await deps.systemRepos.tenants.findById(tenantRow.id))!;
  const engine = createConversationEngine(deps);
  const newChat = (phone = uniquePhone()) => new Chat(deps, engine, tenant, phone);
  return { db, deps, tenant, employees, engine, newChat };
}

async function registeredChat(ctx: Awaited<ReturnType<typeof setup>>, name = 'Laura Martínez') {
  const phone = uniquePhone();
  await createClient(ctx.db, ctx.tenant.id, { name, phone });
  return ctx.newChat(phone);
}

describe('CU-C1 / CU-C2 — first contact and registration (RF-W1)', () => {
  it('registers a new client conversationally (with validation)', async () => {
    const ctx = await setup();
    const chat = ctx.newChat();
    const first = await chat.say('Hola');
    expect(joined(first)).toContain('Bienvenido/a a Fisio Test. Soy su asistente virtual 🤖. Parece que es tu primera vez aquí.');
    // Privacy notice before any data is stored (F12, GDPR art. 13).
    expect(joined(first)).toContain('🔒 Protección de datos: el responsable es Fisio Test.');
    expect(joined(first)).toContain('asistente con inteligencia artificial');
    expect(joined(first)).not.toContain('Más información');
    expect(joined(first)).toContain('¿Aceptas el tratamiento de tus datos y quieres registrarte?');
    expect(optionIds(first)).toEqual(['REGISTER_YES', 'REGISTER_NO']);

    expect(joined(await chat.press('REGISTER_YES', 'Acepto'))).toBe(
      'Perfecto, voy a proceder con algunas preguntas\nPor favor, escribe tu nombre completo:',
    );
    expect(joined(await chat.say('1'))).toContain('Ese nombre no parece válido');
    expect(joined(await chat.say('Ana García López'))).toBe('¿Cuál es tu email?');
    expect(joined(await chat.say('ana@gmail'))).toBe(
      'Ese email no parece válido. Ejemplo: nombre@gmail.com. Inténtalo de nuevo:',
    );
    expect(joined(await chat.say('Ana.Garcia@Gmail.com'))).toBe(
      '✅ ¡Registro completado en Fisio Test, Ana! Ahora puedes pedir tu cita.',
    );
    const client = await ctx.deps.systemRepos.clients.findByPhone(ctx.tenant.id, chat.phone);
    expect(client).toMatchObject({
      name: 'Ana García López',
      email: 'ana.garcia@gmail.com',
      phone: chat.phone,
      // Acceptance stored with the moment it was given and the notice version.
      consentAt: ctx.deps.clock.now(),
      consentChannel: 'whatsapp',
      consentVersion: PRIVACY_NOTICE_VERSION,
    });

    // The next message goes to intentionFlow (no greeting again).
    expect(joined(await chat.say('¿Qué horario tenéis?'))).toBe('Nuestro horario es: lunes a viernes, de 9:00 a 14:00.');
  });

  it('accepts a declined registration and resets the state', async () => {
    const ctx = await setup();
    const chat = ctx.newChat();
    await chat.say('Buenas');
    expect(joined(await chat.press('REGISTER_NO', 'No acepto'))).toBe(
      'De acuerdo, no guardaremos tus datos. Si cambias de opinión, escríbeme cuando quieras.',
    );
    expect(await ctx.deps.systemRepos.conversations.get(ctx.tenant.id, chat.phone, ctx.deps.clock.now())).toBeNull();
    expect(await ctx.deps.systemRepos.clients.findByPhone(ctx.tenant.id, chat.phone)).toBeNull();
  });

  it('links the clinic privacy policy in the notice when configured (F12)', async () => {
    const ctx = await setup();
    await ctx.deps.systemRepos.tenants.update(ctx.tenant.id, { settings: { privacyPolicyUrl: 'https://fisiotest.es/privacidad' } });
    const tenant = (await ctx.deps.systemRepos.tenants.findById(ctx.tenant.id))!;
    const chat = new Chat(ctx.deps, ctx.engine, tenant, uniquePhone());
    expect(joined(await chat.say('Hola'))).toContain('Más información: https://fisiotest.es/privacidad');
  });

  it('a client created from the panel must accept the notice before anything is processed (F12)', async () => {
    let llmCalls = 0;
    const mock = createMockAIService();
    const counting: AIService = {
      ...mock,
      detectIntent: (...args) => ((llmCalls += 1), mock.detectIntent(...args)),
      answerFaq: (...args) => ((llmCalls += 1), mock.answerFaq(...args)),
      parseDate: (...args) => ((llmCalls += 1), mock.parseDate(...args)),
    };
    const ctx = await setup({ ai: counting });
    const phone = uniquePhone();
    await createClient(ctx.db, ctx.tenant.id, { name: 'Pedro Gómez', phone, consent: false });
    const chat = ctx.newChat(phone);

    const first = await chat.say('Quiero cita para mañana a las 10');
    expect(joined(first)).toContain('¡Hola Pedro! Antes de continuar, necesitamos que aceptes cómo trata Fisio Test tus datos.');
    expect(joined(first)).toContain('🔒 Protección de datos');
    expect(optionIds(first)).toEqual(['REGISTER_YES', 'REGISTER_NO']);
    expect(llmCalls).toBe(0);

    expect(joined(await chat.press('REGISTER_NO', 'No acepto'))).toBe(
      'De acuerdo. Sin tu aceptación no puedo atenderte por este chat. Puedes contactar con Fisio Test en el 965 000 000.',
    );
    expect((await ctx.deps.systemRepos.clients.findByPhone(ctx.tenant.id, phone))?.consentAt).toBeNull();
    expect(joined(await chat.say('¿Tenéis parking?'))).toContain('Antes de continuar');
    expect(llmCalls).toBe(0);

    expect(joined(await chat.press('REGISTER_YES', 'Acepto'))).toBe('✅ ¡Gracias! ¿En qué puedo ayudarte hoy?');
    expect(await ctx.deps.systemRepos.clients.findByPhone(ctx.tenant.id, phone)).toMatchObject({
      consentChannel: 'whatsapp',
      consentVersion: PRIVACY_NOTICE_VERSION,
    });
    expect(joined(await chat.say('Quiero cita para mañana a las 10'))).toContain('está disponible en Fisio Test');
    expect(llmCalls).toBeGreaterThan(0);
  });

  it('never sends the client name, phone or email to the LLM (F12)', async () => {
    const bodies: string[] = [];
    const answers = ['FAQ', 'Sí, hay aparcamiento en la zona.', 'CITA', '{"datetime":null,"hasTime":false}'];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return Response.json({ choices: [{ message: { content: answers.shift() ?? 'FAQ' } }] });
    }) as unknown as typeof fetch;
    const config = testConfig({ LLM_MODE: 'live', OPENAI_API_KEY: 'sk-test' });
    const ctx = await setup({ ai: createAIService(config, createSilentLogger(), fetchFn) });
    const phone = uniquePhone();
    await createClient(ctx.db, ctx.tenant.id, { name: 'Remedios Pérez Sanz', phone, email: 'remedios.perez@correo.es' });
    const chat = ctx.newChat(phone);
    await chat.say('Hola');
    await chat.say('¿Tenéis parking?');
    await chat.say('Quiero pedir cita');
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    for (const body of bodies) {
      expect(body).not.toMatch(/Remedios|Pérez|remedios\.perez/);
      expect(body).not.toContain(phone.slice(3));
    }
  });

  it('greets a returning client with the AI notice (AI Act)', async () => {
    const ctx = await setup();
    const chat = await registeredChat(ctx);
    const replies = await chat.say('Hola');
    expect(joined(replies)).toBe(
      '¡Hola Laura! Bienvenido/a de nuevo a Fisio Test 👋\nSoy el asistente virtual 🤖 de Fisio Test.\n¿En qué puedo ayudarte hoy?',
    );
  });

  it('does not ask to repeat a request included in the first message', async () => {
    const ctx = await setup();
    const chat = await registeredChat(ctx);
    const replies = await chat.say('Hola, quiero cita para mañana a las 10');
    const all = joined(replies);
    expect(all).toContain('¡Hola Laura! Bienvenido/a de nuevo a Fisio Test 👋');
    expect(all).toContain('✅ ¡Genial! La fecha miércoles, 7 de mayo de 2025, 10:00 está disponible en Fisio Test.');
    expect(optionIds(replies)).toEqual([`EMP:${ctx.employees[0]!.id}`, `EMP:${ctx.employees[1]!.id}`, 'CANCEL']);
  });

  it('isolates clients per tenant: the same phone is new in another business', async () => {
    const ctx = await setup();
    const other = await setup();
    const phone = uniquePhone();
    await createClient(ctx.db, ctx.tenant.id, { name: 'Laura', phone });
    expect(joined(await other.newChat(phone).say('Hola'))).toContain('Parece que es tu primera vez aquí');
  });
});

describe('CU-C3 — FAQ (RF-W2)', () => {
  it('answers with the tenant prompt and keeps classifying the next messages', async () => {
    const ctx = await setup();
    const chat = await registeredChat(ctx);
    await chat.say('Hola');
    expect(joined(await chat.say('¿Qué horario tenéis?'))).toBe('Nuestro horario es: lunes a viernes, de 9:00 a 14:00.');
    expect(await ctx.deps.systemRepos.conversations.get(ctx.tenant.id, chat.phone, ctx.deps.clock.now())).toMatchObject({
      flow: 'intention',
    });
    expect(joined(await chat.say('Quiero pedir cita'))).toBe(
      'Por favor, indícame la fecha para tu cita en Fisio Test (Ej: "15 de marzo a las 10")',
    );
  });
});

describe('CU-C4 … CU-C7 — booking (RF-W3)', () => {
  it('books a pending appointment through buttons', async () => {
    const ctx = await setup();
    const chat = await registeredChat(ctx);
    await chat.say('Hola');
    expect(joined(await chat.say('Quiero pedir cita'))).toContain('Por favor, indícame la fecha para tu cita en Fisio Test');
    const options = await chat.say('mañana a las 10');
    expect(joined(options)).toContain('Estos son los profesionales disponibles en Fisio Test para esa hora.');
    const luis = ctx.employees[1]!;
    const summary = await chat.press(`EMP:${luis.id}`, 'Luis');
    expect(joined(summary)).toContain('✅ Has seleccionado a Luis en Fisio Test.');
    expect(joined(summary)).toContain('📅 Fecha: miércoles, 7 de mayo de 2025\n🕐 Hora: 10:00\n👤 Profesional: Luis');
    expect(optionIds(summary)).toEqual(['CONFIRM_YES', 'CONFIRM_OTHER', 'CONFIRM_EXIT']);
    expect(joined(await chat.press('CONFIRM_YES', 'Sí ✅'))).toBe(
      '✅ ¡Cita confirmada en Fisio Test para miércoles, 7 de mayo de 2025, 10:00!',
    );
    const appointments = await ctx.deps.systemRepos.appointments.listInRange(ctx.tenant.id, at(7, 0), at(8, 0));
    expect(appointments).toHaveLength(1);
    expect(appointments[0]).toMatchObject({
      status: 'pending',
      source: 'whatsapp',
      durationMinutes: 60,
      employeeId: luis.id,
      date: at(7, 10),
    });
  });

  it('asks for the hour when only the day is given', async () => {
    const ctx = await setup();
    const chat = await registeredChat(ctx);
    await chat.say('Quiero cita');
    expect(joined(await chat.say('el jueves por la mañana'))).toBe(
      '¿A qué hora te vendría bien el jueves, 8 de mayo de 2025? Por ejemplo: "a las 10" o "a las 17:30".',
    );
    expect(joined(await chat.say('a las 11'))).toContain('La fecha jueves, 8 de mayo de 2025, 11:00 está disponible');
  });

  it('rejects past dates', async () => {
    const ctx = await setup();
    const chat = await registeredChat(ctx);
    await chat.say('Quiero cita');
    expect(joined(await chat.say('hoy a las 8'))).toBe('Esa fecha ya ha pasado. Dime otra, por ejemplo "mañana a las 10"');
  });

  it('rounds the hour to the slot grid', async () => {
    const ctx = await setup();
    const chat = await registeredChat(ctx);
    await chat.say('Quiero cita');
    const replies = joined(await chat.say('mañana a las 10:20'));
    expect(replies).toContain('La fecha miércoles, 7 de mayo de 2025, 10:00 está disponible');
    expect(replies).toContain('He ajustado la hora a las 10:00');
  });

  it('offers up to 3 nearby free slots when there is no availability', async () => {
    const ctx = await setup({ employees: 1 });
    const chat = await registeredChat(ctx);
    const client = await ctx.deps.systemRepos.clients.findByPhone(ctx.tenant.id, chat.phone);
    await createAppointment(ctx.db, { tenantId: ctx.tenant.id, clientId: client!.id, employeeId: ctx.employees[0]!.id, date: at(7, 10) });
    await chat.say('Quiero cita');
    const replies = await chat.say('mañana a las 10');
    expect(joined(replies)).toContain(
      'Lo siento, no hay disponibilidad para miércoles, 7 de mayo de 2025, 10:00. ¿Te viene bien otro día u hora?',
    );
    const ids = optionIds(replies);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(`SLOT:${at(7, 11).toISOString()}`);
    expect(joined(await chat.press(ids[0]!, 'mié 7 may, 11:00'))).toContain('La fecha miércoles, 7 de mayo de 2025, 11:00 está disponible');
  });

  it('uses a list message with 3+ professionals and accepts typed names without accents', async () => {
    const ctx = await setup({ employees: 3 });
    const chat = await registeredChat(ctx);
    await chat.say('Quiero cita');
    const replies = await chat.say('mañana a las 10');
    const list = replies.find((m) => m.type === 'list');
    expect(list).toBeDefined();
    expect(optionIds(replies)).toHaveLength(4); // 3 professionals + Cancelar
    const notFound = await chat.say('Pepe');
    expect(joined(notFound)).toContain('No he encontrado a ese profesional. Elige uno de la lista, por favor:');
    expect(joined(await chat.say('ines'))).toContain('✅ Has seleccionado a Inés en Fisio Test.');
  });

  it('accepts a list row selection', async () => {
    const ctx = await setup({ employees: 3 });
    const chat = await registeredChat(ctx);
    await chat.say('Quiero cita');
    await chat.say('mañana a las 10');
    expect(joined(await chat.pick(`EMP:${ctx.employees[2]!.id}`, 'Inés'))).toContain('Has seleccionado a Inés');
  });

  it('"Otra fecha" goes back to the date and "Salir" cancels the booking', async () => {
    const ctx = await setup();
    const chat = await registeredChat(ctx);
    await chat.say('Quiero cita');
    await chat.say('mañana a las 10');
    await chat.press(`EMP:${ctx.employees[0]!.id}`, 'Ana');
    expect(joined(await chat.press('CONFIRM_OTHER', 'Otra fecha'))).toContain('Por favor, indícame la fecha para tu cita');
    await chat.say('mañana a las 12');
    await chat.press(`EMP:${ctx.employees[0]!.id}`, 'Ana');
    expect(joined(await chat.press('CONFIRM_EXIT', 'Salir'))).toBe('Has cancelado la reserva. ¡Aquí estaré si me necesitas!');
    expect(await ctx.deps.systemRepos.appointments.listInRange(ctx.tenant.id, at(7, 0), at(8, 0))).toHaveLength(0);
  });

  it('revalidates on confirmation: a slot taken meanwhile is not double-booked', async () => {
    const ctx = await setup({ employees: 1 });
    const chat = await registeredChat(ctx);
    await chat.say('Quiero cita');
    await chat.say('mañana a las 10');
    await chat.press(`EMP:${ctx.employees[0]!.id}`, 'Ana');
    const other = await createClient(ctx.db, ctx.tenant.id);
    await createAppointment(ctx.db, { tenantId: ctx.tenant.id, clientId: other.id, employeeId: ctx.employees[0]!.id, date: at(7, 10) });
    expect(joined(await chat.press('CONFIRM_YES', 'Sí ✅'))).toBe(
      'Lo siento, ese hueco acaba de ocuparse 😕. Indícame otra fecha, por ejemplo "mañana a las 10".',
    );
    expect(await ctx.deps.systemRepos.conversations.get(ctx.tenant.id, chat.phone, ctx.deps.clock.now())).toMatchObject({
      flow: 'cita',
      step: 'askDate',
    });
  });

  it('reformulates the confirmation question on unexpected answers', async () => {
    const ctx = await setup();
    const chat = await registeredChat(ctx);
    await chat.say('Quiero cita');
    await chat.say('mañana a las 10');
    await chat.press(`EMP:${ctx.employees[0]!.id}`, 'Ana');
    const replies = await chat.say('patata');
    expect(joined(replies)).toContain('¿Deseas confirmar la cita, cambiar la fecha o salir?');
    expect(joined(await chat.say('sí'))).toContain('✅ ¡Cita confirmada en Fisio Test');
  });
});

describe('global rules', () => {
  it('3 failures in the same flow → suggests calling the business and resets', async () => {
    const ctx = await setup();
    const chat = await registeredChat(ctx);
    await chat.say('Quiero cita');
    expect(joined(await chat.say('blablabla'))).toContain('No he entendido la fecha');
    expect(joined(await chat.say('qwerty'))).toContain('No he entendido la fecha');
    expect(joined(await chat.say('asdf'))).toBe('No consigo entenderte bien 😅. Para continuar, llama a Fisio Test al 965 000 000.');
    expect(await ctx.deps.systemRepos.conversations.get(ctx.tenant.id, chat.phone, ctx.deps.clock.now())).toBeNull();
  });

  it('escape words reset the flow ("cancelar", "salir", "menú")', async () => {
    const ctx = await setup();
    const chat = await registeredChat(ctx);
    await chat.say('Quiero cita');
    expect(joined(await chat.say('Cancelar'))).toBe('Has cancelado la reserva. ¡Aquí estaré si me necesitas!');
    expect(await ctx.deps.systemRepos.conversations.get(ctx.tenant.id, chat.phone, ctx.deps.clock.now())).toBeNull();
    expect(joined(await chat.say('menú'))).toContain('Puedo ayudarte a pedir una cita');
    expect(joined(await chat.say('salir'))).toBe(
      'De acuerdo, he cancelado la operación. Si necesitas algo más, escríbeme cuando quieras 👋',
    );
  });

  it('the "Cancelar" button of the professional selection exits', async () => {
    const ctx = await setup();
    const chat = await registeredChat(ctx);
    await chat.say('Quiero cita');
    await chat.say('mañana a las 10');
    expect(joined(await chat.press('CANCEL', 'Cancelar'))).toBe('Has cancelado la reserva. ¡Aquí estaré si me necesitas!');
  });

  it('does not answer numbers paused from Chatwoot (blacklist)', async () => {
    const ctx = await setup();
    const chat = await registeredChat(ctx);
    await ctx.deps.systemRepos.blacklist.add(ctx.tenant.id, chat.phone, 'agent');
    expect(await chat.say('Hola')).toEqual([]);
  });

  it('kindly asks for text when receiving images or stickers', async () => {
    const ctx = await setup();
    const chat = await registeredChat(ctx);
    expect(joined(await chat.image())).toBe('De momento solo entiendo mensajes de texto 🙏. ¿Puedes escribirme lo que necesitas?');
  });

  it('sends a friendly message when every LLM provider fails (counts as error)', async () => {
    const failing: AIService = {
      ...createMockAIService(),
      mode: 'live',
      detectIntent: async () => {
        throw new AIUnavailableError([]);
      },
    };
    const ctx = await setup({ ai: failing });
    const chat = await registeredChat(ctx);
    await chat.say('Hola');
    expect(joined(await chat.say('¿Tenéis parking?'))).toBe(
      'Lo siento, ahora mismo no puedo procesar tu mensaje 🙏. Inténtalo de nuevo en unos minutos.',
    );
    expect(await ctx.deps.systemRepos.conversations.get(ctx.tenant.id, chat.phone, ctx.deps.clock.now())).toMatchObject({
      flow: 'intention',
      errorCount: 1,
    });
  });

  it('conversation state expires after 30 minutes of inactivity', async () => {
    const ctx = await setup();
    const chat = await registeredChat(ctx);
    await chat.say('Quiero cita');
    ctx.deps.clock.advance(31 * 60 * 1000);
    expect(joined(await chat.say('Hola'))).toContain('Bienvenido/a de nuevo a Fisio Test');
  });
});
