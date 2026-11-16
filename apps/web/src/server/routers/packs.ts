/**
 * F26: session packs (bonos) of a client. Owner and administrators manage them from the client
 * record; every member sees, in the appointment dialog, which pack an appointment would spend.
 */
import { createPack, deletePack, listClientPacks, packHint, PackError, updatePack } from '@clinicai/db';
import { packFieldsSchema } from '@clinicai/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, createTRPCRouter, protectedProcedure } from '../trpc';

const MESSAGES: Record<PackError['reason'], { code: 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT'; message: string }> = {
  not_found: { code: 'NOT_FOUND', message: 'Bono no encontrado' },
  client_not_found: { code: 'NOT_FOUND', message: 'Cliente no encontrado' },
  service_not_found: { code: 'NOT_FOUND', message: 'Servicio no encontrado' },
  below_used: { code: 'BAD_REQUEST', message: 'El bono no puede tener menos sesiones de las que ya se han usado' },
  in_use: { code: 'CONFLICT', message: 'El bono ya tiene sesiones usadas: no se puede borrar ni cambiar su servicio' },
};

function mapError(error: unknown): never {
  if (error instanceof PackError) {
    const { code, message } = MESSAGES[error.reason];
    throw new TRPCError({ code, message, cause: error });
  }
  throw error;
}

export const packsRouter = createTRPCRouter({
  list: adminProcedure.input(z.object({ clientId: z.uuid() })).query(({ ctx, input }) => listClientPacks(ctx.db, ctx.tenantId, input.clientId)),

  create: adminProcedure
    .input(packFieldsSchema.extend({ clientId: z.uuid() }))
    .mutation(({ ctx, input }) => {
      const { clientId, ...fields } = input;
      return createPack(ctx.db, ctx.tenantId, clientId, fields).catch(mapError);
    }),

  update: adminProcedure
    .input(packFieldsSchema.extend({ id: z.uuid() }))
    .mutation(({ ctx, input }) => {
      const { id, ...fields } = input;
      return updatePack(ctx.db, ctx.tenantId, id, fields).catch(mapError);
    }),

  delete: adminProcedure.input(z.object({ id: z.uuid() })).mutation(({ ctx, input }) => deletePack(ctx.db, ctx.tenantId, input.id).catch(mapError)),

  /** The pack a new appointment of the client would spend (name and sessions left only). */
  hint: protectedProcedure
    .input(z.object({ clientId: z.uuid(), serviceId: z.uuid().nullable(), date: z.date() }))
    .query(({ ctx, input }) => packHint(ctx.db, ctx.tenantId, input)),
});
