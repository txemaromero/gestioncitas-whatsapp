/**
 * Waiting list (F17). Clients wait for a freed slot; a periodic job (and every cancellation made
 * through the bot) offers each free slot to the first client waiting for it, one offer at a time.
 * While an offer is open the slot is held for that client against other waiting clients only
 * (normal bookings are never blocked). Accepting books through `bookAppointment`, which checks
 * availability again inside its transaction.
 */
import {
  WAITLIST_MAX_ACTIVE_PER_CLIENT,
  addMinutes,
  exactTimeWindow,
  findWaitlistSlot,
  startOfZonedDay,
  wholeDayWindow,
  type BusyAppointment,
  type WaitlistWindow,
} from '@clinicai/shared';
import { randomUUID } from 'node:crypto';
import type { Db } from '../client';
import type { WaitlistEntry } from '../generated/prisma/client';
import { appointmentsRepo } from '../repos/appointments';
import { employeesRepo } from '../repos/employees';
import { timeOffRepo } from '../repos/time-off';
import { findNearbySlots, getAvailableEmployees } from './availability';
import { SlotUnavailableError, bookAppointment } from './booking';
import { LOCK_NAMESPACES } from './locks';

/** Internal queue job (F21): the bot offers freed slots of the clinic right away. */
export const WAITLIST_CHECK_JOB = 'waitlist.check';

/**
 * F21: the panel cannot send WhatsApp messages, so after a change that may free a slot it leaves a
 * job in the bot's inbound queue (picked up within a second) instead of waiting for the cron.
 */
export async function requestWaitlistCheck(db: Db, tenantId: string, reason: string): Promise<void> {
  await db.inboundEvent.createMany({
    data: [
      {
        source: 'internal',
        externalId: `${WAITLIST_CHECK_JOB}:${randomUUID()}`,
        tenantId,
        // Internal jobs of a tenant share this conversation key (it only serialises them).
        phone: '',
        payload: { type: WAITLIST_CHECK_JOB, reason },
      },
    ],
  });
}

/** Namespaces of the two-key advisory locks of the waiting list. */
export const WAITLIST_LOCK_NAMESPACE = LOCK_NAMESPACES.waitlist;
const WAITLIST_CLIENT_LOCK_NAMESPACE = LOCK_NAMESPACES.waitlistClient;
/** Appointments last at most 8 h (same look-back as `findBusy`). */
const MAX_DURATION_MS = 8 * 60 * 60 * 1000;

export type { WaitlistEntry };

/**
 * Window to wait for when `start` is not available: the whole day if no other time that day is
 * free (from now on), otherwise only that time.
 */
export async function waitlistWindowFor(
  db: Db,
  tenantId: string,
  input: { start: Date; durationMinutes: number; slotMinutes: number; timeZone: string; now: Date },
): Promise<WaitlistWindow> {
  const dayStart = startOfZonedDay(input.start, input.timeZone);
  const from = dayStart.getTime() > input.now.getTime() ? dayStart : input.now;
  const free = await findNearbySlots(db, tenantId, {
    from,
    durationMinutes: input.durationMinutes,
    slotMinutes: input.slotMinutes,
    timeZone: input.timeZone,
    limit: 1,
    maxDays: 0,
  });
  return free.length === 0 ? wholeDayWindow(input.start, input.timeZone) : exactTimeWindow(input.start);
}

export type JoinWaitlistResult =
  | { status: 'joined' | 'already'; entry: WaitlistEntry }
  | { status: 'limit'; max: number };

