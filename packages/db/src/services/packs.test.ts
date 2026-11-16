/**
 * F26 — session packs: which pack an attended appointment spends, giving the session back, no-shows,
 * the limits of editing and deleting, links between clients, isolation and GDPR.
 */
import { zonedTimeToUtc } from '@clinicai/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Db } from '../index';
import { runWithTenant } from '../tenant-context';
import { createAppointment, createClient, createEmployee, createService, createTenant, createTestAppDb, createTestDb } from '../testing';
import { markAttendance } from './attendance';
import { bookAppointment } from './booking';
import { clientPackSummaries, createPack, deletePack, listClientPacks, packHint, PackError, updatePack } from './packs';
import { eraseClient, exportClientData } from './privacy';

let db: Db;
let app: Db;
beforeAll(() => {
  db = createTestDb(inject('databaseUrl'));
  app = createTestAppDb(inject('appDatabaseUrl'));
});
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

const madrid = (month: number, day: number, hour = 10) => zonedTimeToUtc({ year: 2026, month, day, hour, minute: 0 }, 'Europe/Madrid');
const LATER = madrid(12, 31);
const pack = (totalSessions: number, extra: { serviceId?: string | null; expiresOn?: string | null; name?: string } = {}) => ({
  name: extra.name ?? `Bono ${totalSessions}`,
  totalSessions,
  serviceId: extra.serviceId ?? null,
  expiresOn: extra.expiresOn ?? null,
});

async function scenario(settings: { packNoShowSpends?: boolean } = {}) {
  const tenant = await createTenant(db, { settings });
  const employee = await createEmployee(db, tenant.id);
  const client = await createClient(db, tenant.id);
  const [massage, physio] = await Promise.all([createService(db, tenant.id, { name: 'Masaje' }), createService(db, tenant.id, { name: 'Fisioterapia' })]);
  const appointment = (day: number, serviceId: string | null = null) =>
    createAppointment(db, { tenantId: tenant.id, clientId: client.id, employeeId: employee.id, date: madrid(10, day), serviceId });
  const packOf = async (id: string) => (await db.appointment.findUniqueOrThrow({ where: { id } })).packId;
  return { tenant, employee, client, massage, physio, appointment, packOf };
}

