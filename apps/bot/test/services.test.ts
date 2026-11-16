/**
 * F14 — services with their own duration and time off (absences, clinic closures) in the bot.
 * Fixed clock: Tuesday 6 May 2025, 09:15 Europe/Madrid. Schedules: weekdays 09:00-14:00.
 */
import {
  createAppointment,
  createClient,
  createEmployee,
  createService,
  createTenant,
  createTimeOff,
  uniquePhone,
} from '@clinicai/db/testing';
import { localDaysRange, zonedTimeToUtc, type ScheduleSlot } from '@clinicai/shared';
import { describe, expect, it } from 'vitest';
import { createConversationEngine } from '../src/engine/engine';
import { SERVICE_PREFIX, SLOT_PREFIX } from '../src/flows/citaFlow';
import { CONFIRM_YES } from '../src/flows/confirmationFlow';
import { Chat, joined, optionIds } from './chat';
import { createTestDeps, getTestDb } from './helpers';

const TZ = 'Europe/Madrid';
const at = (d: number, h: number, mi = 0) => zonedTimeToUtc({ year: 2025, month: 5, day: d, hour: h, minute: mi }, TZ);
const WEEKDAYS_9_14: ScheduleSlot[] = (['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const).map((day) => ({
  day,
  start: '09:00',
  end: '14:00',
}));

async function setup() {
  const db = getTestDb();
  const deps = createTestDeps();
  const tenantRow = await createTenant(db, { clinicName: 'Fisio Servicios', settings: { contactPhone: '965 000 000', slotMinutes: 60 } });
  const ana = await createEmployee(db, tenantRow.id, { name: 'Ana', schedule: WEEKDAYS_9_14 });
  const luis = await createEmployee(db, tenantRow.id, { name: 'Luis', schedule: WEEKDAYS_9_14 });
  const phone = uniquePhone();
  const client = await createClient(db, tenantRow.id, { name: 'Laura Martínez', phone });
  const tenant = (await deps.systemRepos.tenants.findById(tenantRow.id))!;
  const chat = new Chat(deps, createConversationEngine(deps), tenant, phone);
  const appointmentsOf = () => db.appointment.findMany({ where: { clientId: client.id }, orderBy: { date: 'asc' } });
  return { db, deps, tenant, ana, luis, client, chat, appointmentsOf };
}

