import {
  bookAppointment,
  bookSeries,
  cancelFollowing,
  checkEmployeeSlot,
  getAvailableEmployees,
  listUnmarked,
  markAttendance,
  packHint,
  planSeries,
  SeriesChangedError,
  seriesPosition,
  SlotUnavailableError,
  type Repos,
  type SlotUnavailableReason,
} from '@clinicai/db';
import { isAdminRole, SERIES_MAX_SESSIONS, SERIES_MIN_SESSIONS, zonedDayRange, type MemberRoleValue } from '@clinicai/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { assertOwnEmployee, createTRPCRouter, protectedProcedure } from '../trpc';
import { listRangeInput } from '../list-range';
import { notifyWaitlist } from '../waitlist-check';

/**
 * F32: booking outside the professional's schedule (or for an inactive one) is an administrator
 * override; a professional cannot use it, not even for their own agenda.
 */
function outsideScheduleOverride(role: MemberRoleValue, force: boolean | undefined): boolean {
  if (!force) return false;
  if (!isAdminRole(role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Solo un administrador puede crear citas fuera del horario del profesional' });
  }
  return true;
}

const STATUS = z.enum(['pending', 'confirmed', 'cancelled']);

const appointmentInput = z.object({
  clientId: z.uuid('Selecciona un cliente'),
  employeeId: z.uuid('Selecciona un empleado'),
  start: z.date(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  status: STATUS,
  notes: z.string().trim().max(1000).nullable().optional(),
  /** Service booked (F14); its duration is used when `durationMinutes` is not given. */
  serviceId: z.uuid().nullable().optional(),
  /** Admin override: allow the appointment outside the employee's schedule (explicit warning in the UI). */
  force: z.boolean().optional(),
});

/** F26: a treatment, sessions at the time of `first` on the chosen weekdays. */
const seriesInput = z.object({
  clientId: z.uuid('Selecciona un cliente'),
  employeeId: z.uuid('Selecciona un empleado'),
  serviceId: z.uuid().nullable(),
  first: z.date(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1, 'Elige al menos un día').max(7),
  intervalWeeks: z.union([z.literal(1), z.literal(2)]),
  sessions: z.number().int().min(SERIES_MIN_SESSIONS).max(SERIES_MAX_SESSIONS),
});

const REASON_MESSAGES: Record<SlotUnavailableReason, { code: 'CONFLICT' | 'BAD_REQUEST' | 'NOT_FOUND'; message: string }> = {
  conflict: { code: 'CONFLICT', message: 'El empleado ya tiene una cita que se solapa con ese horario' },
  outside_schedule: { code: 'BAD_REQUEST', message: 'La cita queda fuera del horario del empleado' },
  employee_inactive: { code: 'BAD_REQUEST', message: 'El empleado está desactivado' },
  employee_not_found: { code: 'NOT_FOUND', message: 'Empleado no encontrado' },
  client_not_found: { code: 'NOT_FOUND', message: 'Cliente no encontrado' },
  appointment_not_found: { code: 'NOT_FOUND', message: 'Cita no encontrada' },
  time_off: { code: 'CONFLICT', message: 'El empleado está ausente o la clínica está cerrada en ese horario' },
  service_not_found: { code: 'NOT_FOUND', message: 'Servicio no encontrado' },
};

/** Duration of a service of the tenant (F14), or undefined when none was chosen. */
async function serviceDuration(repos: Repos, tenantId: string, serviceId: string | null | undefined): Promise<number | undefined> {
  if (!serviceId) return undefined;
  const service = await repos.services.findById(tenantId, serviceId);
  if (!service) throw new TRPCError({ code: 'NOT_FOUND', message: 'Servicio no encontrado' });
  return service.durationMinutes;
}

function toTRPCError(error: unknown): never {
  if (error instanceof SlotUnavailableError) {
    const { code, message } = REASON_MESSAGES[error.reason];
    throw new TRPCError({ code, message, cause: error });
  }
  throw error;
}

/** The appointment, if it exists in the tenant and the user may manage it (F18: own for professionals). */
async function ownAppointment(ctx: { repos: Repos; tenantId: string; ownEmployeeId: string | undefined }, id: string) {
  const appointment = await ctx.repos.appointments.findById(ctx.tenantId, id);
  if (!appointment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Cita no encontrada' });
  assertOwnEmployee(ctx, appointment.employeeId);
  return appointment;
}

/**
 * F18: every query is limited to the professional's own employee (`ctx.ownEmployeeId`); owner and
 * administrators see the whole clinic.
 */
export const appointmentsRouter = createTRPCRouter({
  /** Appointments whose start is in [from, to) — calendar range. */
  list: protectedProcedure
    .input(listRangeInput)
    .query(({ ctx, input }) => ctx.repos.appointments.listInRange(ctx.tenantId, input.from, input.to, ctx.ownEmployeeId)),

  upcoming: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(20) }).default({ limit: 20 }))
    .query(({ ctx, input }) => ctx.repos.appointments.upcoming(ctx.tenantId, new Date(), input.limit, ctx.ownEmployeeId)),

  /** Dashboard summary: today's appointments and pending confirmations. */
  today: protectedProcedure.query(async ({ ctx }) => {
    const tenant = await ctx.repos.tenants.findById(ctx.tenantId);
    if (!tenant) throw new TRPCError({ code: 'NOT_FOUND' });
    const { start, end } = zonedDayRange(new Date(), 0, tenant.timezone);
    const [list, pendingUpcoming] = await Promise.all([
      ctx.repos.appointments.listInRange(ctx.tenantId, start, end, ctx.ownEmployeeId),
      ctx.repos.appointments.countInRange(
        ctx.tenantId,
        new Date(),
        new Date(Date.now() + 365 * 86_400_000),
        'pending',
        ctx.ownEmployeeId,
      ),
    ]);
    return { list, total: list.filter((a) => a.status !== 'cancelled').length, pendingUpcoming };
  }),

  create: protectedProcedure.input(appointmentInput).mutation(async ({ ctx, input }) => {
    assertOwnEmployee(ctx, input.employeeId);
    const tenant = await ctx.repos.tenants.findById(ctx.tenantId);
    if (!tenant) throw new TRPCError({ code: 'NOT_FOUND' });
    const fromService = await serviceDuration(ctx.repos, ctx.tenantId, input.serviceId);
    try {
      return await bookAppointment(ctx.db, ctx.tenantId, {
        clientId: input.clientId,
        employeeId: input.employeeId,
        start: input.start,
        durationMinutes: input.durationMinutes ?? fromService ?? tenant.settings.slotMinutes,
        status: input.status,
        notes: input.notes ?? null,
        serviceId: input.serviceId ?? null,
        source: 'web',
        allowOutsideSchedule: outsideScheduleOverride(ctx.role, input.force),
      });
    } catch (error) {
      toTRPCError(error);
    }
  }),

  update: protectedProcedure.input(appointmentInput.extend({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const current = await ownAppointment(ctx, input.id);
    // A professional cannot hand the appointment over to someone else either.
    assertOwnEmployee(ctx, input.employeeId);
    const serviceChanged = input.serviceId !== undefined && input.serviceId !== current.serviceId;
    const fromService = serviceChanged ? await serviceDuration(ctx.repos, ctx.tenantId, input.serviceId) : undefined;
    const durationMinutes = input.durationMinutes ?? fromService ?? current.durationMinutes;
    // F32: an appointment that keeps its professional, time and length needs no new override.
    const samePlacement =
      input.employeeId === current.employeeId && input.start.getTime() === current.date.getTime() && durationMinutes === current.durationMinutes;
    try {
      const updated = await bookAppointment(ctx.db, ctx.tenantId, {
        appointmentId: input.id,
        clientId: input.clientId,
        employeeId: input.employeeId,
        start: input.start,
        durationMinutes,
        status: input.status,
        notes: input.notes ?? null,
        ...(input.serviceId !== undefined ? { serviceId: input.serviceId } : {}),
        source: current.source,
        allowOutsideSchedule: samePlacement || outsideScheduleOverride(ctx.role, input.force),
      });
      // F21: cancelled, moved or shortened: the old slot may be free for the waiting list.
      const freed =
        current.status !== 'cancelled' &&
        (updated.status === 'cancelled' ||
          updated.date.getTime() !== current.date.getTime() ||
          updated.employeeId !== current.employeeId ||
          updated.durationMinutes < current.durationMinutes);
      if (freed) await notifyWaitlist(ctx, 'appointment changed');
      return updated;
    } catch (error) {
      toTRPCError(error);
    }
  }),

  delete: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const appointment = await ownAppointment(ctx, input.id);
    const deleted = await ctx.repos.appointments.delete(ctx.tenantId, input.id);
    if (!deleted) throw new TRPCError({ code: 'NOT_FOUND', message: 'Cita no encontrada' });
    if (appointment.status !== 'cancelled') await notifyWaitlist(ctx, 'appointment deleted');
    return { id: input.id };
  }),

  /**
   * F15: marks whether the client came (null clears it). Only for started, non-cancelled
   * appointments. F26: returns the pack whose session it spent, if any.
   */
  setAttendance: protectedProcedure
    .input(z.object({ id: z.uuid(), attendance: z.enum(['attended', 'no_show']).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const appointment = await ownAppointment(ctx, input.id);
      const result = await markAttendance(ctx.db, ctx.tenantId, input.id, input.attendance);
      if (result === 'not_found') throw new TRPCError({ code: 'NOT_FOUND', message: 'Cita no encontrada' });
      if (result === 'cancelled') throw new TRPCError({ code: 'BAD_REQUEST', message: 'La cita está cancelada' });
      if (result === 'not_started') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Solo se puede marcar la asistencia de citas que ya han empezado' });
      }
      const pack = await packHint(ctx.db, ctx.tenantId, {
        clientId: appointment.clientId,
        serviceId: appointment.serviceId,
        date: appointment.date,
        appointmentId: input.id,
      });
      return { id: input.id, attendance: input.attendance, pack: pack?.spentHere ? pack : null };
    }),

  /** F26: what the dialog shows of an appointment: its place in the treatment and the pack. */
  details: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const appointment = await ownAppointment(ctx, input.id);
    const [series, pack] = await Promise.all([
      seriesPosition(ctx.db, ctx.tenantId, appointment),
      packHint(ctx.db, ctx.tenantId, {
        clientId: appointment.clientId,
        serviceId: appointment.serviceId,
        date: appointment.date,
        appointmentId: appointment.id,
      }),
    ]);
    return { series, pack };
  }),

  /** F26: the dates a treatment would have (skipped ones with their reason). Books nothing. */
  planSeries: protectedProcedure.input(seriesInput).query(async ({ ctx, input }) => {
    assertOwnEmployee(ctx, input.employeeId);
    const tenant = await ctx.repos.tenants.findById(ctx.tenantId);
    if (!tenant) throw new TRPCError({ code: 'NOT_FOUND' });
    const durationMinutes = (await serviceDuration(ctx.repos, ctx.tenantId, input.serviceId)) ?? tenant.settings.slotMinutes;
    try {
      return await planSeries(ctx.db, ctx.tenantId, { ...input, durationMinutes });
    } catch (error) {
      toTRPCError(error);
    }
  }),

  /** F26: books the treatment shown in the preview (`expected`), all or nothing. */
  createSeries: protectedProcedure
    .input(
      seriesInput.extend({
        status: z.enum(['pending', 'confirmed']),
        notes: z.string().trim().max(1000).nullable(),
        expected: z.array(z.date()).min(1).max(SERIES_MAX_SESSIONS),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertOwnEmployee(ctx, input.employeeId);
      const tenant = await ctx.repos.tenants.findById(ctx.tenantId);
      if (!tenant) throw new TRPCError({ code: 'NOT_FOUND' });
      const durationMinutes = (await serviceDuration(ctx.repos, ctx.tenantId, input.serviceId)) ?? tenant.settings.slotMinutes;
      try {
        const { seriesId, appointments } = await bookSeries(ctx.db, ctx.tenantId, { ...input, notes: input.notes || null, durationMinutes });
        return { id: appointments[0]!.id, seriesId, sessions: appointments.length, start: appointments[0]!.date };
      } catch (error) {
        if (error instanceof SeriesChangedError) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Las fechas libres han cambiado mientras tanto: revisa la nueva propuesta.', cause: error });
        }
        toTRPCError(error);
      }
    }),

  /** F26: cancels this appointment and the later ones of its treatment that are not marked. */
  cancelFollowing: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await ownAppointment(ctx, input.id);
    const result = await cancelFollowing(ctx.db, ctx.tenantId, input.id);
    if (!result) throw new TRPCError({ code: 'BAD_REQUEST', message: 'La cita no forma parte de un tratamiento' });
    if (result.cancelled > 0) await notifyWaitlist(ctx, 'treatment cancelled');
    return { id: input.id, cancelled: result.cancelled };
  }),

  /** F15: past appointments of the last `days` days still without attendance. */
  unmarked: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(90).default(14) }).default({ days: 14 }))
    .query(({ ctx, input }) =>
      listUnmarked(ctx.db, ctx.tenantId, new Date(Date.now() - input.days * 86_400_000), new Date(), 50, ctx.ownEmployeeId),
    ),

  /** Same rule as the bot: free employees for the slot, plus a diagnostic for the chosen one. */
  checkAvailability: protectedProcedure
    .input(
      z.object({
        start: z.date(),
        durationMinutes: z.number().int().min(5).max(480).optional(),
        employeeId: z.uuid().optional(),
        ignoreAppointmentId: z.uuid().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      // F34: a professional only learns about their own agenda, not about their colleagues'.
      if (input.employeeId) assertOwnEmployee(ctx, input.employeeId);
      const tenant = await ctx.repos.tenants.findById(ctx.tenantId);
      if (!tenant) throw new TRPCError({ code: 'NOT_FOUND' });
      const duration = input.durationMinutes ?? tenant.settings.slotMinutes;
      const available = (await getAvailableEmployees(ctx.db, ctx.tenantId, input.start, duration, tenant.timezone)).filter(
        (e) => !ctx.ownEmployeeId || e.id === ctx.ownEmployeeId,
      );
      const check = input.employeeId
        ? await checkEmployeeSlot(ctx.db, ctx.tenantId, {
            employeeId: input.employeeId,
            start: input.start,
            durationMinutes: duration,
            timeZone: tenant.timezone,
            ...(input.ignoreAppointmentId ? { ignoreAppointmentId: input.ignoreAppointmentId } : {}),
          })
        : null;
      return { availableEmployeeIds: available.map((e) => e.id), check, durationMinutes: duration };
    }),
});
