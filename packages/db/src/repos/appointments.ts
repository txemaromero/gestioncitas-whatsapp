import type { BusyAppointment } from '@clinicai/shared';
import type { Db } from '../client';
import type { AppointmentSource, AppointmentStatus } from '../generated/prisma/client';

const withPeople = {
  client: { select: { id: true, name: true, phone: true, email: true } },
  employee: { select: { id: true, name: true, role: true } },
  service: { select: { id: true, name: true } },
} as const;

export interface AppointmentPatch {
  clientId?: string;
  employeeId?: string;
  date?: Date;
  durationMinutes?: number;
  status?: AppointmentStatus;
  notes?: string | null;
}

export function appointmentsRepo(db: Db) {
  return {
    /** Appointments whose start is in [from, to); only one employee's when given (F18). */
    listInRange(tenantId: string, from: Date, to: Date, employeeId?: string) {
      return db.appointment.findMany({
        where: { tenantId, date: { gte: from, lt: to }, ...(employeeId ? { employeeId } : {}) },
        include: withPeople,
        orderBy: { date: 'asc' },
      });
    },

    upcoming(tenantId: string, now: Date, limit = 20, employeeId?: string) {
      return db.appointment.findMany({
        where: { tenantId, date: { gte: now }, ...(employeeId ? { employeeId } : {}) },
        include: withPeople,
        orderBy: { date: 'asc' },
        take: limit,
      });
    },

    /** Next non-cancelled appointments of a client (WhatsApp "Mis citas", F13). */
    upcomingForClient(tenantId: string, clientId: string, now: Date, limit = 10) {
      return db.appointment.findMany({
        where: { tenantId, clientId, date: { gte: now }, status: { not: 'cancelled' } },
        include: withPeople,
        orderBy: { date: 'asc' },
        take: limit,
      });
    },

    findById(tenantId: string, id: string) {
      return db.appointment.findFirst({ where: { tenantId, id }, include: withPeople });
    },

    /** Unchecked create (availability is validated by `bookAppointment`). */
    create(
      tenantId: string,
      data: {
        clientId: string;
        employeeId: string;
        date: Date;
        durationMinutes: number;
        status?: AppointmentStatus;
        source: AppointmentSource;
        notes?: string | null;
        serviceId?: string | null;
      },
    ) {
      return db.appointment.create({ data: { tenantId, ...data }, include: withPeople });
    },

    async update(tenantId: string, id: string, data: AppointmentPatch) {
      const { count } = await db.appointment.updateMany({ where: { tenantId, id }, data });
      if (count === 0) return null;
      return db.appointment.findFirst({ where: { tenantId, id }, include: withPeople });
    },

    /**
     * Changes the status; with `from`, only if the current one is among them (compare-and-set, F32:
     * a late "confirm" never brings back an appointment cancelled meanwhile). False if nothing changed.
     */
    async setStatus(tenantId: string, id: string, status: AppointmentStatus, options: { from?: AppointmentStatus[] } = {}) {
      const { count } = await db.appointment.updateMany({
        where: { tenantId, id, ...(options.from ? { status: { in: options.from } } : {}) },
        data: { status },
      });
      return count > 0;
    },

    async delete(tenantId: string, id: string) {
      const { count } = await db.appointment.deleteMany({ where: { tenantId, id } });
      return count > 0;
    },

    /** Non-cancelled appointments overlapping [from, to) for the given employees. */
    async findBusy(
      tenantId: string,
      from: Date,
      to: Date,
      employeeIds?: readonly string[],
    ): Promise<BusyAppointment[]> {
      // Appointments last at most 8 h, so look back that much to catch overlaps.
      const lookBack = new Date(from.getTime() - 8 * 60 * 60 * 1000);
      const rows = await db.appointment.findMany({
        where: {
          tenantId,
          status: { not: 'cancelled' },
          date: { gte: lookBack, lt: to },
          ...(employeeIds ? { employeeId: { in: [...employeeIds] } } : {}),
        },
        select: { id: true, employeeId: true, date: true, durationMinutes: true, status: true },
      });
      return rows;
    },

    /** Pending appointments of a client whose reminder was sent after `since`. */
    /**
     * Appointments of the client reminded since `since`, latest reminder first: the first reminder
     * (pending ones) or, F30, the second one the same day (pending or confirmed).
     */
    async findRecentlyReminded(tenantId: string, clientId: string, since: Date) {
      const rows = await db.appointment.findMany({
        where: {
          tenantId,
          clientId,
          OR: [
            { status: 'pending', reminderSentAt: { gte: since } },
            { status: { in: ['pending', 'confirmed'] }, secondReminderSentAt: { gte: since } },
          ],
        },
        include: withPeople,
      });
      const last = (a: (typeof rows)[number]) =>
        Math.max(a.reminderSentAt?.getTime() ?? 0, a.secondReminderSentAt?.getTime() ?? 0);
      return rows.sort((a, b) => last(b) - last(a));
    },

    countInRange(tenantId: string, from: Date, to: Date, status?: AppointmentStatus, employeeId?: string) {
      return db.appointment.count({
        where: { tenantId, date: { gte: from, lt: to }, ...(status ? { status } : {}), ...(employeeId ? { employeeId } : {}) },
      });
    },
  };
}

export type AppointmentsRepo = ReturnType<typeof appointmentsRepo>;
export type AppointmentWithPeople = NonNullable<
  Awaited<ReturnType<AppointmentsRepo['findById']>>
>;