describe('F14 — services', () => {
  it('asks for the service first, keeps the date said before and books with the service duration', async () => {
    const ctx = await setup();
    await createService(ctx.db, ctx.tenant.id, { name: 'Valoración inicial', durationMinutes: 60 });
    await createService(ctx.db, ctx.tenant.id, { name: 'Punción seca', durationMinutes: 30 });
    const long = await createService(ctx.db, ctx.tenant.id, { name: 'Sesión larga', durationMinutes: 90 });
    await createService(ctx.db, ctx.tenant.id, { name: 'Ya no se ofrece', durationMinutes: 45, active: false });

    const question = await ctx.chat.say('Quiero cita mañana a las 13');
    expect(joined(question)).toContain('¿Qué servicio necesitas en Fisio Servicios? Elige uno de la lista:');
    expect(joined(question)).toContain('• Sesión larga (1 h 30 min)');
    expect(joined(question)).not.toContain('Ya no se ofrece');
    expect(optionIds(question)).toHaveLength(3);

    // 13:00 + 90 min does not fit in a 09:00-14:00 schedule: the remembered date gets alternatives.
    const answer = await ctx.chat.pick(`${SERVICE_PREFIX}${long.id}`, 'Sesión larga');
    expect(joined(answer)).toContain('Perfecto: Sesión larga (1 h 30 min).');
    expect(joined(answer)).toContain('no hay disponibilidad para miércoles, 7 de mayo de 2025, 13:00');
    const [firstSlot] = optionIds(answer);
    // Alternatives start after the requested time: Wednesday is full, so Thursday 09:00.
    expect(firstSlot).toBe(`${SLOT_PREFIX}${at(8, 9).toISOString()}`);

    await ctx.chat.press(firstSlot!, 'jue 8 may, 09:00');
    const summary = await ctx.chat.press(`EMP:${ctx.ana.id}`, 'Ana');
    expect(joined(summary)).toContain('💆 Servicio: Sesión larga (1 h 30 min)');
    expect(joined(await ctx.chat.press(CONFIRM_YES, 'Sí ✅'))).toContain('✅ ¡Cita confirmada en Fisio Servicios');
    expect(await ctx.appointmentsOf()).toMatchObject([{ date: at(8, 9), durationMinutes: 90, serviceId: long.id }]);
  });

  it('uses the only active service directly and recognises a service named in the message', async () => {
    const ctx = await setup();
    const only = await createService(ctx.db, ctx.tenant.id, { name: 'Punción seca', durationMinutes: 30 });
    await createService(ctx.db, ctx.tenant.id, { name: 'Antiguo', active: false });
    const first = await ctx.chat.say('Quiero cita mañana a las 13');
    expect(joined(first)).not.toContain('¿Qué servicio necesitas');
    expect(joined(first)).toContain('miércoles, 7 de mayo de 2025, 13:00 está disponible');
    await ctx.chat.press(`EMP:${ctx.luis.id}`, 'Luis');
    await ctx.chat.press(CONFIRM_YES, 'Sí ✅');
    expect(await ctx.appointmentsOf()).toMatchObject([{ durationMinutes: 30, serviceId: only.id }]);

    const other = await setup();
    await createService(other.db, other.tenant.id, { name: 'Valoración inicial', durationMinutes: 60 });
    const named = await createService(other.db, other.tenant.id, { name: 'Punción seca', durationMinutes: 30 });
    const reply = await other.chat.say('Hola, quería una punción seca para mañana a las 10');
    expect(joined(reply)).not.toContain('¿Qué servicio necesitas');
    expect(joined(reply)).toContain('está disponible');
    await other.chat.press(`EMP:${other.ana.id}`, 'Ana');
    await other.chat.press(CONFIRM_YES, 'Sí ✅');
    expect(await other.appointmentsOf()).toMatchObject([{ durationMinutes: 30, serviceId: named.id }]);
  });

  it('changing the date keeps the service and its duration', async () => {
    const ctx = await setup();
    const puncion = await createService(ctx.db, ctx.tenant.id, { name: 'Punción seca', durationMinutes: 30 });
    await createService(ctx.db, ctx.tenant.id, { name: 'Valoración inicial', durationMinutes: 60 });
    const appt = await createAppointment(ctx.db, {
      tenantId: ctx.tenant.id,
      clientId: ctx.client.id,
      employeeId: ctx.ana.id,
      date: at(8, 12),
      durationMinutes: 30,
      serviceId: puncion.id,
    });
    expect(joined(await ctx.chat.say('Quiero cambiar mi cita'))).toContain('¿Qué día y a qué hora te vendría mejor?');
    const options = await ctx.chat.say('el viernes a las 13');
    expect(joined(options)).not.toContain('¿Qué servicio necesitas');
    expect(joined(await ctx.chat.press(`EMP:${ctx.ana.id}`, 'Ana'))).toContain('💆 Servicio: Punción seca (30 min)');
    await ctx.chat.press(CONFIRM_YES, 'Sí ✅');
    expect(await ctx.deps.systemRepos.appointments.findById(ctx.tenant.id, appt.id)).toMatchObject({
      date: at(9, 13),
      durationMinutes: 30,
      serviceId: puncion.id,
    });
  });
});

describe('F14 — absences and clinic closures', () => {
  it('an absent professional is not offered; a closed day gets alternatives on the next open day', async () => {
    const ctx = await setup();
    const wednesday = localDaysRange('2025-05-07', '2025-05-07', TZ)!;
    await createTimeOff(ctx.db, { tenantId: ctx.tenant.id, employeeId: ctx.ana.id, startsAt: wednesday.start, endsAt: wednesday.end, reason: 'Vacaciones' });
    const offer = await ctx.chat.say('Quiero cita mañana a las 10');
    expect(optionIds(offer)).toEqual([`EMP:${ctx.luis.id}`, 'CANCEL']);

    const thursday = localDaysRange('2025-05-08', '2025-05-08', TZ)!;
    await createTimeOff(ctx.db, { tenantId: ctx.tenant.id, employeeId: null, startsAt: thursday.start, endsAt: thursday.end, reason: 'Festivo local' });
    await ctx.deps.systemRepos.conversations.clear(ctx.tenant.id, ctx.chat.phone);
    const closed = await ctx.chat.say('Quiero cita el jueves a las 10');
    expect(joined(closed)).toContain('no hay disponibilidad para jueves, 8 de mayo de 2025, 10:00');
    expect(optionIds(closed)).toEqual([at(8, 11), at(8, 12), at(8, 13)].map(() => expect.any(String)));
    expect(optionIds(closed)[0]).toBe(`${SLOT_PREFIX}${at(9, 9).toISOString()}`);
  });
});
