import { ANONYMIZED_CLIENT_NAME, PRIVACY_NOTICE_VERSION } from '@clinicai/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createRepos, type Db } from '../index';
import { createAppointment, createClient, createEmployee, createTenant, createTestDb, uniquePhone } from '../testing';
import {
  anonymizeClient,
  anonymizeInactiveClients,
  CHATWOOT_DELETE_CONTACT_JOB,
  ClientNotFoundError,
  eraseClient,
  exportClientData,
} from './privacy';

let db: Db;

beforeAll(() => {
  db = createTestDb(inject('databaseUrl'));
});

afterAll(async () => {
  await db.$disconnect();
});

const day = 24 * 3600_000;

/** A client with appointments and every kind of WhatsApp trace (state, pause, queue, Chatwoot). */
async function richClient(tenantId?: string, phone = uniquePhone()) {
  const tenant = tenantId ? { id: tenantId } : await createTenant(db);
  const employee = await createEmployee(db, tenant.id);
  const client = await createClient(db, tenant.id, { name: 'Laura Martínez', phone, email: 'laura@test.es', notes: 'Lumbalgia' });
  const appointment = await createAppointment(db, { tenantId: tenant.id, clientId: client.id, employeeId: employee.id, date: new Date(Date.now() + 2 * day) });
  await db.appointment.update({ where: { id: appointment.id }, data: { notes: 'Trae informe' } });
  await createAppointment(db, { tenantId: tenant.id, clientId: client.id, employeeId: employee.id, date: new Date(Date.now() - 30 * day) });
  const repos = createRepos(db);
  await repos.conversations.save(tenant.id, phone, { flow: 'cita', step: 'askDate', data: {}, errorCount: 0 }, new Date());
  await repos.blacklist.add(tenant.id, phone, 'agente');
  await repos.inboundEvents.enqueue({ source: 'whatsapp', externalId: `wamid.${crypto.randomUUID()}`, tenantId: tenant.id, phone, payload: { text: 'hola' } });
  const contactId = Math.floor(Math.random() * 1e9);
  await repos.chatwootLinks.upsert({ tenantId: tenant.id, phone, accountId: 7, inboxId: 5, contactId, conversationId: contactId + 1 });
  return { tenantId: tenant.id, employee, client, phone, contactId };
}

async function traces(tenantId: string, phone: string) {
  const [states, pauses, events, links] = await Promise.all([
    db.conversationState.count({ where: { tenantId, phone } }),
    db.botBlacklist.count({ where: { tenantId, phone } }),
    db.inboundEvent.count({ where: { tenantId, phone } }),
    db.chatwootLink.count({ where: { tenantId, phone } }),
  ]);
  return { states, pauses, events, links };
}

describe('eraseClient (right to erasure)', () => {
  it('removes the client, the appointments and every WhatsApp trace, and queues the Chatwoot clean-up', async () => {
    const s = await richClient();
    const summary = await eraseClient(db, s.tenantId, s.client.id);
    expect(summary).toEqual({ appointments: 2, waitlist: 0, packs: 0, conversationState: 1, botPause: 1, inboundEvents: 1, chatwootContactQueued: true });

    expect(await db.client.findUnique({ where: { id: s.client.id } })).toBeNull();
    expect(await db.appointment.count({ where: { clientId: s.client.id } })).toBe(0);
    expect(await traces(s.tenantId, s.phone)).toEqual({ states: 0, pauses: 0, events: 0, links: 0 });

    const job = await db.inboundEvent.findFirstOrThrow({ where: { tenantId: s.tenantId, source: 'internal' } });
    expect(job).toMatchObject({ phone: '', status: 'pending', payload: { type: CHATWOOT_DELETE_CONTACT_JOB, accountId: 7, contactId: s.contactId } });
    // No personal data in the job.
    const stored = JSON.stringify({ externalId: job.externalId, phone: job.phone, payload: job.payload });
    expect(stored).not.toContain(s.phone.slice(1));
    expect(stored).not.toContain('Laura');
  });

  it('only touches that tenant and that client', async () => {
    const phone = uniquePhone();
    const target = await richClient(undefined, phone);
    const sameTenantOther = await richClient(target.tenantId);
    const otherTenantSamePhone = await richClient(undefined, phone);

    await eraseClient(db, target.tenantId, target.client.id);
    expect(await traces(sameTenantOther.tenantId, sameTenantOther.phone)).toEqual({ states: 1, pauses: 1, events: 1, links: 1 });
    expect(await traces(otherTenantSamePhone.tenantId, phone)).toEqual({ states: 1, pauses: 1, events: 1, links: 1 });
    expect(await db.appointment.count({ where: { clientId: otherTenantSamePhone.client.id } })).toBe(2);
    // A client of another tenant cannot be erased through this tenant.
    await expect(eraseClient(db, target.tenantId, otherTenantSamePhone.client.id)).rejects.toBeInstanceOf(ClientNotFoundError);
  });

  it('works for clients created without phone', async () => {
    const tenant = await createTenant(db);
    const client = await createClient(db, tenant.id, { phone: null });
    expect(await eraseClient(db, tenant.id, client.id)).toMatchObject({ appointments: 0, chatwootContactQueued: false });
  });
});

