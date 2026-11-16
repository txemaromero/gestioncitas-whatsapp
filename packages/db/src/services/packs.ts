/**
 * F26: session packs (bonos) of a client.
 *  - A session is spent when an appointment is marked as attended (or as a no-show if the clinic
 *    says so): the appointment points to the pack (`appointments.pack_id`). Clearing or changing
 *    the attendance, moving or cancelling the appointment gives it back.
 *  - The pack used is the oldest one still valid on the date of the appointment, with sessions left,
 *    for its service (a pack without service is valid for any; an appointment without service can
 *    use any pack).
 *  - A pack can be edited but never below the sessions already used, and deleted only if unused.
 */
import { packState, toZonedDateKey, type PackFields, type PackState } from '@clinicai/shared';
import type { Db } from '../client';
import type { DbOrTx } from './booking';

export class PackError extends Error {
  constructor(public readonly reason: 'not_found' | 'client_not_found' | 'service_not_found' | 'below_used' | 'in_use') {
    super(`Pack error: ${reason}`);
    this.name = 'PackError';
  }
}

const toDate = (key: string | null) => (key ? new Date(`${key}T00:00:00Z`) : null);
const toKey = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

export interface PackSummary {
  id: string;
  name: string;
  serviceId: string | null;
  serviceName: string | null;
  totalSessions: number;
  used: number;
  remaining: number;
  /** Last day it can be used, `YYYY-MM-DD`; null = no expiry. */
  expiresOn: string | null;
  state: PackState;
  createdAt: Date;
}

const summaryInclude = {
  service: { select: { name: true } },
  _count: { select: { appointments: true } },
} as const;

function summarize(
  pack: { id: string; name: string; serviceId: string | null; totalSessions: number; expiresOn: Date | null; createdAt: Date; service: { name: string } | null; _count: { appointments: number } },
  todayKey: string,
): PackSummary {
  const used = pack._count.appointments;
  const expiresOn = toKey(pack.expiresOn);
  return {
    id: pack.id,
    name: pack.name,
    serviceId: pack.serviceId,
    serviceName: pack.service?.name ?? null,
    totalSessions: pack.totalSessions,
    used,
    remaining: Math.max(0, pack.totalSessions - used),
    expiresOn,
    state: packState({ totalSessions: pack.totalSessions, used, expiresOn }, todayKey),
    createdAt: pack.createdAt,
  };
}

async function clinicToday(db: DbOrTx, tenantId: string, now: Date): Promise<string> {
  const tenant = await db.tenantConfig.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  return toZonedDateKey(now, tenant?.timezone ?? 'Europe/Madrid');
}

/** Packs of a client, oldest first, with the appointments that spent their sessions. */
export async function listClientPacks(db: Db, tenantId: string, clientId: string, now = new Date()) {
  const todayKey = await clinicToday(db, tenantId, now);
  const packs = await db.clientPack.findMany({
    where: { tenantId, clientId },
    orderBy: { createdAt: 'asc' },
    include: {
      ...summaryInclude,
      appointments: { orderBy: { date: 'asc' }, select: { id: true, date: true, attendance: true } },
    },
  });
  return packs.map((pack) => ({ ...summarize(pack, todayKey), sessions: pack.appointments }));
}

/** Every pack of the client with its state, oldest first (the bot answers with these). */
export async function clientPackSummaries(db: Db, tenantId: string, clientId: string, now = new Date()) {
  const todayKey = await clinicToday(db, tenantId, now);
  const packs = await db.clientPack.findMany({ where: { tenantId, clientId }, orderBy: { createdAt: 'asc' }, include: summaryInclude });
  return packs.map((pack) => summarize(pack, todayKey));
}

async function checkService(db: DbOrTx, tenantId: string, serviceId: string | null): Promise<void> {
  if (serviceId && !(await db.service.findFirst({ where: { tenantId, id: serviceId }, select: { id: true } }))) {
    throw new PackError('service_not_found');
  }
}

export async function createPack(db: Db, tenantId: string, clientId: string, fields: PackFields) {
  const client = await db.client.findFirst({ where: { tenantId, id: clientId }, select: { id: true } });
  if (!client) throw new PackError('client_not_found');
  await checkService(db, tenantId, fields.serviceId);
  return db.clientPack.create({
    data: {
      tenantId,
      clientId,
      name: fields.name,
      totalSessions: fields.totalSessions,
      serviceId: fields.serviceId,
      expiresOn: toDate(fields.expiresOn),
    },
    select: { id: true, clientId: true, name: true, totalSessions: true },
  });
}

/**
 * The pack with its used sessions, read after taking the client's pack lock (F34): the same lock as
 * marking attendance, so no session is spent while the pack is being edited or deleted.
 */
