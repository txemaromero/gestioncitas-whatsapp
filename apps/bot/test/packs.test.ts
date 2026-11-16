/**
 * F26 — «¿cuántas sesiones me quedan?» by WhatsApp: answered with rules (no LLM) from the client's
 * packs. Fixed clock: Friday 13 November 2026.
 */
import { createPack, markAttendance } from '@clinicai/db';
import { createAppointment, createClient, createEmployee, createTenant, uniquePhone } from '@clinicai/db/testing';
import { zonedTimeToUtc } from '@clinicai/shared';
import { describe, expect, it, vi } from 'vitest';
import { createConversationEngine } from '../src/engine/engine';
import { detectPackRequest } from '../src/engine/matching';
import { Chat, joined } from './chat';
import { createTestDeps, getTestDb } from './helpers';

const NOW = '2026-11-13T09:00:00Z';

async function scenario() {
  const db = getTestDb();
  const deps = createTestDeps({ now: NOW });
  const tenantRow = await createTenant(db, { clinicName: 'Fisio Bonos' });
  const employee = await createEmployee(db, tenantRow.id);
  const phone = uniquePhone();
  const client = await createClient(db, tenantRow.id, { name: 'Lucía', phone });
  const tenant = (await deps.systemRepos.tenants.findById(tenantRow.id))!;
  const chat = new Chat(deps, createConversationEngine(deps), tenant, phone);
  const attended = async () => {
    const date = zonedTimeToUtc({ year: 2026, month: 11, day: 2, hour: 10 }, 'Europe/Madrid');
    const a = await createAppointment(db, { tenantId: tenant.id, clientId: client.id, employeeId: employee.id, date });
    await markAttendance(db, tenant.id, a.id, 'attended', new Date(NOW));
  };
  return { db, deps, tenant, client, chat, attended };
}

describe('F26 — sessions left of the packs, by WhatsApp', () => {
  it('lists the sessions left of each valid pack, without asking the LLM', async () => {
    const { db, deps, tenant, client, chat, attended } = await scenario();
    await createPack(db, tenant.id, client.id, { name: 'Bono 10 sesiones', totalSessions: 10, serviceId: null, expiresOn: '2027-03-31' });
    await createPack(db, tenant.id, client.id, { name: 'Bono masaje', totalSessions: 5, serviceId: null, expiresOn: null });
    await attended();
    const detectIntent = vi.spyOn(deps.ai, 'detectIntent');

    const reply = joined(await chat.say('¿Cuántas sesiones me quedan?'));
    expect(reply).toContain('Estos son tus bonos:');
    expect(reply).toContain('🎟️ «Bono 10 sesiones»: te quedan 9 sesiones de 10, hasta el miércoles, 31 de marzo de 2027.');
    expect(reply).toContain('🎟️ «Bono masaje»: te quedan 5 sesiones de 5.');
    expect(detectIntent).not.toHaveBeenCalled();

    // A question about prices is not about their pack: it goes to the assistant as usual.
    const price = joined(await chat.say('¿Cuánto cuesta el bono de 10 sesiones?'));
    expect(price).not.toContain('te quedan');
    expect(detectIntent).toHaveBeenCalledTimes(1);
  });

  it('says when there is no pack, or the last one was used up or expired', async () => {
    const none = await scenario();
    expect(joined(await none.chat.say('¿me queda alguna sesión del bono?'))).toContain('No tienes ningún bono en Fisio Bonos.');

    const usedUp = await scenario();
    await createPack(usedUp.db, usedUp.tenant.id, usedUp.client.id, { name: 'Bono 1 sesión', totalSessions: 1, serviceId: null, expiresOn: null });
    await usedUp.attended();
    expect(joined(await usedUp.chat.say('mi bono'))).toContain('Ya has usado todas las sesiones de tu «Bono 1 sesión».');

    const expired = await scenario();
    await createPack(expired.db, expired.tenant.id, expired.client.id, { name: 'Bono verano', totalSessions: 5, serviceId: null, expiresOn: '2026-09-30' });
    expect(joined(await expired.chat.say('cuántas sesiones llevo'))).toContain('Tu «Bono verano» caducó el miércoles, 30 de septiembre de 2026.');
  });

  it('detects questions about the pack, not about free slots, prices or new bookings', () => {
    for (const yes of ['¿Cuántas sesiones me quedan?', 'cuantas sesiones tengo', '¿Me queda algo del bono?', 'Mi bono', '¿cuántas sesiones he gastado?', 'me faltan sesiones?']) {
      expect(detectPackRequest(yes), yes).toBe(true);
    }
    for (const no of [
      '¿Cuánto cuesta el bono de 10 sesiones?',
      '¿Quedan huecos para una sesión el martes?',
      '¿Os queda alguna sesión libre mañana?',
      'Quiero reservar una sesión',
      'Me faltan dos sesiones, quiero cita el lunes',
      'quiero cita mañana a las 10',
      '¿Cuántas sesiones tiene el bono?',
    ]) {
      expect(detectPackRequest(no), no).toBe(false);
    }
  });
});
