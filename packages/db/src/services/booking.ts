/**
 * Transactional booking: revalidates availability inside a transaction that holds a
 * per-employee advisory lock, so two concurrent requests can never double-book a slot.
 * F14: time off (absences and clinic closures) is checked here too, and the appointment can
 * record the service booked.
 */
import { addMinutes, findBlock, hasConflict, isWithinSchedule, parseSchedule } from '@clinicai/shared';
import type { Db } from '../client';
import type { AppointmentSource, AppointmentStatus, Prisma } from '../generated/prisma/client';

export type SlotUnavailableReason =
  | 'employee_not_found'
  | 'client_not_found'
  | 'employee_inactive'
  | 'outside_schedule'
  | 'conflict'
  | 'appointment_not_found'
  | 'time_off'
  | 'service_not_found';

export class SlotUnavailableError extends Error {
  constructor(public readonly reason: SlotUnavailableReason) {
    super(`Slot unavailable: ${reason}`);
    this.name = 'SlotUnavailableError';
  }
}

export interface BookingInput {
  /** When set, the existing appointment is updated instead of created. */
  appointmentId?: string;
  clientId: string;
  employeeId: string;
  start: Date;
  durationMinutes: number;
  status?: AppointmentStatus;
  source: AppointmentSource;
  notes?: string | null;
  /** Service booked (F14). Undefined keeps the current one on updates; null removes it. */
  serviceId?: string | null;
  /** Admin override from the web: allow booking outside the employee's schedule. */
  allowOutsideSchedule?: boolean;
  /** Admin override from the web: allow overlapping appointments. */
  allowConflict?: boolean;
}

/** Prisma client or the client of an interactive transaction. */
export type DbOrTx = Prisma.TransactionClient;

export interface PlacementCheck {
  employee: { id: string; active: boolean; schedule: Prisma.JsonValue };
  start: Date;
  durationMinutes: number;
  timeZone: string;
  /** The appointment being edited does not conflict with itself. */
  ignoreAppointmentId?: string;
  allowOutsideSchedule?: boolean;
  allowConflict?: boolean;
  /** Time off only blocks new placements (default true). */
  checkTimeOff?: boolean;
}

/**
 * First reason why the employee cannot take the slot, or null. The rules of every booking (single
 * appointments and F26 treatments): active employee, within the schedule, no time off, no overlap.
 */
export async function placementProblem(tx: DbOrTx, tenantId: string, input: PlacementCheck): Promise<SlotUnavailableReason | null> {
  const { employee, start, durationMinutes } = input;
  if (!employee.active && !input.allowOutsideSchedule) return 'employee_inactive';
  if (!input.allowOutsideSchedule && !isWithinSchedule(parseSchedule(employee.schedule), start, durationMinutes, input.timeZone)) {
    return 'outside_schedule';
  }
  const end = addMinutes(start, durationMinutes);
  if (input.checkTimeOff !== false) {
    const timeOff = await tx.timeOff.findMany({
      where: {
        tenantId,
        startsAt: { lt: end },
        endsAt: { gt: start },
        OR: [{ employeeId: null }, { employeeId: employee.id }],
      },
      select: { employeeId: true, startsAt: true, endsAt: true },
    });
    const blocks = timeOff.map((t) => ({ employeeId: t.employeeId, start: t.startsAt, end: t.endsAt }));
    if (findBlock(employee.id, start, durationMinutes, blocks)) return 'time_off';
  }
  if (!input.allowConflict) {
    const busy = await tx.appointment.findMany({
      where: {
        tenantId,
        employeeId: employee.id,
        status: { not: 'cancelled' },
        date: { gte: new Date(start.getTime() - 8 * 60 * 60 * 1000), lt: end },
      },
      select: { id: true, employeeId: true, date: true, durationMinutes: true, status: true },
    });
    if (hasConflict(employee.id, start, durationMinutes, busy, input.ignoreAppointmentId)) return 'conflict';
  }
  return null;
}

const include = {
  client: { select: { id: true, name: true, phone: true, email: true } },
  employee: { select: { id: true, name: true, role: true } },
  service: { select: { id: true, name: true } },
} as const;

export async function bookAppointment(db: Db, tenantId: string, input: BookingInput) {
  return db.$transaction(async (tx) => {
    // Serialize bookings per employee for the lifetime of this transaction.
    await tx.$queryRaw<{ locked: number }[]>`
      SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${input.employeeId}::text))) AS l`;

    const [tenant, employee, client, existing] = await Promise.all([
      tx.tenantConfig.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
      tx.employee.findFirst({ where: { tenantId, id: input.employeeId } }),
      tx.client.findFirst({ where: { tenantId, id: input.clientId }, select: { id: true } }),
      input.appointmentId
        ? tx.appointment.findFirst({
            where: { tenantId, id: input.appointmentId },
            select: { id: true, date: true, employeeId: true, durationMinutes: true },
          })
        : Promise.resolve(null),
    ]);
    if (!tenant || !employee) throw new SlotUnavailableError('employee_not_found');
    if (!client) throw new SlotUnavailableError('client_not_found');
    if (input.appointmentId && !existing) throw new SlotUnavailableError('appointment_not_found');
    if (input.serviceId) {
      const service = await tx.service.findFirst({ where: { tenantId, id: input.serviceId }, select: { id: true } });
      if (!service) throw new SlotUnavailableError('service_not_found');
    }

    const cancelling = input.status === 'cancelled';
    if (!cancelling) {
      // Time off only blocks new placements: an appointment that a later absence overlaps can
      // still be edited (notes, status) without moving it.
      const placementChanged =
        !existing ||
        existing.date.getTime() !== input.start.getTime() ||
        existing.employeeId !== input.employeeId ||
        existing.durationMinutes !== input.durationMinutes;
      const problem = await placementProblem(tx, tenantId, {
        employee,
        start: input.start,
        durationMinutes: input.durationMinutes,
        timeZone: tenant.timezone,
        ...(input.appointmentId ? { ignoreAppointmentId: input.appointmentId } : {}),
        ...(input.allowOutsideSchedule !== undefined ? { allowOutsideSchedule: input.allowOutsideSchedule } : {}),
        ...(input.allowConflict !== undefined ? { allowConflict: input.allowConflict } : {}),
        checkTimeOff: placementChanged,
      });
      if (problem) throw new SlotUnavailableError(problem);
    }

    const data = {
      clientId: input.clientId,
      employeeId: input.employeeId,
      date: input.start,
      durationMinutes: input.durationMinutes,
      status: input.status ?? 'pending',
      notes: input.notes ?? null,
      ...(input.serviceId !== undefined ? { serviceId: input.serviceId } : {}),
    } satisfies Partial<Prisma.AppointmentUncheckedCreateInput>;

    if (existing) {
      return tx.appointment.update({
        where: { id: existing.id },
        data: {
          ...data,
          // A new date needs a new reminder, and the attendance (F15) no longer applies: the pack
          // session it spent (F26) goes back.
          ...(existing.date.getTime() !== input.start.getTime()
            ? { reminderSentAt: null, secondReminderSentAt: null, attendance: null, attendanceMarkedAt: null, packId: null }
            : {}),
          ...(input.status === 'cancelled' ? { attendance: null, attendanceMarkedAt: null, packId: null } : {}),
        },
        include,
      });
    }
    return tx.appointment.create({
      data: { tenantId, source: input.source, ...data },
      include,
    });
  });
}
