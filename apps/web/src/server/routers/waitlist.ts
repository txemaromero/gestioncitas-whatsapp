import { joinWaitlist, leaveWaitlist, listWaitlist, requestWaitlistCheck } from '@clinicai/db';
import { exactTimeWindow, localDaysRange, wholeDayWindow, zonedTimeToUtc } from '@clinicai/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, createTRPCRouter } from '../trpc';

const addInput = z.object({
  clientId: z.uuid('Selecciona un cliente'),
  /** Local day of the clinic, YYYY-MM-DD. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha no válida'),
  /** Preferred time (HH:mm); with `onlyThatTime`, the only acceptable one. */
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora no válida')
    .nullable(),
  onlyThatTime: z.boolean(),
  serviceId: z.uuid().nullable(),
});

/** F17: waiting list of the clinic (the bot adds clients and offers them freed slots). */
export const waitlistRouter = createTRPCRouter({
  list: adminProcedure.query(async ({ ctx }) => {
    const tenant = await ctx.repos.tenants.findById(ctx.tenantId);
    if (!tenant) throw new TRPCError({ code: 'NOT_FOUND' });
    const now = new Date();
    const entries = await listWaitlist(ctx.db, ctx.tenantId, now);
    return {
      enabled: tenant.settings.waitlistEnabled,
      entries: entries.map((e) => ({
        id: e.id,
        clientId: e.clientId,
        clientName: e.client.name,
        serviceName: e.service?.name ?? null,
        windowStart: e.windowStart,
        wholeDay: e.wholeDay,
        createdAt: e.createdAt,
        /** Slot offered right now and until when (the next client gets it after that). */
        offer:
          e.offerStart && e.offerExpiresAt && e.offerExpiresAt.getTime() > now.getTime()
            ? { start: e.offerStart, expiresAt: e.offerExpiresAt }
            : null,
      })),
    };
  }),

  /**
   * F21: the clinic adds a client (e.g. someone who phoned). Same rules as joining by WhatsApp: the
   * client must have accepted the privacy notice and have a phone (the offer goes by WhatsApp), at
   * most 3 waiting entries per client. A slot that is already free is offered straight away.
   */
  add: adminProcedure.input(addInput).mutation(async ({ ctx, input }) => {
    const tenant = await ctx.repos.tenants.findById(ctx.tenantId);
    if (!tenant) throw new TRPCError({ code: 'NOT_FOUND' });
    if (!tenant.settings.waitlistEnabled) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'La lista de espera está desactivada (Ajustes → Lista de espera)' });
    }
    const client = await ctx.repos.clients.findById(ctx.tenantId, input.clientId);
    if (!client) throw new TRPCError({ code: 'NOT_FOUND', message: 'Cliente no encontrado' });
    if (!client.phone) throw new TRPCError({ code: 'BAD_REQUEST', message: 'El cliente no tiene teléfono: el aviso se envía por WhatsApp' });
    if (!client.consentAt) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'El cliente no ha aceptado el aviso de privacidad: el bot no puede escribirle' });
    }
    const service = input.serviceId ? await ctx.repos.services.findById(ctx.tenantId, input.serviceId) : null;
    if (input.serviceId && (!service || !service.active)) throw new TRPCError({ code: 'NOT_FOUND', message: 'Servicio no encontrado' });
    if (input.onlyThatTime && !input.time) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Indica la hora' });

    const tz = tenant.timezone;
    const range = localDaysRange(input.day, input.day, tz);
    if (!range) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Fecha no válida' });
    const [year, month, day] = input.day.split('-').map(Number) as [number, number, number];
    const [hour, minute] = (input.time ?? '00:00').split(':').map(Number) as [number, number];
    const requested = input.time ? zonedTimeToUtc({ year, month, day, hour, minute }, tz) : range.start;
    const window = input.onlyThatTime ? exactTimeWindow(requested) : wholeDayWindow(requested, tz);
    const now = new Date();
    if (window.end.getTime() <= now.getTime()) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: input.onlyThatTime ? 'Esa hora ya ha pasado' : 'Ese día ya ha pasado' });
    }

    const result = await joinWaitlist(ctx.db, ctx.tenantId, {
      clientId: client.id,
      serviceId: service?.id ?? null,
      durationMinutes: service?.durationMinutes ?? tenant.settings.slotMinutes,
      window,
      now,
    });
    if (result.status === 'limit') {
      throw new TRPCError({ code: 'CONFLICT', message: `Ya está en ${result.max} listas de espera, que es el máximo` });
    }
    if (result.status === 'already') throw new TRPCError({ code: 'CONFLICT', message: 'Ya está en la lista de espera para ese día u hora' });
    await requestWaitlistCheck(ctx.db, ctx.tenantId, 'added from the panel');
    return { id: result.entry.id };
  }),

  remove: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const removed = await leaveWaitlist(ctx.db, ctx.tenantId, input.id);
    if (!removed) throw new TRPCError({ code: 'NOT_FOUND', message: 'Ya no está en la lista de espera' });
    return { ok: true };
  }),
});
