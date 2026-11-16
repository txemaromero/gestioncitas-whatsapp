/**
 * F15 — attendance and metrics.
 *  - markAttendance: the staff marks whether the client came (only for appointments that have
 *    already started and are not cancelled). Nothing is marked automatically. F26: in the same
 *    transaction, the appointment spends a session of the client's pack (or gives it back).
 *  - getMetrics: figures of a period in the tenant zone: appointments, no-show rate (over the
 *    marked ones; unmarked past appointments are reported apart), cancellations, channels,
 *    occupancy per professional (booked minutes / scheduled minutes minus time off) and services.
 */
import { attendanceSpendsSession, parseSchedule, parseTenantSettings, scheduledMinutes } from '@clinicai/shared';
import type { Db } from '../client';
import type { Attendance } from '../generated/prisma/client';
import { timeOffRepo } from '../repos/time-off';
import { packForAttendance } from './packs';

export type MarkAttendanceResult = 'ok' | 'not_found' | 'cancelled' | 'not_started';

/** Marks (or clears with null) the attendance of an appointment of the tenant. */
export async function markAttendance(
  db: Db,
  tenantId: string,
  appointmentId: string,
  attendance: Attendance | null,
  now = new Date(),
): Promise<MarkAttendanceResult> {
  return db.$transaction(async (tx) => {
    const [appointment, tenant] = await Promise.all([
      tx.appointment.findFirst({
        where: { tenantId, id: appointmentId },
        select: { id: true, date: true, status: true, clientId: true, serviceId: true, packId: true },
      }),
      tx.tenantConfig.findUnique({ where: { id: tenantId }, select: { timezone: true, settings: true } }),
    ]);
    if (!appointment || !tenant) return 'not_found';
    if (attendance !== null && appointment.status === 'cancelled') return 'cancelled';
    if (attendance !== null && appointment.date.getTime() > now.getTime()) return 'not_started';
    const spends = attendanceSpendsSession(attendance, parseTenantSettings(tenant.settings).packNoShowSpends);
    const packId = await packForAttendance(tx, tenantId, appointment, spends, tenant.timezone);
    await tx.appointment.updateMany({
      where: { tenantId, id: appointmentId },
      data: { attendance, attendanceMarkedAt: attendance === null ? null : now, packId },
    });
    return 'ok';
  });
}

/** Past, non-cancelled appointments without attendance since `since` (most recent first). */
export function listUnmarked(db: Db, tenantId: string, since: Date, now = new Date(), limit = 50, employeeId?: string) {
  return db.appointment.findMany({
    where: {
      tenantId,
      status: { not: 'cancelled' },
      attendance: null,
      date: { gte: since, lte: now },
      ...(employeeId ? { employeeId } : {}),
    },
    include: {
      client: { select: { id: true, name: true } },
      employee: { select: { id: true, name: true } },
      service: { select: { id: true, name: true } },
    },
    orderBy: { date: 'desc' },
    take: limit,
  });
}

export interface EmployeeMetrics {
  id: string;
  name: string;
  active: boolean;
  appointments: number;
  bookedMinutes: number;
  scheduledMinutes: number;
  /** booked / scheduled, null when the professional had no schedule in the period. */
  occupancy: number | null;
  attended: number;
  noShow: number;
}

export interface PeriodMetrics {
  from: Date;
  to: Date;
  /** All appointments starting in the period, cancelled included. */
  total: number;
  cancelled: number;
  /** Non-cancelled ones. */
  active: number;
  /** Non-cancelled that already started (attendance can be marked). */
  past: number;
  future: number;
  attended: number;
  noShow: number;
  unmarked: number;
  /** noShow / (attended + noShow); null without marked appointments. */
  noShowRate: number | null;
  /** cancelled / total; null without appointments. */
  cancellationRate: number | null;
  channels: { whatsapp: number; web: number };
  employees: EmployeeMetrics[];
  services: { id: string | null; name: string; appointments: number }[];
}

const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

export async function getMetrics(
  db: Db,
  tenantId: string,
  input: { from: Date; to: Date; timeZone: string; now?: Date },
): Promise<PeriodMetrics> {
  const now = input.now ?? new Date();
  const [appointments, employees, blocks] = await Promise.all([
    db.appointment.findMany({
      where: { tenantId, date: { gte: input.from, lt: input.to } },
      select: {
        employeeId: true,
        date: true,
        durationMinutes: true,
        status: true,
        source: true,
        attendance: true,
        serviceId: true,
        service: { select: { name: true } },
      },
    }),
    db.employee.findMany({ where: { tenantId }, select: { id: true, name: true, active: true, schedule: true }, orderBy: { name: 'asc' } }),
    timeOffRepo(db).findBlocks(tenantId, input.from, input.to),
  ]);

  const active = appointments.filter((a) => a.status !== 'cancelled');
  const past = active.filter((a) => a.date.getTime() <= now.getTime());
  const attended = past.filter((a) => a.attendance === 'attended').length;
  const noShow = past.filter((a) => a.attendance === 'no_show').length;

  const employeeRows: EmployeeMetrics[] = employees
    .map((e) => {
      const own = active.filter((a) => a.employeeId === e.id);
      const scheduled = scheduledMinutes({ id: e.id, schedule: parseSchedule(e.schedule) }, input.from, input.to, input.timeZone, blocks);
      const booked = own.reduce((sum, a) => sum + a.durationMinutes, 0);
      return {
        id: e.id,
        name: e.name,
        active: e.active,
        appointments: own.length,
        bookedMinutes: booked,
        scheduledMinutes: scheduled,
        occupancy: ratio(booked, scheduled),
        attended: own.filter((a) => a.attendance === 'attended').length,
        noShow: own.filter((a) => a.attendance === 'no_show').length,
      };
    })
    // Inactive professionals only appear if they had appointments in the period.
    .filter((e) => e.active || e.appointments > 0);

  const services = new Map<string | null, { id: string | null; name: string; appointments: number }>();
  for (const a of active) {
    const key = a.serviceId;
    const row = services.get(key) ?? { id: key, name: a.service?.name ?? 'Sin servicio', appointments: 0 };
    row.appointments += 1;
    services.set(key, row);
  }

  return {
    from: input.from,
    to: input.to,
    total: appointments.length,
    cancelled: appointments.length - active.length,
    active: active.length,
    past: past.length,
    future: active.length - past.length,
    attended,
    noShow,
    unmarked: past.length - attended - noShow,
    noShowRate: ratio(noShow, attended + noShow),
    cancellationRate: ratio(appointments.length - active.length, appointments.length),
    channels: {
      whatsapp: active.filter((a) => a.source === 'whatsapp').length,
      web: active.filter((a) => a.source === 'web').length,
    },
    employees: employeeRows,
    services: [...services.values()].sort((a, b) => b.appointments - a.appointments),
  };
}