/** Adds a client to the waiting list (one waiting entry per window, a few per client). */
export async function joinWaitlist(
  db: Db,
  tenantId: string,
  input: { clientId: string; serviceId: string | null; durationMinutes: number; window: WaitlistWindow; now: Date },
): Promise<JoinWaitlistResult> {
  return db.$transaction(async (tx) => {
    // Serialise the joins of one client so the limit cannot be exceeded by concurrent messages.
    await tx.$queryRaw`
      SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(${WAITLIST_CLIENT_LOCK_NAMESPACE}::int, hashtext(${input.clientId}::text))) AS l`;
    const existing = await tx.waitlistEntry.findFirst({
      where: { tenantId, clientId: input.clientId, status: 'waiting', windowStart: input.window.start },
    });
    if (existing) return { status: 'already', entry: existing };
    const active = await tx.waitlistEntry.count({
      where: { tenantId, clientId: input.clientId, status: 'waiting', windowEnd: { gte: input.now } },
    });
    if (active >= WAITLIST_MAX_ACTIVE_PER_CLIENT) return { status: 'limit', max: WAITLIST_MAX_ACTIVE_PER_CLIENT };
    const entry = await tx.waitlistEntry.create({
      data: {
        tenantId,
        clientId: input.clientId,
        serviceId: input.serviceId,
        durationMinutes: input.durationMinutes,
        windowStart: input.window.start,
        windowEnd: input.window.end,
        wholeDay: input.window.wholeDay,
        preferredStart: input.window.preferred,
      },
    });
    return { status: 'joined', entry };
  });
}

const listInclude = {
  client: { select: { id: true, name: true, phone: true } },
  service: { select: { id: true, name: true } },
} as const;

/** Waiting entries still in time, by wanted date and then by arrival (panel). */
export async function listWaitlist(db: Db, tenantId: string, now: Date) {
  return db.waitlistEntry.findMany({
    where: { tenantId, status: 'waiting', windowEnd: { gte: now } },
    include: listInclude,
    orderBy: [{ windowStart: 'asc' }, { createdAt: 'asc' }],
  });
}
export type WaitlistListItem = Awaited<ReturnType<typeof listWaitlist>>[number];

/** Removes a waiting entry (the client said no, or the clinic removed it). */
export async function leaveWaitlist(
  db: Db,
  tenantId: string,
  entryId: string,
  options: { clientId?: string; now?: Date } = {},
): Promise<boolean> {
  const { count } = await db.waitlistEntry.updateMany({
    where: { tenantId, id: entryId, status: 'waiting', ...(options.clientId ? { clientId: options.clientId } : {}) },
    data: { status: 'left', closedAt: options.now ?? new Date(), offerExpiresAt: null },
  });
  return count > 0;
}

export interface WaitlistOffer {
  entryId: string;
  clientId: string;
  clientName: string;
  phone: string;
  start: Date;
  employeeId: string;
  durationMinutes: number;
  serviceName: string | null;
  expiresAt: Date;
}

/**
 * Finds a free slot for each waiting entry (oldest first) and records the offer. Safe with several
 * bot instances: one run per tenant at a time (advisory lock); the caller sends the messages.
 */
