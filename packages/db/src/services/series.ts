/**
 * F26: treatments, a series of appointments created together (`appointments.series_id`).
 *  - planSeries: the dates of the pattern that can be booked with the same rules as any booking
 *    (`placementProblem`). A date that cannot is skipped (with its reason) and the pattern goes on
 *    until the sessions asked for are found, a few weeks at most (`SERIES_EXTRA_WEEKS`).
 *  - bookSeries: books the plan shown to the user, all or nothing, under the employee's lock. If
 *    the plan is no longer the same (someone booked meanwhile), nothing is booked.
 *  - cancelFollowing: cancels an appointment of a series and the later ones not yet attended.
 */
import { randomUUID } from 'node:crypto';
import { seriesCandidateLimit, seriesCandidates, type SeriesInterval, type SeriesSkipReason } from '@clinicai/shared';
import type { Db } from '../client';
import type { AppointmentStatus } from '../generated/prisma/client';
import { placementProblem, SlotUnavailableError, type DbOrTx } from './booking';

export interface SeriesInput {
  clientId: string;
  employeeId: string;
  serviceId: string | null;
  /** Date and local time of the series (sessions start at this time, from this date on). */
  first: Date;
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  intervalWeeks: SeriesInterval;
  sessions: number;
  durationMinutes: number;
  now?: Date;
}

export interface SeriesPlan {
  sessions: Date[];
  skipped: { start: Date; reason: SeriesSkipReason }[];
  /** All the sessions asked for were found. */
  complete: boolean;
}

/** The dates offered changed between the preview and the booking: nothing was booked. */
export class SeriesChangedError extends Error {
  constructor(public readonly plan: SeriesPlan) {
    super('The available dates of the series changed');
    this.name = 'SeriesChangedError';
  }
}

async function planWithin(tx: DbOrTx, tenantId: string, input: SeriesInput): Promise<SeriesPlan> {
  const [tenant, employee] = await Promise.all([
    tx.tenantConfig.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
    tx.employee.findFirst({ where: { tenantId, id: input.employeeId } }),
  ]);
  if (!tenant || !employee) throw new SlotUnavailableError('employee_not_found');
  const now = input.now ?? new Date();
  const candidates = seriesCandidates(
    { first: input.first, weekdays: input.weekdays, intervalWeeks: input.intervalWeeks, timeZone: tenant.timezone },
    seriesCandidateLimit(input.sessions, input.weekdays.length),
  );
  const plan: SeriesPlan = { sessions: [], skipped: [], complete: false };
  for (const start of candidates) {
    if (plan.sessions.length >= input.sessions) break;
    if (start.getTime() <= now.getTime()) {
      plan.skipped.push({ start, reason: 'past' });
      continue;
    }
    const problem = await placementProblem(tx, tenantId, {
      employee,
      start,
      durationMinutes: input.durationMinutes,
      timeZone: tenant.timezone,
    });
    if (problem) plan.skipped.push({ start, reason: problem as SeriesSkipReason });
    else plan.sessions.push(start);
  }
  plan.complete = plan.sessions.length === input.sessions;
  return plan;
}

/** What `bookSeries` would book now (a consistent read, without locks). */
export function planSeries(db: Db, tenantId: string, input: SeriesInput): Promise<SeriesPlan> {
  return db.$transaction((tx) => planWithin(tx, tenantId, input));
}

const sameDates = (a: Date[], b: Date[]) => a.length === b.length && a.every((d, i) => d.getTime() === b[i]?.getTime());

/**
 * Books the series if the dates are still `expected` (the plan the user saw). All the sessions go
 * in one transaction holding the employee's lock, like `bookAppointment`.
 */
export async function bookSeries(
  db: Db,
  tenantId: string,
  input: SeriesInput & { expected: Date[]; status: AppointmentStatus; notes: string | null },
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw<{ locked: number }[]>`
      SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${input.employeeId}::text))) AS l`;
    const [client, service] = await Promise.all([
      tx.client.findFirst({ where: { tenantId, id: input.clientId }, select: { id: true } }),
      input.serviceId ? tx.service.findFirst({ where: { tenantId, id: input.serviceId }, select: { id: true } }) : Promise.resolve(null),
    ]);
    if (!client) throw new SlotUnavailableError('client_not_found');
    if (input.serviceId && !service) throw new SlotUnavailableError('service_not_found');
    const plan = await planWithin(tx, tenantId, input);
    if (plan.sessions.length === 0 || !sameDates(plan.sessions, input.expected)) throw new SeriesChangedError(plan);
    const seriesId = randomUUID();
    const appointments = [];
    for (const start of plan.sessions) {
      appointments.push(
        await tx.appointment.create({
          data: {
            tenantId,
            clientId: input.clientId,
            employeeId: input.employeeId,
            serviceId: input.serviceId,
            date: start,
            durationMinutes: input.durationMinutes,
            status: input.status,
            notes: input.notes,
            source: 'web',
            seriesId,
          },
          select: { id: true, date: true },
        }),
      );
    }
    return { seriesId, appointments };
  });
}

/** Position of an appointment in its series («sesión 3 de 10»), counting the non-cancelled ones. */
export async function seriesPosition(db: Db, tenantId: string, appointment: { id: string; seriesId: string | null }) {
  if (!appointment.seriesId) return null;
  const sessions = await db.appointment.findMany({
    where: { tenantId, seriesId: appointment.seriesId, status: { not: 'cancelled' } },
    orderBy: { date: 'asc' },
    select: { id: true },
  });
  const index = sessions.findIndex((s) => s.id === appointment.id);
  return { seriesId: appointment.seriesId, index: index === -1 ? null : index + 1, total: sessions.length };
}

/**
 * Cancels the appointment and the later ones of its series that are not cancelled nor marked
 * (attended or no-show). Null when the appointment is not part of a series.
 */
export async function cancelFollowing(db: Db, tenantId: string, appointmentId: string) {
  return db.$transaction(async (tx) => {
    const appointment = await tx.appointment.findFirst({
      where: { tenantId, id: appointmentId },
      select: { seriesId: true, date: true },
    });
    if (!appointment?.seriesId) return null;
    const { count } = await tx.appointment.updateMany({
      where: {
        tenantId,
        seriesId: appointment.seriesId,
        date: { gte: appointment.date },
        status: { not: 'cancelled' },
        attendance: null,
      },
      data: { status: 'cancelled' },
    });
    return { seriesId: appointment.seriesId, cancelled: count };
  });
}
