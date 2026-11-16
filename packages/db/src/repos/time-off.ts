import { addMinutes, intervalsOverlap, type TimeBlock } from '@clinicai/shared';
import type { Db } from '../client';

export interface TimeOffInput {
  /** Null → closure of the whole clinic. */
  employeeId: string | null;
  startsAt: Date;
  endsAt: Date;
  reason?: string | null;
}

export interface TimeOffBlock extends TimeBlock {
  id: string;
  reason: string | null;
}

const withEmployee = { employee: { select: { id: true, name: true } } } as const;

/**
 * Absences of professionals and clinic closures (F14). Every method takes `tenantId` first; the
 * composite FK (tenant_id, employee_id) rejects an absence for another tenant's employee.
 */
export function timeOffRepo(db: Db) {
  return {
    /** Time off overlapping [from, to), with the employee (calendar). */
    /** Time off in [from, to); with `employeeId`, only theirs and the clinic closures (F18). */
    listOverlapping(tenantId: string, from: Date, to: Date, employeeId?: string) {
      return db.timeOff.findMany({
        where: {
          tenantId,
          startsAt: { lt: to },
          endsAt: { gt: from },
          ...(employeeId ? { OR: [{ employeeId }, { employeeId: null }] } : {}),
        },
        include: withEmployee,
        orderBy: { startsAt: 'asc' },
      });
    },

    /** Not yet finished time off of an employee, or of the whole clinic when `employeeId` is null. */
    listUpcoming(tenantId: string, employeeId: string | null, now: Date) {
      return db.timeOff.findMany({
        where: { tenantId, employeeId, endsAt: { gt: now } },
        include: withEmployee,
        orderBy: { startsAt: 'asc' },
      });
    },

    create(tenantId: string, input: TimeOffInput) {
      return db.timeOff.create({
        data: { tenantId, employeeId: input.employeeId, startsAt: input.startsAt, endsAt: input.endsAt, reason: input.reason ?? null },
        include: withEmployee,
      });
    },

    async delete(tenantId: string, id: string): Promise<boolean> {
      const { count } = await db.timeOff.deleteMany({ where: { tenantId, id } });
      return count > 0;
    },

    /** Blocks for the availability rules: absences of the given employees (all when omitted) + closures. */
    async findBlocks(tenantId: string, from: Date, to: Date, employeeIds?: readonly string[]): Promise<TimeOffBlock[]> {
      const rows = await db.timeOff.findMany({
        where: {
          tenantId,
          startsAt: { lt: to },
          endsAt: { gt: from },
          ...(employeeIds ? { OR: [{ employeeId: null }, { employeeId: { in: [...employeeIds] } }] } : {}),
        },
        select: { id: true, employeeId: true, startsAt: true, endsAt: true, reason: true },
      });
      return rows.map((r) => ({ id: r.id, employeeId: r.employeeId, start: r.startsAt, end: r.endsAt, reason: r.reason }));
    },

    /** Non-cancelled appointments that a new time off would overlap (to warn the admin). */
    async overlappingAppointments(tenantId: string, input: Omit<TimeOffInput, 'reason'>) {
      // Appointments last at most 8 h: look back that much to catch the ones that started earlier.
      const rows = await db.appointment.findMany({
        where: {
          tenantId,
          status: { not: 'cancelled' },
          date: { gte: new Date(input.startsAt.getTime() - 8 * 3_600_000), lt: input.endsAt },
          ...(input.employeeId ? { employeeId: input.employeeId } : {}),
        },
        include: { client: { select: { name: true } }, employee: { select: { name: true } } },
        orderBy: { date: 'asc' },
      });
      return rows.filter((a) => intervalsOverlap(a.date, addMinutes(a.date, a.durationMinutes), input.startsAt, input.endsAt));
    },
  };
}

export type TimeOffRepo = ReturnType<typeof timeOffRepo>;
