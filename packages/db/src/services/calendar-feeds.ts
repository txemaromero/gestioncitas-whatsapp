/**
 * F28: secret links to subscribe to a professional's agenda (iCalendar, read-only).
 *  - One per professional. The token (256 random bits, base64url) is looked up by its SHA-256 and
 *    kept encrypted with ENCRYPTION_KEY so the panel can show it again. A new one replaces it.
 *  - The feed has the professional's non-cancelled appointments from 30 days ago to 6 months ahead
 *    (client initials, or full names if chosen; never phone, email nor notes), their absences and
 *    the clinic closures.
 */
import { createHash, randomBytes } from 'node:crypto';
import { addMinutes, APPOINTMENT_STATUS_LABELS_ES, clientInitials, isWholeLocalDays, toZonedDateKey, type IcalEvent } from '@clinicai/shared';
import { decryptSecret, encryptSecret } from '@clinicai/shared/crypto';
import type { Db } from '../client';

export const CALENDAR_FEED_PAST_DAYS = 30;
export const CALENDAR_FEED_FUTURE_DAYS = 180;
/** base64url of 32 bytes. */
export const CALENDAR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** `last_used_at` is written at most this often (the apps poll the feed). */
const TOUCH_EVERY_MS = 60 * 60 * 1000;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface CalendarFeedView {
  employeeId: string;
  token: string;
  fullNames: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** Creates the link of a professional, or replaces it (the old one stops working). Null if no such professional. */
export async function createCalendarFeed(
  db: Db,
  tenantId: string,
  employeeId: string,
  input: { fullNames: boolean; encryptionKey: string; now?: Date },
): Promise<CalendarFeedView | null> {
  const employee = await db.employee.findFirst({ where: { tenantId, id: employeeId }, select: { id: true } });
  if (!employee) return null;
  const token = randomBytes(32).toString('base64url');
  const now = input.now ?? new Date();
  const data = { tokenHash: hashToken(token), tokenEnc: encryptSecret(token, input.encryptionKey), fullNames: input.fullNames, createdAt: now, lastUsedAt: null };
  const feed = await db.calendarFeed.upsert({
    where: { tenantId_employeeId: { tenantId, employeeId } },
    create: { tenantId, employeeId, ...data },
    update: data,
  });
  return { employeeId, token, fullNames: feed.fullNames, createdAt: feed.createdAt, lastUsedAt: feed.lastUsedAt };
}

export async function getCalendarFeed(db: Db, tenantId: string, employeeId: string, encryptionKey: string): Promise<CalendarFeedView | null> {
  const feed = await db.calendarFeed.findFirst({ where: { tenantId, employeeId } });
  if (!feed) return null;
  return { employeeId, token: decryptSecret(feed.tokenEnc, encryptionKey), fullNames: feed.fullNames, createdAt: feed.createdAt, lastUsedAt: feed.lastUsedAt };
}

/** Full names or initials. False when the professional has no link. */
export async function setCalendarFeedFullNames(db: Db, tenantId: string, employeeId: string, fullNames: boolean): Promise<boolean> {
  const { count } = await db.calendarFeed.updateMany({ where: { tenantId, employeeId }, data: { fullNames } });
  return count > 0;
}

export async function revokeCalendarFeed(db: Db, tenantId: string, employeeId: string): Promise<boolean> {
  const { count } = await db.calendarFeed.deleteMany({ where: { tenantId, employeeId } });
  return count > 0;
}

/** The link of a token, in any clinic (system connection: the request has no session). */
export async function findCalendarFeedByToken(systemDb: Db, token: string) {
  if (!CALENDAR_TOKEN_PATTERN.test(token)) return null;
  return systemDb.calendarFeed.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, tenantId: true, employeeId: true, fullNames: true, lastUsedAt: true, employee: { select: { name: true } } },
  });
}

/** Records the use of a link (at most once an hour). */
export async function touchCalendarFeed(systemDb: Db, feedId: string, now = new Date()): Promise<void> {
  await systemDb.calendarFeed.updateMany({
    where: { id: feedId, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - TOUCH_EVERY_MS) } }] },
    data: { lastUsedAt: now },
  });
}

/** Events of the agenda of a professional (inside the clinic's tenant context). */
export async function calendarFeedEvents(
  db: Db,
  tenantId: string,
  input: { employeeId: string; fullNames: boolean; clinicName: string; timeZone: string; now?: Date },
): Promise<IcalEvent[]> {
  const now = input.now ?? new Date();
  const from = new Date(now.getTime() - CALENDAR_FEED_PAST_DAYS * 86_400_000);
  const to = new Date(now.getTime() + CALENDAR_FEED_FUTURE_DAYS * 86_400_000);
  const [appointments, timeOff] = await Promise.all([
    db.appointment.findMany({
      where: { tenantId, employeeId: input.employeeId, status: { not: 'cancelled' }, date: { gte: from, lt: to } },
      orderBy: { date: 'asc' },
      select: {
        id: true,
        date: true,
        durationMinutes: true,
        status: true,
        client: { select: { name: true } },
        service: { select: { name: true } },
      },
    }),
    db.timeOff.findMany({
      where: { tenantId, startsAt: { lt: to }, endsAt: { gt: from }, OR: [{ employeeId: input.employeeId }, { employeeId: null }] },
      orderBy: { startsAt: 'asc' },
      select: { id: true, employeeId: true, startsAt: true, endsAt: true, reason: true },
    }),
  ]);
  const events: IcalEvent[] = appointments.map((a) => {
    const who = input.fullNames ? a.client.name : clientInitials(a.client.name);
    const status = APPOINTMENT_STATUS_LABELS_ES[a.status].toLowerCase();
    return {
      uid: `${a.id}@clinicai`,
      summary: a.service ? `${who} · ${a.service.name}` : who,
      description: `Cita en ${input.clinicName}. Estado: ${status}.`,
      start: a.date,
      end: addMinutes(a.date, a.durationMinutes),
      status: a.status === 'confirmed' ? 'CONFIRMED' : 'TENTATIVE',
    };
  });
  for (const t of timeOff) {
    // The reason of an absence is not shown (it may be about health); a closure's is.
    const summary = t.employeeId ? 'Ausencia' : `Clínica cerrada${t.reason ? `: ${t.reason}` : ''}`;
    const allDay = isWholeLocalDays(t.startsAt, t.endsAt, input.timeZone)
      ? { startKey: toZonedDateKey(t.startsAt, input.timeZone), endKey: toZonedDateKey(t.endsAt, input.timeZone) }
      : undefined;
    events.push({ uid: `${t.id}@clinicai`, summary, start: t.startsAt, end: t.endsAt, ...(allDay ? { allDay } : {}) });
  }
  return events;
}