describe('anonymizeClient / retention policy', () => {
  it('anonymises: personal data and WhatsApp traces go, appointments stay without notes', async () => {
    const s = await richClient();
    await anonymizeClient(db, s.tenantId, s.client.id);
    const client = await db.client.findUniqueOrThrow({ where: { id: s.client.id } });
    expect(client).toMatchObject({ name: ANONYMIZED_CLIENT_NAME, phone: null, email: null, notes: null, consentAt: null });
    expect(client.anonymizedAt).toBeInstanceOf(Date);
    const appointments = await db.appointment.findMany({ where: { clientId: s.client.id } });
    expect(appointments).toHaveLength(2);
    expect(appointments.every((a) => a.notes === null)).toBe(true);
    expect(await traces(s.tenantId, s.phone)).toEqual({ states: 0, pauses: 0, events: 0, links: 0 });
  });

  it('anonymises only clients inactive for retentionMonths, in tenants that enabled it, once', async () => {
    const now = new Date('2030-06-15T10:00:00Z');
    const longAgo = new Date('2027-01-01T10:00:00Z');
    const enabled = await createTenant(db, { settings: { retentionMonths: 24 } });
    const disabled = await createTenant(db);
    const employee = await createEmployee(db, enabled.id);

    const make = async (tenantId: string, name: string, createdAt: Date) => {
      const c = await createClient(db, tenantId, { name });
      await db.client.update({ where: { id: c.id }, data: { createdAt } });
      return c;
    };
    const inactive = await make(enabled.id, 'Inactivo', longAgo);
    const recentAppointment = await make(enabled.id, 'Cita reciente', longAgo);
    await createAppointment(db, { tenantId: enabled.id, clientId: recentAppointment.id, employeeId: employee.id, date: new Date('2029-03-01T10:00:00Z') });
    const futureAppointment = await make(enabled.id, 'Cita futura', longAgo);
    await createAppointment(db, { tenantId: enabled.id, clientId: futureAppointment.id, employeeId: employee.id, date: new Date('2031-01-01T10:00:00Z') });
    const oldAppointment = await make(enabled.id, 'Cita antigua', longAgo);
    await createAppointment(db, { tenantId: enabled.id, clientId: oldAppointment.id, employeeId: employee.id, date: new Date('2027-02-01T10:00:00Z') });
    const newClient = await make(enabled.id, 'Alta reciente', new Date('2030-01-01T10:00:00Z'));
    const otherTenant = await make(disabled.id, 'Sin política', longAgo);

    const first = await anonymizeInactiveClients(db, now);
    expect(first.clients).toBeGreaterThanOrEqual(2);
    const nameOf = async (id: string) => (await db.client.findUniqueOrThrow({ where: { id } })).name;
    expect(await nameOf(inactive.id)).toBe(ANONYMIZED_CLIENT_NAME);
    expect(await nameOf(oldAppointment.id)).toBe(ANONYMIZED_CLIENT_NAME);
    expect(await nameOf(recentAppointment.id)).toBe('Cita reciente');
    expect(await nameOf(futureAppointment.id)).toBe('Cita futura');
    expect(await nameOf(newClient.id)).toBe('Alta reciente');
    expect(await nameOf(otherTenant.id)).toBe('Sin política');

    const anonymizedAt = (await db.client.findUniqueOrThrow({ where: { id: inactive.id } })).anonymizedAt;
    await anonymizeInactiveClients(db, new Date(now.getTime() + day));
    expect((await db.client.findUniqueOrThrow({ where: { id: inactive.id } })).anonymizedAt).toEqual(anonymizedAt);
  });
});

describe('exportClientData (right of access)', () => {
  it('returns the client, consent, appointments in the tenant zone and the bot data', async () => {
    const s = await richClient();
    const data = await exportClientData(db, s.tenantId, s.client.id);
    expect(data).toMatchObject({
      format: 'clinicai.client-export.v1',
      controller: { clinic: 'Clínica Test' },
      client: {
        name: 'Laura Martínez',
        phone: s.phone,
        email: 'laura@test.es',
        notes: 'Lumbalgia',
        privacyNotice: { channel: 'whatsapp', version: PRIVACY_NOTICE_VERSION },
      },
      whatsappBot: { paused: true, activeConversation: { flow: 'cita', step: 'askDate' }, chatwoot: { contactId: s.contactId } },
    });
    expect(data.appointments).toHaveLength(2);
    expect(data.appointments[1]).toMatchObject({ professional: s.employee.name, notes: 'Trae informe', timeZone: 'Europe/Madrid' });
    expect(data.appointments[1]?.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    // JSON-serialisable as is.
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });

  it('is tenant-scoped', async () => {
    const s = await richClient();
    const other = await createTenant(db);
    await expect(exportClientData(db, other.id, s.client.id)).rejects.toBeInstanceOf(ClientNotFoundError);
  });
});

describe('clients repo consent', () => {
  it('stores, records and withdraws the privacy notice acceptance', async () => {
    const repos = createRepos(db);
    const tenant = await createTenant(db);
    const at = new Date('2026-11-11T10:00:00Z');
    const client = await repos.clients.create(tenant.id, { name: 'Sin Consentimiento', phone: uniquePhone() });
    expect(client.consentAt).toBeNull();
    const accepted = await repos.clients.recordConsent(tenant.id, client.id, { at, channel: 'whatsapp', version: PRIVACY_NOTICE_VERSION });
    expect(accepted).toMatchObject({ consentAt: at, consentChannel: 'whatsapp', consentVersion: PRIVACY_NOTICE_VERSION });
    const withdrawn = await repos.clients.update(tenant.id, client.id, { consent: null });
    expect(withdrawn).toMatchObject({ consentAt: null, consentChannel: null, consentVersion: null });
    const untouched = await repos.clients.update(tenant.id, client.id, { name: 'Otro Nombre' });
    expect(untouched.consentAt).toBeNull();
  });
});
