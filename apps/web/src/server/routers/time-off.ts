import { isForeignKeyViolation } from '@clinicai/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, createTRPCRouter, protectedProcedure } from '../trpc';
import { notifyWaitlist } from '../waitlist-check';
import { listRangeInput } from '../list-range';

const MAX_SPAN_MS = 366 * 24 * 3_600_000;

const timeOffInput = z
  .object({
    /** Null → closure of the whole clinic (holiday). */
    employeeId: z.uuid().nullable(),
    startsAt: z.date(),
    endsAt: z.date(),
    reason: z.string().trim().max(120).optional(),
  })
  .refine((v) => v.endsAt > v.startsAt, { message: 'El final debe ser posterior al inicio', path: ['endsAt'] })
  .refine((v) => v.endsAt.getTime() - v.startsAt.getTime() <= MAX_SPAN_MS, { message: 'Como máximo un año', path: ['endsAt'] });

/**
 * Absences of professionals and clinic closures (F14). They block bookings in the bot and in
 * the panel; existing appointments are not touched (the admin is warned about them).
 */
export const timeOffRouter = createTRPCRouter({
  /** Time off overlapping the calendar range. */
  list: protectedProcedure
    .input(listRangeInput)
    .query(({ ctx, input }) => ctx.repos.timeOff.listOverlapping(ctx.tenantId, input.from, input.to, ctx.ownEmployeeId)),

  /** Not yet finished time off of a professional, or of the clinic when `employeeId` is null. */
  upcoming: adminProcedure
    .input(z.object({ employeeId: z.uuid().nullable() }))
    .query(({ ctx, input }) => ctx.repos.timeOff.listUpcoming(ctx.tenantId, input.employeeId, new Date())),

  /** Creates it and returns the appointments it overlaps, so the panel can warn about them. */
  create: adminProcedure.input(timeOffInput).mutation(async ({ ctx, input }) => {
    if (input.employeeId && !(await ctx.repos.employees.findById(ctx.tenantId, input.employeeId))) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Empleado no encontrado' });
    }
    try {
      const timeOff = await ctx.repos.timeOff.create(ctx.tenantId, { ...input, reason: input.reason || null });
      const overlapping = await ctx.repos.timeOff.overlappingAppointments(ctx.tenantId, input);
      return {
        timeOff,
        overlapping: overlapping.map((a) => ({ id: a.id, date: a.date, client: a.client.name, employee: a.employee.name })),
      };
    } catch (error) {
      // Composite FK: the employee belongs to another clinic.
      if (isForeignKeyViolation(error)) throw new TRPCError({ code: 'NOT_FOUND', message: 'Empleado no encontrado' });
      throw error;
    }
  }),

  delete: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    if (!(await ctx.repos.timeOff.delete(ctx.tenantId, input.id))) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Ausencia no encontrada' });
    }
    // F21: the days of the absence or closure are bookable again.
    await notifyWaitlist(ctx, 'time off removed');
    return { id: input.id };
  }),
});
