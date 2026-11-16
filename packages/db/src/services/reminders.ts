/**
 * Reminder selection, safe with several bot instances: the claim runs in a short
 * transaction guarded by a PostgreSQL advisory lock per tenant, and each appointment is
 * marked (`reminder_sent_at`) before sending, so it is reminded at most once.
 */
import type { Db } from '../client';
import { LOCK_NAMESPACES } from './locks';

/** Namespace for the two-key advisory lock (`pg_try_advisory_xact_lock(int, int)`). */
export const REMINDER_LOCK_NAMESPACE = LOCK_NAMESPACES.reminders;

export async function claimDueReminders(
  db: Db,
  tenantId: string,
  range: { start: Date; end: Date },
  now: Date,
) {
  return db.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${REMINDER_LOCK_NAMESPACE}::int, hashtext(${tenantId}::text)) AS locked`;
    if (!lock?.locked) return [];

    const due = await tx.appointment.findMany({
      where: {
        tenantId,
        status: 'pending',
        reminderSentAt: null,
        date: { gte: range.start, lt: range.end },
      },
      include: { client: { select: { id: true, name: true, phone: true } } },
      orderBy: { date: 'asc' },
    });
    const sendable = due.filter((a) => a.client.phone);
    if (sendable.length === 0) return [];
    await tx.appointment.updateMany({
      where: { id: { in: sendable.map((a) => a.id) }, reminderSentAt: null },
      data: { reminderSentAt: now },
    });
    return sendable;
  });
}

/** Undo a claim when the WhatsApp send failed, so the next run retries it. */
export async function releaseReminderClaim(db: Db, tenantId: string, appointmentId: string) {
  await db.appointment.updateMany({
    where: { tenantId, id: appointmentId },
    data: { reminderSentAt: null },
  });
}

/**
 * F30: namespace of the advisory lock of the second reminders (one per tenant, like the first).
 * F32: its own (it used to share the waiting list's, so one run could skip the other).
 */
export const SECOND_REMINDER_LOCK_NAMESPACE = LOCK_NAMESPACES.secondReminders;

/**
 * F30: appointments for the second reminder, the same day `hours` before: not cancelled, starting
 * after `now` and within `hours`, booked before that margin (an appointment made two hours before
 * gets no "reminder") and not reminded yet. Marked before sending, like the first ones.
 */
export async function claimSecondReminders(db: Db, tenantId: string, input: { now: Date; hours: number }) {
  const { now, hours } = input;
  const margin = hours * 60 * 60 * 1000;
  return db.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${SECOND_REMINDER_LOCK_NAMESPACE}::int, hashtext(${tenantId}::text)) AS locked`;
    if (!lock?.locked) return [];

    const candidates = await tx.appointment.findMany({
      where: {
        tenantId,
        status: { in: ['pending', 'confirmed'] },
        secondReminderSentAt: null,
        date: { gt: now, lte: new Date(now.getTime() + margin) },
      },
      include: { client: { select: { id: true, name: true, phone: true } } },
      orderBy: { date: 'asc' },
    });
    const sendable = candidates.filter((a) => a.client.phone && a.createdAt.getTime() <= a.date.getTime() - margin);
    if (sendable.length === 0) return [];
    await tx.appointment.updateMany({
      where: { id: { in: sendable.map((a) => a.id) }, secondReminderSentAt: null },
      data: { secondReminderSentAt: now },
    });
    return sendable;
  });
}

/** F30: undo the claim of a second reminder whose sending failed. */
export async function releaseSecondReminderClaim(db: Db, tenantId: string, appointmentId: string) {
  await db.appointment.updateMany({ where: { tenantId, id: appointmentId }, data: { secondReminderSentAt: null } });
}
