/**
 * F17 — waiting list over the DB: windows, joining, fair offers (one at a time, oldest first),
 * accepting, and the GDPR functions.
 */
import { addMinutes, wholeDayWindow, zonedTimeToUtc, type ScheduleSlot } from '@clinicai/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Db } from '../index';
import { createAppointment, createClient, createEmployee, createService, createTenant, createTestDb } from '../testing';
import { bookAppointment } from './booking';
import { eraseClient, exportClientData } from './privacy';
import {
  acceptWaitlistOffer,
  claimWaitlistOffers,
  joinWaitlist,
  leaveWaitlist,
  listWaitlist,
  purgeWaitlist,
  waitlistWindowFor,
} from './waitlist';

const TZ = 'Europe/Madrid';
// 2031-01-06 is a Monday; "now" is the Sunday before at noon.
const at = (d: number, h: number, mi = 0) => zonedTimeToUtc({ year: 2031, month: 1, day: d, hour: h, minute: mi }, TZ);
const NOW = at(5, 12);
const MONDAY_9_11: ScheduleSlot[] = [{ day: 'monday', start: '09:00', end: '11:00' }];
const OPTIONS = { now: NOW, leadMinutes: 60, offerMinutes: 30, slotMinutes: 60, timeZone: TZ };

let db: Db;
beforeAll(() => {
  db = createTestDb(inject('databaseUrl'));
});
afterAll(async () => {
  await db.$disconnect();
});

/** One professional with two Monday slots (9:00 and 10:00), both booked. */
async function fullMonday() {
  const tenant = await createTenant(db, { settings: { slotMinutes: 60, waitlistEnabled: true } });
  const ana = await createEmployee(db, tenant.id, { name: 'Ana', schedule: MONDAY_9_11 });
  const other = await createClient(db, tenant.id, { name: 'Otra Persona' });
  const at9 = await createAppointment(db, { tenantId: tenant.id, clientId: other.id, employeeId: ana.id, date: at(6, 9) });
  const at10 = await createAppointment(db, { tenantId: tenant.id, clientId: other.id, employeeId: ana.id, date: at(6, 10) });
  const laura = await createClient(db, tenant.id, { name: 'Laura Martínez' });
  const pablo = await createClient(db, tenant.id, { name: 'Pablo Ruiz' });
  const cancel = (id: string) => db.appointment.update({ where: { id }, data: { status: 'cancelled' } });
  const join = (clientId: string, window = wholeDayWindow(at(6, 9), TZ), now = NOW) =>
    joinWaitlist(db, tenant.id, { clientId, serviceId: null, durationMinutes: 60, window, now });
  /** Joins and returns the new (or existing) entry. */
  const entry = async (clientId: string, window = wholeDayWindow(at(6, 9), TZ), now = NOW) => {
    const result = await join(clientId, window, now);
    if (result.status === 'limit') throw new Error('waiting list limit reached');
    return result.entry;
  };
  return { tenant, ana, other, at9, at10, laura, pablo, cancel, join, entry };
}

describe('waitlistWindowFor', () => {
  it('waits for the whole day when it is full, otherwise only for the requested time', async () => {
    const c = await fullMonday();
    const input = { start: at(6, 9), durationMinutes: 60, slotMinutes: 60, timeZone: TZ, now: NOW };
    expect(await waitlistWindowFor(db, c.tenant.id, input)).toEqual(wholeDayWindow(at(6, 9), TZ));
    await c.cancel(c.at10.id);
    expect(await waitlistWindowFor(db, c.tenant.id, input)).toEqual({ start: at(6, 9), end: at(6, 9), wholeDay: false, preferred: at(6, 9) });
  });
});

