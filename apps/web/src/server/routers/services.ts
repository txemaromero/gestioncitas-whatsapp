import { isNotFoundError, isUniqueViolation } from '@clinicai/db';
import { SERVICE_DURATION_MAX, SERVICE_DURATION_MIN } from '@clinicai/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, createTRPCRouter, protectedProcedure } from '../trpc';

const serviceInput = z.object({
  name: z.string().trim().min(2, 'Mínimo 2 caracteres').max(60),
  durationMinutes: z
    .number()
    .int()
    .min(SERVICE_DURATION_MIN, `Mínimo ${SERVICE_DURATION_MIN} minutos`)
    .max(SERVICE_DURATION_MAX, `Máximo ${SERVICE_DURATION_MAX} minutos`)
    .refine((v) => v % 5 === 0, 'Usa múltiplos de 5 minutos'),
});

function mapError(error: unknown): never {
  if (isUniqueViolation(error)) throw new TRPCError({ code: 'CONFLICT', message: 'Ya existe un servicio con ese nombre' });
  if (isNotFoundError(error)) throw new TRPCError({ code: 'NOT_FOUND', message: 'Servicio no encontrado' });
  throw error;
}

/** Services of the clinic, each with its own duration (F14). */
export const servicesRouter = createTRPCRouter({
  /** All services (active or not) with the number of appointments that use each one. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.repos.services.listWithUsage(ctx.tenantId);
    return rows.map(({ _count, ...service }) => ({ ...service, appointments: _count.appointments }));
  }),

  create: adminProcedure
    .input(serviceInput)
    .mutation(({ ctx, input }) => ctx.repos.services.create(ctx.tenantId, input).catch(mapError)),

  update: adminProcedure.input(serviceInput.extend({ id: z.uuid() })).mutation(({ ctx, input }) => {
    const { id, ...data } = input;
    return ctx.repos.services.update(ctx.tenantId, id, data).catch(mapError);
  }),

  setActive: adminProcedure
    .input(z.object({ id: z.uuid(), active: z.boolean() }))
    .mutation(({ ctx, input }) => ctx.repos.services.update(ctx.tenantId, input.id, { active: input.active }).catch(mapError)),

  /** A service with appointments is kept for the history: it can only be deactivated. */
  delete: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const result = await ctx.repos.services.delete(ctx.tenantId, input.id);
    if (result === 'in_use') {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Este servicio tiene citas: desactívalo en lugar de eliminarlo.',
      });
    }
    if (result === 'not_found') throw new TRPCError({ code: 'NOT_FOUND', message: 'Servicio no encontrado' });
    return { id: input.id };
  }),
});
