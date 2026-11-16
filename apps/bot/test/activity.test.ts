/**
 * F24 — what clients do through WhatsApp also appears in the activity log (ids and safe details
 * only, never their messages or phone).
 */
import { createAppointment, createEmployee, createTenant, uniquePhone } from '@clinicai/db/testing';
import { zonedTimeToUtc } from '@clinicai/shared';
import { describe, expect, it } from 'vitest';
import { createConversationEngine } from '../src/engine/engine';
import { Chat } from './chat';
import { createTestDeps, getTestDb } from './helpers';

describe('F24 — WhatsApp actions in the activity log', () => {
  it('records the registration and a cancellation from the reminder', async () => {
    const db = getTestDb();
    const deps = createTestDeps();
    const tenantRow = await createTenant(db, { clinicName: 'Fisio Registro' });
    const employee = await createEmployee(db, tenantRow.id, { name: 'Ana' });
    const tenant = (await deps.systemRepos.tenants.findById(tenantRow.id))!;
    const phone = uniquePhone();
    const chat = new Chat(deps, createConversationEngine(deps), tenant, phone);

    await chat.say('Hola');
    await chat.press('REGISTER_YES', 'Acepto');
    await chat.say('Marta Gil Soler');
    await chat.say('marta.gil@correo.es');
    const client = (await deps.systemRepos.clients.findByPhone(tenant.id, phone))!;
    const date = zonedTimeToUtc({ year: 2025, month: 5, day: 7, hour: 10, minute: 0 }, 'Europe/Madrid');
    const appointment = await createAppointment(db, { tenantId: tenant.id, clientId: client.id, employeeId: employee.id, date });
    await chat.templateReply(`REMINDER_CANCEL:${appointment.id}`, 'No puedo asistir');

    const entries = await db.activityLog.findMany({ where: { tenantId: tenant.id }, orderBy: { id: 'asc' } });
    expect(entries.map((e) => [e.actorType, e.actorLabel, e.action, e.clientId])).toEqual([
      ['whatsapp', 'WhatsApp', 'whatsapp.client_registered', client.id],
      ['whatsapp', 'WhatsApp', 'whatsapp.appointment_cancelled', client.id],
    ]);
    expect(entries[1]).toMatchObject({ entityId: appointment.id, details: { start: date.toISOString(), employeeId: employee.id } });
    const stored = JSON.stringify(entries, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
    for (const secret of ['Marta', 'marta.gil', phone]) expect(stored).not.toContain(secret);
  });
});
