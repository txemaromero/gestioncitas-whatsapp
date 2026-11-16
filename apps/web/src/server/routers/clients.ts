import {
  ClientImportError,
  ClientNotFoundError,
  eraseClient,
  importClients,
  planClientImport,
  exportClientData,
  isNotFoundError,
  isUniqueViolation,
  type ClientConsent,
} from '@clinicai/db';
import { CLIENT_IMPORT_MAX_CHARS, isValidEmail, normalizePhone, PRIVACY_NOTICE_VERSION } from '@clinicai/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, createTRPCRouter, protectedProcedure } from '../trpc';

const clientInput = z.object({
  name: z.string().trim().min(2, 'Mínimo 2 caracteres').max(80),
  email: z
    .string()
    .trim()
    .max(254)
    .refine((v) => v === '' || isValidEmail(v), 'Email no válido')
    .optional(),
  phone: z.string().trim().max(30).optional(),
  notes: z.string().trim().max(2000).optional(),
  /** The client accepted the privacy notice outside WhatsApp (e.g. signed form at the clinic). */
  consent: z.boolean().optional(),
});

const webConsent = (): ClientConsent => ({ at: new Date(), channel: 'web', version: PRIVACY_NOTICE_VERSION });

/** Empty strings → null; phone normalized to E.164 (default +34). */
function normalize(input: Omit<z.infer<typeof clientInput>, 'consent'>) {
  let phone: string | null = null;
  if (input.phone) {
    phone = normalizePhone(input.phone);
    if (!phone) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Teléfono no válido' });
  }
  return {
    name: input.name,
    email: input.email ? input.email.toLowerCase() : null,
    phone,
    notes: input.notes || null,
  };
}

/** F23: decoded text of the CSV (the panel decodes UTF-8 or Windows-1252). */
const importInput = z.object({ csv: z.string().min(1, 'El fichero está vacío').max(CLIENT_IMPORT_MAX_CHARS + 1) });

async function withImportErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ClientImportError) throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
    throw error;
  }
}

function mapError(error: unknown): never {
  if (isUniqueViolation(error)) {
    throw new TRPCError({ code: 'CONFLICT', message: 'Ya existe un cliente con ese teléfono en tu clínica' });
  }
  if (isNotFoundError(error) || error instanceof ClientNotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Cliente no encontrado' });
  }
  throw error;
}

export const clientsRouter = createTRPCRouter({
  /** F18: what the appointment dialog needs to pick a client, for every member (no email or notes). */
  options: protectedProcedure.query(async ({ ctx }) =>
    (await ctx.repos.clients.list(ctx.tenantId)).map((c) => ({ id: c.id, name: c.name, phone: c.phone })),
  ),

  /** F23: what would be imported from a CSV, without saving anything. */
  importPreview: adminProcedure.input(importInput).mutation(({ ctx, input }) =>
    withImportErrors(async () => {
      const plan = await planClientImport(ctx.db, ctx.tenantId, input.csv);
      return {
        total: plan.total,
        toImport: plan.toImport.length,
        sample: plan.toImport.slice(0, 8),
        skipped: plan.skipped.slice(0, 500),
        skippedCount: plan.skipped.length,
        columns: plan.columns,
        ignoredColumns: plan.ignoredColumns,
      };
    }),
  ),

  /** F23: creates the valid rows of the CSV (parsed and checked again on the server). */
  import: adminProcedure.input(importInput.extend({ consent: z.boolean() })).mutation(({ ctx, input }) =>
    withImportErrors(async () => {
      const result = await importClients(ctx.db, ctx.tenantId, input.csv, { consent: input.consent });
      return { ...result, skipped: result.skipped.slice(0, 500), skippedCount: result.skipped.length };
    }),
  ),

  list: adminProcedure
    .input(z.object({ search: z.string().max(80).optional() }).default({}))
    .query(({ ctx, input }) => ctx.repos.clients.list(ctx.tenantId, input.search)),

  /** Client detail with past and future appointments. */
  get: adminProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const client = await ctx.repos.clients.getWithAppointments(ctx.tenantId, input.id);
    if (!client) throw new TRPCError({ code: 'NOT_FOUND', message: 'Cliente no encontrado' });
    return client;
  }),

  create: adminProcedure.input(clientInput).mutation(({ ctx, input }) => {
    const { consent, ...data } = input;
    return ctx.repos.clients
      .create(ctx.tenantId, { ...normalize(data), ...(consent ? { consent: webConsent() } : {}) })
      .catch(mapError);
  }),

  /** consent: true records it if missing (keeps the original date), false withdraws it. */
  update: adminProcedure.input(clientInput.extend({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const { id, consent, ...data } = input;
    const current = await ctx.repos.clients.findById(ctx.tenantId, id);
    if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Cliente no encontrado' });
    const consentChange =
      consent === true && !current.consentAt ? { consent: webConsent() } : consent === false && current.consentAt ? { consent: null } : {};
    return ctx.repos.clients.update(ctx.tenantId, id, { ...normalize(data), ...consentChange }).catch(mapError);
  }),

  /** Right of access / portability (GDPR arts. 15 and 20): everything stored about the client. */
  export: adminProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => exportClientData(ctx.db, ctx.tenantId, input.id).catch(mapError)),

  futureAppointments: adminProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => ctx.repos.clients.countFutureAppointments(ctx.tenantId, input.id, new Date())),

  /**
   * Right to erasure (GDPR art. 17): the client, their appointments and every trace of the
   * WhatsApp conversation; the Chatwoot contact is deleted by the bot through the queue.
   */
  delete: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const summary = await eraseClient(ctx.db, ctx.tenantId, input.id).catch(mapError);
    return { id: input.id, ...summary };
  }),
});