describe('joinWaitlist', () => {
  it('keeps one waiting entry per window and at most 3 per client', async () => {
    const c = await fullMonday();
    expect((await c.join(c.laura.id)).status).toBe('joined');
    expect((await c.join(c.laura.id)).status).toBe('already');
    await c.join(c.laura.id, wholeDayWindow(at(13, 9), TZ));
    await c.join(c.laura.id, wholeDayWindow(at(20, 9), TZ));
    expect(await c.join(c.laura.id, wholeDayWindow(at(27, 9), TZ))).toEqual({ status: 'limit', max: 3 });
    // Another client is not affected by Laura's limit.
    expect((await c.join(c.pablo.id, wholeDayWindow(at(27, 9), TZ))).status).toBe('joined');
  });
});

describe('claimWaitlistOffers', () => {
  it('offers a freed slot to the first client, holds it, and passes it on when the offer expires', async () => {
    const c = await fullMonday();
    const laura = await c.entry(c.laura.id);
    await c.entry(c.pablo.id);
    expect(await claimWaitlistOffers(db, c.tenant.id, OPTIONS)).toEqual([]);

    await c.cancel(c.at10.id);
    const [first, ...rest] = await claimWaitlistOffers(db, c.tenant.id, OPTIONS);
    expect(rest).toEqual([]);
    expect(first).toMatchObject({
      clientId: c.laura.id,
      clientName: 'Laura Martínez',
      start: at(6, 10),
      employeeId: c.ana.id,
      expiresAt: addMinutes(NOW, 30),
    });
    // While Laura's offer is open, Pablo does not get the same slot.
    expect(await claimWaitlistOffers(db, c.tenant.id, OPTIONS)).toEqual([]);

    const later = { ...OPTIONS, now: addMinutes(NOW, 31) };
    const [second] = await claimWaitlistOffers(db, c.tenant.id, later);
    expect(second).toMatchObject({ clientId: c.pablo.id, start: at(6, 10) });
    // Laura is not offered the same time again, but keeps waiting for another one.
    expect(await db.waitlistEntry.findUniqueOrThrow({ where: { id: laura.id } })).toMatchObject({ status: 'waiting', offeredStarts: [at(6, 10)] });
  });

  it('gives exact-time entries only that time', async () => {
    const c = await fullMonday();
    await c.cancel(c.at10.id);
    await c.join(c.laura.id, { start: at(6, 9), end: at(6, 9), wholeDay: false, preferred: at(6, 9) });
    expect(await claimWaitlistOffers(db, c.tenant.id, OPTIONS)).toEqual([]);
    await c.cancel(c.at9.id);
    expect(await claimWaitlistOffers(db, c.tenant.id, OPTIONS)).toMatchObject([{ clientId: c.laura.id, start: at(6, 9) }]);
  });

  it('closes entries booked by other means and expires those out of time', async () => {
    const c = await fullMonday();
    const laura = await c.entry(c.laura.id);
    // Pablo waited for Saturday, which has already passed.
    const pablo = await c.entry(c.pablo.id, wholeDayWindow(at(4, 9), TZ), at(4, 8));
    // Laura gets an appointment that Monday from the panel (with Luis); then a slot frees up.
    const luis = await createEmployee(db, c.tenant.id, { name: 'Luis', schedule: MONDAY_9_11 });
    await createAppointment(db, { tenantId: c.tenant.id, clientId: c.laura.id, employeeId: luis.id, date: at(6, 9) });
    await createAppointment(db, { tenantId: c.tenant.id, clientId: c.other.id, employeeId: luis.id, date: at(6, 10) });
    await c.cancel(c.at10.id);
    expect(await claimWaitlistOffers(db, c.tenant.id, OPTIONS)).toEqual([]);
    const status = async (id: string) => (await db.waitlistEntry.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(laura.id)).toBe('booked');
    expect(await status(pablo.id)).toBe('expired');
  });
});

