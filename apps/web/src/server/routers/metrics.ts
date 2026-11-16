import { getMetrics } from '@clinicai/db';
import { localMonthRange, shiftMonthKey } from '@clinicai/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, createTRPCRouter } from '../trpc';

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** [start, end) of a month in the tenant zone. */
function monthRange(month: string, timeZone: string) {
  const range = localMonthRange(month, timeZone);
  if (!range) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Mes no válido' });
  return range;
}

/** F15: figures of the clinic per month (tenant time zone). */
export const metricsRouter = createTRPCRouter({
  month: adminProcedure
    .input(z.object({ month: z.string().regex(MONTH, 'Formato AAAA-MM'), trendMonths: z.number().int().min(1).max(12).default(6) }))
    .query(async ({ ctx, input }) => {
      const tenant = await ctx.repos.tenants.findById(ctx.tenantId);
      if (!tenant) throw new TRPCError({ code: 'NOT_FOUND' });
      const tz = tenant.timezone;
      const now = new Date();
      const range = monthRange(input.month, tz);
      const current = await getMetrics(ctx.db, ctx.tenantId, { from: range.start, to: range.end, timeZone: tz, now });
      // Evolution of the previous months (oldest first), with the selected month last.
      const trend = await Promise.all(
        Array.from({ length: input.trendMonths }, (_, i) => shiftMonthKey(input.month, i - input.trendMonths + 1) ?? input.month).map(async (month) => {
          const r = monthRange(month, tz);
          const m = month === input.month ? current : await getMetrics(ctx.db, ctx.tenantId, { from: r.start, to: r.end, timeZone: tz, now });
          return {
            month,
            active: m.active,
            attended: m.attended,
            noShow: m.noShow,
            unmarked: m.unmarked,
            cancelled: m.cancelled,
            noShowRate: m.noShowRate,
          };
        }),
      );
      return { month: input.month, ...current, trend };
    }),
});
