/**
 * F28: links to see a professional's agenda on the phone. Each professional manages their own;
 * the owner and administrators choose whose. The link itself never goes to the activity log.
 */
import {
  createCalendarFeed,
  getCalendarFeed,
  revokeCalendarFeed,
  setCalendarFeedFullNames,
  type CalendarFeedView,
  type Repos,
} from '@clinicai/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { calendarFeedUrls } from '../calendar-feed';
import { encryptionKey } from '../encryption-key';
import { createTRPCRouter, protectedProcedure } from '../trpc';

const target = z.object({ employeeId: z.uuid().optional() });

/** The professional whose link it is: their own for a professional, the chosen one for admins. */
async function targetEmployee(ctx: { repos: Repos; tenantId: string; ownEmployeeId: string | undefined }, employeeId: string | undefined) {
  if (ctx.ownEmployeeId && employeeId && employeeId !== ctx.ownEmployeeId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Solo puedes gestionar el enlace de tu propia agenda' });
  }
  const id = ctx.ownEmployeeId ?? employeeId;
  if (!id) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Elige un profesional' });
  const employee = await ctx.repos.employees.findById(ctx.tenantId, id);
  if (!employee) throw new TRPCError({ code: 'NOT_FOUND', message: 'Profesional no encontrado' });
  return employee;
}

function toView(feed: CalendarFeedView) {
  const { token, ...rest } = feed;
  return { ...rest, ...calendarFeedUrls(token) };
}

export const calendarFeedRouter = createTRPCRouter({
  get: protectedProcedure.input(target).query(async ({ ctx, input }) => {
    const employee = await targetEmployee(ctx, input.employeeId);
    const feed = await getCalendarFeed(ctx.db, ctx.tenantId, employee.id, encryptionKey());
    return { employee: { id: employee.id, name: employee.name }, feed: feed ? toView(feed) : null };
  }),

  /** Creates the link, or a new one (the previous one stops working). */
  create: protectedProcedure.input(target.extend({ fullNames: z.boolean() })).mutation(async ({ ctx, input }) => {
    const employee = await targetEmployee(ctx, input.employeeId);
    const feed = await createCalendarFeed(ctx.db, ctx.tenantId, employee.id, { fullNames: input.fullNames, encryptionKey: encryptionKey() });
    if (!feed) throw new TRPCError({ code: 'NOT_FOUND', message: 'Profesional no encontrado' });
    return toView(feed);
  }),

  setFullNames: protectedProcedure.input(target.extend({ fullNames: z.boolean() })).mutation(async ({ ctx, input }) => {
    const employee = await targetEmployee(ctx, input.employeeId);
    if (!(await setCalendarFeedFullNames(ctx.db, ctx.tenantId, employee.id, input.fullNames))) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Ese profesional no tiene enlace' });
    }
    return { employeeId: employee.id, fullNames: input.fullNames };
  }),

  revoke: protectedProcedure.input(target).mutation(async ({ ctx, input }) => {
    const employee = await targetEmployee(ctx, input.employeeId);
    return { employeeId: employee.id, revoked: await revokeCalendarFeed(ctx.db, ctx.tenantId, employee.id) };
  }),
});