describe('acceptWaitlistOffer', () => {
  it('books the offered slot once (pending, by WhatsApp, with the service)', async () => {
    const c = await fullMonday();
    const service = await createService(db, c.tenant.id, { name: 'Punción seca', durationMinutes: 60 });
    const joined = await joinWaitlist(db, c.tenant.id, {
      clientId: c.laura.id,
      serviceId: service.id,
      durationMinutes: 60,
      window: wholeDayWindow(at(6, 9), TZ),
      now: NOW,
    });
    if (joined.status === 'limit') throw new Error('unexpected');
    await c.cancel(c.at9.id);
    await claimWaitlistOffers(db, c.tenant.id, OPTIONS);

    const input = { entryId: joined.entry.id, clientId: c.laura.id, now: addMinutes(NOW, 5) };
    expect(await acceptWaitlistOffer(db, c.tenant.id, { ...input, clientId: c.pablo.id })).toEqual({ status: 'not_found' });
    const result = await acceptWaitlistOffer(db, c.tenant.id, input);
    expect(result.status).toBe('booked');
    if (result.status !== 'booked') return;
    expect(result.appointment).toMatchObject({
      clientId: c.laura.id,
      employeeId: c.ana.id,
      date: at(6, 9),
      status: 'pending',
      source: 'whatsapp',
      serviceId: service.id,
    });
    expect((await acceptWaitlistOffer(db, c.tenant.id, input)).status).toBe('closed');
  });

  it('keeps the client waiting when the slot was taken meanwhile', async () => {
    const c = await fullMonday();
    const laura = await c.entry(c.laura.id);
    await c.cancel(c.at10.id);
    await claimWaitlistOffers(db, c.tenant.id, OPTIONS);
    await bookAppointment(db, c.tenant.id, { clientId: c.other.id, employeeId: c.ana.id, start: at(6, 10), durationMinutes: 60, source: 'web' });

    const result = await acceptWaitlistOffer(db, c.tenant.id, { entryId: laura.id, clientId: c.laura.id, now: NOW });
    expect(result.status).toBe('taken');
    // Still waiting, and that time can be offered again if it frees up.
    expect(await db.waitlistEntry.findUniqueOrThrow({ where: { id: laura.id } })).toMatchObject({
      status: 'waiting',
      offerStart: null,
      offeredStarts: [],
    });
  });
});

describe('list, leave, privacy and purge', () => {
  it('lists and removes entries only within the tenant', async () => {
    const c = await fullMonday();
    const laura = await c.entry(c.laura.id);
    const other = await createTenant(db);
    expect(await listWaitlist(db, other.id, NOW)).toEqual([]);
    expect(await leaveWaitlist(db, other.id, laura.id)).toBe(false);
    expect((await listWaitlist(db, c.tenant.id, NOW)).map((e) => e.client.name)).toEqual(['Laura Martínez']);
    expect(await leaveWaitlist(db, c.tenant.id, laura.id, { clientId: c.pablo.id })).toBe(false);
    expect(await leaveWaitlist(db, c.tenant.id, laura.id)).toBe(true);
    expect(await listWaitlist(db, c.tenant.id, NOW)).toEqual([]);
  });

  it('exports the entries of a client and erases them with the client', async () => {
    const c = await fullMonday();
    await c.join(c.laura.id);
    const exported = await exportClientData(db, c.tenant.id, c.laura.id, NOW);
    expect(exported.waitlist).toMatchObject([{ wholeDay: true, status: 'waiting', timeZone: TZ, from: '2031-01-06T00:00:00+01:00' }]);
    expect(await eraseClient(db, c.tenant.id, c.laura.id)).toMatchObject({ waitlist: 1 });
    expect(await db.waitlistEntry.count({ where: { tenantId: c.tenant.id } })).toBe(0);
  });

  it('purges finished entries and those whose day passed long ago', async () => {
    const c = await fullMonday();
    const laura = await c.entry(c.laura.id);
    await leaveWaitlist(db, c.tenant.id, laura.id, { now: NOW });
    await c.entry(c.pablo.id);
    const count = () => db.waitlistEntry.count({ where: { tenantId: c.tenant.id } });
    await purgeWaitlist(db, NOW);
    expect(await count()).toBe(2);
    await purgeWaitlist(db, at(8, 0));
    expect(await count()).toBe(0);
  });
});
