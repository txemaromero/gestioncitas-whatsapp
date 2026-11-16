import { isNotFoundError } from '@clinicai/db';
import { scheduleSchema } from '@clinicai/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, createTRPCRouter, protectedProcedure } from '../trpc';
import { notifyWaitlist } from '../waitlist-check';

const employeeInput = z.object({
  name: z.string().trim().min(2, 'Mínimo 2 caracteres').max(80),
  role: z.string().trim().min(2, 'Indica el rol').max(60),
  schedule: scheduleSchema,
});

function notFound(error: unknown): never {
  if (isNotFoundError(error)) throw new TRPCError({ code: 'NOT_FOUND', message: 'Empleado no encontrado' });
  throw error;
}

export const employeesRouter = createTRPCRouter({
  list: protectedProcedure
    .input(z.object({ search: z.string().max(80).optional() }).default({}))
    .query(({ ctx, input }) => ctx.repos.employees.list(ctx.tenantId, input.search)),

  create: adminProcedure
    .input(employeeInput)
    .mutation(({ ctx, input }) => ctx.repos.employees.create(ctx.tenantId, input)),

  update: adminProcedure.input(employeeInput.extend({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const { id, ...data } = input;
    const employee = await ctx.repos.employees.update(ctx.tenantId, id, data).catch(notFound);
    // F21: a wider schedule may open slots for the waiting list.
    await notifyWaitlist(ctx, 'schedule changed');
    return employee;
  }),

  setActive: adminProcedure.input(z.object({ id: z.uuid(), active: z.boolean() })).mutation(async ({ ctx, input }) => {
    const employee = await ctx.repos.employees.setActive(ctx.tenantId, input.id, input.active).catch(notFound);
    if (input.active) await notifyWaitlist(ctx, 'employee activated');
    return employee;
  }),

  futureAppointments: adminProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => ctx.repos.employees.countFutureAppointments(ctx.tenantId, input.id, new Date())),

  /** Deleting an employee with future appointments requires `force` (the UI offers deactivating instead). */
  delete: adminProcedure.input(z.object({ id: z.uuid(), force: z.boolean().optional() })).mutation(async ({ ctx, input }) => {
    const future = await ctx.repos.employees.countFutureAppointments(ctx.tenantId, input.id, new Date());
    if (future > 0 && !input.force) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `El empleado tiene ${future} cita(s) futura(s). Desactívalo o confirma el borrado.`,
      });
    }
    await ctx.repos.employees.delete(ctx.tenantId, input.id).catch(notFound);
    return { id: input.id };
  }),
});
