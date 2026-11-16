/**
 * F27 — a slot chosen on the public booking page arrives as a WhatsApp message with a reference
 * (service, local date and time). The bot goes straight to that slot without the LLM, also after
 * registering a new client. Fixed clock: Monday 16 November 2026, 09:00 in Madrid.
 */
import { createAppointment, createClient, createEmployee, createService, createTenant, uniquePhone } from '@clinicai/db/testing';
import { webBookingMessage, zonedTimeToUtc } from '@clinicai/shared';
import { describe, expect, it, vi } from 'vitest';
import { createConversationEngine } from '../src/engine/engine';
import { CONFIRM_YES } from '../src/flows/confirmationFlow';
import { EMPLOYEE_PREFIX } from '../src/flows/employeeFlow';
import { REGISTER_YES } from '../src/flows/registerFlow';
import { Chat, joined } from './chat';
import { createTestDeps, getTestDb } from './helpers';

const TZ = 'Europe/Madrid';
const NOW = '2026-11-16T08:00:00Z';
const wednesday10 = zonedTimeToUtc({ year: 2026, month: 11, day: 18, hour: 10, minute: 0 }, TZ);

async function scenario(options: { registered?: boolean; consent?: boolean } = {}) {
  const db = getTestDb();
  const deps = createTestDeps({ now: NOW });
  const tenantRow = await createTenant(db, { clinicName: 'Fisio Web' });
  const employee = await createEmployee(db, tenantRow.id, { name: 'Ana' });
  const [physio] = await Promise.all([
    createService(db, tenantRow.id, { name: 'Fisioterapia', durationMinutes: 45 }),
    createService(db, tenantRow.id, { name: 'Masaje', durationMinutes: 30 }),
  ]);
  const phone = uniquePhone();
  const client = options.registered ? await createClient(db, tenantRow.id, { name: 'Lucía Pérez', phone, consent: options.consent ?? true }) : null;
  const tenant = (await deps.systemRepos.tenants.findById(tenantRow.id))!;
  const chat = new Chat(deps, createConversationEngine(deps), tenant, phone);
  const message = webBookingMessage({ serviceName: 'Fisioterapia', start: wednesday10, timeZone: TZ, serviceId: physio!.id });
  const llm = { intent: vi.spyOn(deps.ai, 'detectIntent'), date: vi.spyOn(deps.ai, 'parseDate') };
  return { db, deps, tenant, employee, physio: physio!, client, phone, chat, message, llm };
}

describe('F27 — slots chosen on the booking page', () => {
  it('a registered client goes straight to the slot and books it, without the LLM', async () => {
    const s = await scenario({ registered: true });
    const reply = joined(await s.chat.say(s.message));
    expect(reply).toContain('Bienvenido/a de nuevo a Fisio Web');
    expect(reply).toContain('La fecha miércoles, 18 de noviembre de 2026, 10:00 está disponible en Fisio Web.');
    await s.chat.press(`${EMPLOYEE_PREFIX}${s.employee.id}`, 'Ana');
    expect(joined(await s.chat.press(CONFIRM_YES, 'Sí ✅'))).toContain('Cita confirmada en Fisio Web');
    const [booked] = await s.db.appointment.findMany({ where: { tenantId: s.tenant.id, clientId: s.client!.id } });
    expect(booked).toMatchObject({ date: wednesday10, serviceId: s.physio.id, durationMinutes: 45, source: 'whatsapp' });
    expect(s.llm.intent).not.toHaveBeenCalled();
    expect(s.llm.date).not.toHaveBeenCalled();
  });

  it('a new client registers first and then goes on with the slot; only the code is kept before accepting', async () => {
    const s = await scenario();
    expect(joined(await s.chat.say(s.message))).toContain('Acepto');
    const state = await s.db.conversationState.findFirst({ where: { tenantId: s.tenant.id, phone: s.phone } });
    expect(state?.data).toEqual({ webRef: expect.stringMatching(/^W-261118-1000-[0-9a-f]{8}$/) });

    await s.chat.press(REGISTER_YES, 'Acepto');
    await s.chat.say('Marta Gil Soler');
    const reply = joined(await s.chat.say('marta@correo.es'));
    expect(reply).toContain('¡Registro completado en Fisio Web, Marta! Seguimos con la cita que has elegido.');
    expect(reply).toContain('La fecha miércoles, 18 de noviembre de 2026, 10:00 está disponible');
    expect(s.llm.intent).not.toHaveBeenCalled();
    expect(s.llm.date).not.toHaveBeenCalled();
  });

  it('a client created in the panel accepts the notice and goes on with the slot', async () => {
    const s = await scenario({ registered: true, consent: false });
    await s.chat.say(s.message);
    const reply = joined(await s.chat.press(REGISTER_YES, 'Acepto'));
    expect(reply).toContain('¡Gracias! Seguimos con la cita que has elegido.');
    expect(reply).toContain('está disponible en Fisio Web');
  });

  it('if the slot was taken meanwhile, offers the nearest ones', async () => {
    const s = await scenario({ registered: true });
    const other = await createClient(s.db, s.tenant.id);
    await createAppointment(s.db, { tenantId: s.tenant.id, clientId: other.id, employeeId: s.employee.id, date: wednesday10 });
    const reply = joined(await s.chat.say(s.message));
    expect(reply).toContain('no hay disponibilidad para miércoles, 18 de noviembre de 2026, 10:00');
    expect(reply).toContain('[mié 18 nov, 11:00]');
  });

  it('starts over with the slot in the middle of another conversation', async () => {
    const s = await scenario({ registered: true });
    await s.chat.say('Quiero pedir cita');
    s.llm.intent.mockClear();
    s.llm.date.mockClear();
    const reply = joined(await s.chat.say(s.message));
    expect(reply).toContain('La fecha miércoles, 18 de noviembre de 2026, 10:00 está disponible');
    expect(s.llm.date).not.toHaveBeenCalled();
  });
});