async function lockedPack(tx: DbOrTx, tenantId: string, id: string) {
  const owner = await tx.clientPack.findFirst({ where: { tenantId, id }, select: { clientId: true } });
  if (!owner) throw new PackError('not_found');
  await lockClientPacks(tx, owner.clientId);
  const pack = await tx.clientPack.findFirst({ where: { tenantId, id }, include: { _count: { select: { appointments: true } } } });
  if (!pack) throw new PackError('not_found');
  return pack;
}

export async function updatePack(db: Db, tenantId: string, id: string, fields: PackFields) {
  return db.$transaction(async (tx) => {
    const pack = await lockedPack(tx, tenantId, id);
    const used = pack._count.appointments;
    if (fields.totalSessions < used) throw new PackError('below_used');
    // The service decides which appointments may use it: it cannot change once used.
    if (used > 0 && fields.serviceId !== pack.serviceId) throw new PackError('in_use');
    await checkService(tx, tenantId, fields.serviceId);
    return tx.clientPack.update({
      where: { tenantId_id: { tenantId, id } },
      data: { name: fields.name, totalSessions: fields.totalSessions, serviceId: fields.serviceId, expiresOn: toDate(fields.expiresOn) },
      select: { id: true, clientId: true, name: true, totalSessions: true },
    });
  });
}

export async function deletePack(db: Db, tenantId: string, id: string) {
  return db.$transaction(async (tx) => {
    const pack = await lockedPack(tx, tenantId, id);
    if (pack._count.appointments > 0) throw new PackError('in_use');
    await tx.clientPack.delete({ where: { tenantId_id: { tenantId, id } } });
    return { id, clientId: pack.clientId };
  });
}

/**
 * The pack an appointment of the client would spend (oldest valid one with sessions left). Inside
 * a transaction, after `lockClientPacks`, so two markings cannot take the last session twice.
 */
async function pickPack(tx: DbOrTx, tenantId: string, appointment: { clientId: string; serviceId: string | null; date: Date }, timeZone: string) {
  const dateKey = toZonedDateKey(appointment.date, timeZone);
  const packs = await tx.clientPack.findMany({
    where: {
      tenantId,
      clientId: appointment.clientId,
      ...(appointment.serviceId ? { OR: [{ serviceId: null }, { serviceId: appointment.serviceId }] } : {}),
      AND: [{ OR: [{ expiresOn: null }, { expiresOn: { gte: new Date(`${dateKey}T00:00:00Z`) } }] }],
    },
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { appointments: true } } },
  });
  return packs.find((p) => p._count.appointments < p.totalSessions) ?? null;
}

async function lockClientPacks(tx: DbOrTx, clientId: string): Promise<void> {
  await tx.$queryRaw<{ locked: number }[]>`
    SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${`pack:${clientId}`}::text))) AS l`;
}

/**
 * The pack whose session the appointment spends after its attendance is marked: keeps the one it
 * already spent, takes one when it starts spending, none when it does not spend.
 */
export async function packForAttendance(
  tx: DbOrTx,
  tenantId: string,
  appointment: { clientId: string; serviceId: string | null; date: Date; packId: string | null },
  spends: boolean,
  timeZone: string,
): Promise<string | null> {
  if (!spends) return null;
  if (appointment.packId) return appointment.packId;
  await lockClientPacks(tx, appointment.clientId);
  return (await pickPack(tx, tenantId, appointment, timeZone))?.id ?? null;
}

export interface PackHint {
  name: string;
  remaining: number;
  totalSessions: number;
  /** This appointment already spent a session of it. */
  spentHere: boolean;
}

/**
 * For the appointment dialog: the pack the appointment spent, or the one it would spend (for the
 * client and service, on `date`). Null when there is none.
 */
export async function packHint(
  db: Db,
  tenantId: string,
  input: { clientId: string; serviceId: string | null; date: Date; appointmentId?: string },
): Promise<PackHint | null> {
  const tenant = await db.tenantConfig.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  if (!tenant) return null;
  const spent = input.appointmentId
    ? await db.appointment.findFirst({ where: { tenantId, id: input.appointmentId }, select: { packId: true } })
    : null;
  const pack = spent?.packId
    ? await db.clientPack.findFirst({ where: { tenantId, id: spent.packId }, include: { _count: { select: { appointments: true } } } })
    : await pickPack(db, tenantId, input, tenant.timezone);
  if (!pack) return null;
  return {
    name: pack.name,
    remaining: Math.max(0, pack.totalSessions - pack._count.appointments),
    totalSessions: pack.totalSessions,
    spentHere: Boolean(spent?.packId),
  };
}