describe('session packs (F26)', () => {
  it('an attended appointment spends the oldest valid pack for its service; clearing it gives it back', async () => {
    const { tenant, client, massage, physio, appointment, packOf } = await scenario();
    const generic = await createPack(db, tenant.id, client.id, pack(2, { name: 'General' }));
    const physioPack = await createPack(db, tenant.id, client.id, pack(5, { serviceId: physio.id, name: 'Fisio' }));
    await createPack(db, tenant.id, client.id, pack(5, { expiresOn: '2026-10-05', name: 'Caducado' }));

    const [a1, a2, a3, a4, a5] = await Promise.all([
      appointment(6, massage.id),
      appointment(7, physio.id),
      appointment(8, physio.id),
      appointment(9, massage.id),
      appointment(10, null),
    ]);
    for (const a of [a1, a2, a3, a4, a5]) expect(await markAttendance(db, tenant.id, a.id, 'attended', LATER)).toBe('ok');
    // Massage → the general one; physio → the general one (older) until it runs out, then «Fisio».
    expect(await packOf(a1.id)).toBe(generic.id);
    expect(await packOf(a2.id)).toBe(generic.id);
    expect(await packOf(a3.id)).toBe(physioPack.id);
    // Massage with the general one used up: «Fisio» is only for physio and «Caducado» expired.
    expect(await packOf(a4.id)).toBeNull();
    // Without a service, any pack with sessions left.
    expect(await packOf(a5.id)).toBe(physioPack.id);

    const listed = await listClientPacks(db, tenant.id, client.id, madrid(10, 20));
    expect(listed.map((p) => [p.name, p.used, p.remaining, p.state])).toEqual([
      ['General', 2, 0, 'used_up'],
      ['Fisio', 2, 3, 'active'],
      ['Caducado', 0, 5, 'expired'],
    ]);
    expect(listed[1]!.sessions.map((s) => s.id)).toEqual([a3.id, a5.id]);
    expect(listed[1]).toMatchObject({ serviceName: 'Fisioterapia', totalSessions: 5 });
    expect((await clientPackSummaries(db, tenant.id, client.id, madrid(10, 20))).filter((p) => p.state === 'active').map((p) => p.name)).toEqual(['Fisio']);

    // Marking it again keeps the same pack; clearing it gives the session back.
    expect(await markAttendance(db, tenant.id, a1.id, 'attended', LATER)).toBe('ok');
    expect(await packOf(a1.id)).toBe(generic.id);
    expect(await markAttendance(db, tenant.id, a1.id, null, LATER)).toBe('ok');
    expect(await packOf(a1.id)).toBeNull();
    expect(await markAttendance(db, tenant.id, a4.id, 'attended', LATER)).toBe('ok');
    expect(await packOf(a4.id)).toBe(generic.id);
  });

  it('a pack is valid through its last day, in the clinic zone', async () => {
    const { tenant, client, appointment, packOf } = await scenario();
    await createPack(db, tenant.id, client.id, pack(3, { expiresOn: '2026-10-06' }));
    // 6 October 23:30 in Madrid is already 7 October in UTC.
    const late = await createAppointment(db, {
      tenantId: tenant.id,
      clientId: client.id,
      employeeId: (await appointment(1)).employeeId,
      date: zonedTimeToUtc({ year: 2026, month: 10, day: 6, hour: 23, minute: 30 }, 'Europe/Madrid'),
    });
    const after = await appointment(7);
    await markAttendance(db, tenant.id, late.id, 'attended', LATER);
    await markAttendance(db, tenant.id, after.id, 'attended', LATER);
    expect(await packOf(late.id)).not.toBeNull();
    expect(await packOf(after.id)).toBeNull();
  });

  it('a no-show spends a session only if the clinic says so', async () => {
    const off = await scenario();
    await createPack(db, off.tenant.id, off.client.id, pack(3));
    const a = await off.appointment(6);
    await markAttendance(db, off.tenant.id, a.id, 'no_show', LATER);
    expect(await off.packOf(a.id)).toBeNull();

    const on = await scenario({ packNoShowSpends: true });
    const p = await createPack(db, on.tenant.id, on.client.id, pack(3));
    const b = await on.appointment(6);
    await markAttendance(db, on.tenant.id, b.id, 'no_show', LATER);
    expect(await on.packOf(b.id)).toBe(p.id);
    // From no-show to attended: the same session.
    await markAttendance(db, on.tenant.id, b.id, 'attended', LATER);
    expect(await on.packOf(b.id)).toBe(p.id);
  });

  it('moving or cancelling the appointment gives the session back', async () => {
    const { tenant, employee, client, appointment, packOf } = await scenario();
    await createPack(db, tenant.id, client.id, pack(3));
    const [moved, cancelled] = await Promise.all([appointment(6), appointment(7)]);
    for (const a of [moved, cancelled]) await markAttendance(db, tenant.id, a.id, 'attended', LATER);
    const common = { clientId: client.id, employeeId: employee.id, durationMinutes: 60, source: 'web' as const };
    await bookAppointment(db, tenant.id, { ...common, appointmentId: moved.id, start: madrid(10, 20) });
    await bookAppointment(db, tenant.id, { ...common, appointmentId: cancelled.id, start: madrid(10, 7), status: 'cancelled' });
    expect(await packOf(moved.id)).toBeNull();
    expect(await packOf(cancelled.id)).toBeNull();
  });

  it('cannot go below the sessions used, change the service once used, nor delete a used pack', async () => {
    const { tenant, client, physio, appointment, packOf } = await scenario();
    const p = await createPack(db, tenant.id, client.id, pack(3));
    const a = await appointment(6);
    await markAttendance(db, tenant.id, a.id, 'attended', LATER);
    // Down to the sessions used, yes; below, no.
    await expect(updatePack(db, tenant.id, p.id, pack(1))).resolves.toMatchObject({ totalSessions: 1 });
    await expect(updatePack(db, tenant.id, p.id, { ...pack(1), totalSessions: 0 })).rejects.toMatchObject({ reason: 'below_used' });
    // Used up: the next attended appointment spends nothing.
    const b = await appointment(7);
    await markAttendance(db, tenant.id, b.id, 'attended', LATER);
    expect(await packOf(b.id)).toBeNull();
    await expect(updatePack(db, tenant.id, p.id, pack(5, { serviceId: physio.id }))).rejects.toMatchObject({ reason: 'in_use' });
    await expect(deletePack(db, tenant.id, p.id)).rejects.toMatchObject({ reason: 'in_use' });
    await markAttendance(db, tenant.id, a.id, null, LATER);
    await expect(updatePack(db, tenant.id, p.id, pack(5, { serviceId: physio.id, expiresOn: '2027-06-30' }))).resolves.toMatchObject({
      totalSessions: 5,
    });
    await expect(deletePack(db, tenant.id, p.id)).resolves.toEqual({ id: p.id, clientId: client.id });
    await expect(deletePack(db, tenant.id, p.id)).rejects.toBeInstanceOf(PackError);
    const other = await scenario();
    await expect(createPack(db, tenant.id, other.client.id, pack(3))).rejects.toMatchObject({ reason: 'client_not_found' });
    await expect(createPack(db, tenant.id, client.id, pack(3, { serviceId: other.physio.id }))).rejects.toMatchObject({ reason: 'service_not_found' });
  });

  it('editing or deleting a pack waits for a concurrent attendance, never leaving it inconsistent (F34)', async () => {
    for (let round = 0; round < 5; round++) {
      const { tenant, client, appointment, packOf } = await scenario();
      const p = await createPack(db, tenant.id, client.id, pack(1));
      const a = await appointment(6);
      const [deleted, marked] = await Promise.allSettled([deletePack(db, tenant.id, p.id), markAttendance(db, tenant.id, a.id, 'attended', LATER)]);
      expect(marked).toMatchObject({ status: 'fulfilled', value: 'ok' });
      // Either the pack went first (nothing spent) or the session was spent first (pack in use).
      if (deleted.status === 'fulfilled') expect(await packOf(a.id)).toBeNull();
      else expect(deleted.reason).toMatchObject({ reason: 'in_use' });
    }
  });

  it('the database refuses an appointment spending the pack of another client', async () => {
    const { tenant, client, appointment } = await scenario();
    const someoneElse = await createClient(db, tenant.id);
    const theirs = await createPack(db, tenant.id, someoneElse.id, pack(3));
    const mine = await appointment(6);
    await expect(db.appointment.update({ where: { id: mine.id }, data: { packId: theirs.id } })).rejects.toThrow();
    expect(client.id).not.toBe(someoneElse.id);
  });

  it('hints the pack an appointment spent or would spend', async () => {
    const { tenant, client, physio, appointment } = await scenario();
    expect(await packHint(db, tenant.id, { clientId: client.id, serviceId: null, date: madrid(10, 6) })).toBeNull();
    await createPack(db, tenant.id, client.id, pack(10, { name: 'Bono 10 sesiones' }));
    const a = await appointment(6, physio.id);
    expect(await packHint(db, tenant.id, { clientId: client.id, serviceId: physio.id, date: madrid(10, 6), appointmentId: a.id })).toEqual({
      name: 'Bono 10 sesiones',
      remaining: 10,
      totalSessions: 10,
      spentHere: false,
    });
    await markAttendance(db, tenant.id, a.id, 'attended', LATER);
    expect(await packHint(db, tenant.id, { clientId: client.id, serviceId: physio.id, date: madrid(10, 6), appointmentId: a.id })).toMatchObject({
      remaining: 9,
      spentHere: true,
    });
  });

  it('the application role only sees the packs of its clinic', async () => {
    const a = await scenario();
    const b = await scenario();
    await createPack(db, a.tenant.id, a.client.id, pack(3));
    await runWithTenant(b.tenant.id, async () => {
      expect(await app.clientPack.count()).toBe(0);
      await expect(app.clientPack.create({ data: { tenantId: a.tenant.id, clientId: a.client.id, name: 'X', totalSessions: 1 } })).rejects.toThrow();
    });
    await runWithTenant(a.tenant.id, async () => {
      expect(await app.clientPack.count()).toBe(1);
    });
  });

  it('packs are exported with the client and erased with them', async () => {
    const { tenant, client, appointment } = await scenario();
    const p = await createPack(db, tenant.id, client.id, pack(10, { name: 'Bono 10 sesiones', expiresOn: '2027-03-31' }));
    const a = await appointment(6);
    await markAttendance(db, tenant.id, a.id, 'attended', LATER);
    const exported = await exportClientData(db, tenant.id, client.id);
    expect(exported.packs).toEqual([
      {
        id: p.id,
        name: 'Bono 10 sesiones',
        service: null,
        totalSessions: 10,
        usedSessions: 1,
        spentBy: [a.id],
        expiresOn: '2027-03-31',
        createdAt: expect.any(String),
      },
    ]);
    expect(exported.appointments[0]).toMatchObject({ pack: p.id, treatment: null });
    expect(await eraseClient(db, tenant.id, client.id)).toMatchObject({ appointments: 1, packs: 1 });
    expect(await db.clientPack.count({ where: { tenantId: tenant.id } })).toBe(0);
  });
});