export async function claimWaitlistOffers(
  db: Db,
  tenantId: string,
  options: { now: Date; leadMinutes: number; offerMinutes: number; slotMinutes: number; timeZone: string },
): Promise<WaitlistOffer[]> {
  const { now } = options;
  const earliest = addMinutes(now, options.leadMinutes);
  return db.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${WAITLIST_LOCK_NAMESPACE}::int, hashtext(${tenantId}::text)) AS locked`;
      if (!lock?.locked) return [];

      // Entries that can no longer get a slot in time expire (unless an offer is still open).
      await tx.waitlistEntry.updateMany({
        where: {
          tenantId,
          status: 'waiting',
          windowEnd: { lt: earliest },
          OR: [{ offerExpiresAt: null }, { offerExpiresAt: { lte: now } }],
        },
        data: { status: 'expired', closedAt: now },
      });

      const waiting = await tx.waitlistEntry.findMany({
        where: { tenantId, status: 'waiting' },
        include: listInclude,
        orderBy: { createdAt: 'asc' },
      });
      const isOpen = (e: WaitlistEntry) => e.offerExpiresAt !== null && e.offerExpiresAt.getTime() > now.getTime();
      const holds: BusyAppointment[] = waiting
        .filter((e) => isOpen(e) && e.offerStart && e.offerEmployeeId)
        .map((e) => ({ employeeId: e.offerEmployeeId!, date: e.offerStart!, durationMinutes: e.durationMinutes, status: 'held' }));
      const candidates = waiting.filter((e) => !isOpen(e) && e.client.phone);
      if (candidates.length === 0) return [];

      const rangeStart = new Date(Math.min(...candidates.map((e) => e.windowStart.getTime())));
      const rangeEnd = new Date(Math.max(...candidates.map((e) => e.windowEnd.getTime())) + MAX_DURATION_MS);
      const [employees, busy, blocks, clientAppointments] = await Promise.all([
        employeesRepo(db).listBookable(tenantId),
        appointmentsRepo(db).findBusy(tenantId, rangeStart, rangeEnd),
        timeOffRepo(db).findBlocks(tenantId, rangeStart, rangeEnd),
        tx.appointment.findMany({
          where: {
            tenantId,
            clientId: { in: [...new Set(candidates.map((e) => e.clientId))] },
            status: { not: 'cancelled' },
            date: { gte: rangeStart, lt: rangeEnd },
          },
          select: { clientId: true, date: true, createdAt: true },
        }),
      ]);
      const occupied = [...busy, ...holds];

      const offers: WaitlistOffer[] = [];
      for (const entry of candidates) {
        // Booked in the meantime by other means (by phone, from the panel…): nothing to offer.
        const alreadyBooked = clientAppointments.some(
          (a) =>
            a.clientId === entry.clientId &&
            a.createdAt.getTime() > entry.createdAt.getTime() &&
            a.date.getTime() >= entry.windowStart.getTime() &&
            a.date.getTime() <= entry.windowEnd.getTime(),
        );
        if (alreadyBooked) {
          await tx.waitlistEntry.update({ where: { id: entry.id }, data: { status: 'booked', closedAt: now } });
          continue;
        }
        const slot = findWaitlistSlot({
          employees,
          busy: occupied,
          blocks,
          window: { start: entry.windowStart, end: entry.windowEnd, wholeDay: entry.wholeDay, preferred: entry.preferredStart },
          earliest,
          durationMinutes: entry.durationMinutes,
          slotMinutes: options.slotMinutes,
          timeZone: options.timeZone,
          exclude: entry.offeredStarts,
        });
        if (!slot) continue;
        const expiresAt = addMinutes(now, options.offerMinutes);
        await tx.waitlistEntry.update({
          where: { id: entry.id },
          data: {
            offerStart: slot.start,
            offerEmployeeId: slot.employeeId,
            offerExpiresAt: expiresAt,
            offeredStarts: { push: slot.start },
          },
        });
        occupied.push({ employeeId: slot.employeeId, date: slot.start, durationMinutes: entry.durationMinutes, status: 'held' });
        offers.push({
          entryId: entry.id,
          clientId: entry.clientId,
          clientName: entry.client.name,
          phone: entry.client.phone!,
          start: slot.start,
          employeeId: slot.employeeId,
          durationMinutes: entry.durationMinutes,
          serviceName: entry.service?.name ?? null,
          expiresAt,
        });
      }
      return offers;
    },
    { timeout: 20_000 },
  );
}

/** The offer could not be sent: release the hold (that start is not offered to this entry again). */
export async function releaseWaitlistOffer(db: Db, tenantId: string, entryId: string): Promise<void> {
  await db.waitlistEntry.updateMany({
    where: { tenantId, id: entryId },
    data: { offerStart: null, offerEmployeeId: null, offerExpiresAt: null },
  });
}

/** A waiting list entry of this client (any status). */
export async function findWaitlistEntry(db: Db, tenantId: string, entryId: string, clientId: string) {
  return db.waitlistEntry.findFirst({ where: { tenantId, id: entryId, clientId } });
}

/** Waiting entry of this client with an offer still open (text answers like «sí»). */
export async function findOpenWaitlistOffer(db: Db, tenantId: string, clientId: string, now: Date) {
  return db.waitlistEntry.findFirst({
    where: { tenantId, clientId, status: 'waiting', offerExpiresAt: { gt: now } },
    orderBy: { offerExpiresAt: 'desc' },
    include: listInclude,
  });
}

export type AcceptWaitlistResult =
  | { status: 'booked'; entry: WaitlistEntry; appointment: Awaited<ReturnType<typeof bookAppointment>> }
  | { status: 'taken' | 'closed' | 'no_offer'; entry: WaitlistEntry }
  | { status: 'not_found' };

/**
 * The client accepts the offer: books the offered slot with the offered professional, or with
 * another one free at that time. A late answer still works unless the slot is now offered to
 * another waiting client or was taken.
 */
export async function acceptWaitlistOffer(
  db: Db,
  tenantId: string,
  input: { entryId: string; clientId: string; now: Date },
): Promise<AcceptWaitlistResult> {
  const { now } = input;
  const entry = await db.waitlistEntry.findFirst({ where: { tenantId, id: input.entryId, clientId: input.clientId } });
  if (!entry) return { status: 'not_found' };
  if (entry.status !== 'waiting') return { status: 'closed', entry };
  const start = entry.offerStart;
  if (!start) return { status: 'no_offer', entry };

  // Taken by someone else: the client keeps waiting and that time may be offered again if it frees up.
  const release = async (): Promise<AcceptWaitlistResult> => {
    const updated = await db.waitlistEntry.update({
      where: { id: entry.id },
      data: {
        status: 'waiting',
        closedAt: null,
        offerStart: null,
        offerEmployeeId: null,
        offerExpiresAt: null,
        offeredStarts: entry.offeredStarts.filter((d) => d.getTime() !== start.getTime()),
      },
    });
    return { status: 'taken', entry: updated };
  };
  if (start.getTime() <= now.getTime()) return release();

  // Professionals held for other waiting clients at that time are not used.
  const heldByOthers = await db.waitlistEntry.findMany({
    where: { tenantId, status: 'waiting', id: { not: entry.id }, offerStart: start, offerExpiresAt: { gt: now } },
    select: { offerEmployeeId: true },
  });
  const held = new Set(heldByOthers.map((e) => e.offerEmployeeId));
  const offered = entry.offerEmployeeId && !held.has(entry.offerEmployeeId) ? [entry.offerEmployeeId] : [];
  const others = (await getAvailableEmployees(db, tenantId, start, entry.durationMinutes))
    .map((e) => e.id)
    .filter((id) => !held.has(id) && !offered.includes(id));

  // Claim the entry first so a double tap can never book twice.
  const { count } = await db.waitlistEntry.updateMany({
    where: { tenantId, id: entry.id, status: 'waiting', offerStart: start },
    data: { status: 'booked', closedAt: now, offerExpiresAt: null },
  });
  if (count === 0) return { status: 'closed', entry };

  for (const employeeId of [...offered, ...others]) {
    try {
      const appointment = await bookAppointment(db, tenantId, {
        clientId: entry.clientId,
        employeeId,
        start,
        durationMinutes: entry.durationMinutes,
        serviceId: entry.serviceId,
        status: 'pending',
        source: 'whatsapp',
      });
      return { status: 'booked', entry: { ...entry, status: 'booked', closedAt: now }, appointment };
    } catch (error) {
      if (!(error instanceof SlotUnavailableError)) {
        await release();
        throw error;
      }
    }
  }
  return release();
}

/** Deletes closed entries (and waiting ones whose day passed) older than `before` (maintenance). */
export async function purgeWaitlist(db: Db, before: Date): Promise<number> {
  const { count } = await db.waitlistEntry.deleteMany({
    where: { OR: [{ status: { not: 'waiting' }, closedAt: { lt: before } }, { windowEnd: { lt: before } }] },
  });
  return count;
}
