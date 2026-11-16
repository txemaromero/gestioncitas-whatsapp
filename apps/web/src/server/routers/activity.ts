import { listActivity } from '@clinicai/db';
import { ACTIVITY_CATEGORIES, activityLabel, type ActivityCategory } from '@clinicai/shared';
import { z } from 'zod';
import { adminProcedure, createTRPCRouter } from '../trpc';

const PAGE = 50;

/** F24: activity log of the clinic, newest first (owner and administrators). */
export const activityRouter = createTRPCRouter({
  list: adminProcedure
    .input(
      z.object({
        cursor: z.string().regex(/^\d+$/).nullish(),
        category: z.enum(Object.keys(ACTIVITY_CATEGORIES) as [ActivityCategory, ...ActivityCategory[]]).nullish(),
        clientId: z.uuid().nullish(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await listActivity(ctx.db, ctx.tenantId, {
        limit: PAGE + 1,
        before: input.cursor ?? null,
        category: input.category ?? null,
        clientId: input.clientId ?? null,
      });
      const page = rows.slice(0, PAGE);
      // Names are resolved now (the log only keeps ids): an erased client shows as such.
      const clientIds = [...new Set(page.map((r) => r.clientId).filter((id): id is string => Boolean(id)))];
      const clients = clientIds.length
        ? await ctx.db.client.findMany({ where: { tenantId: ctx.tenantId, id: { in: clientIds } }, select: { id: true, name: true } })
        : [];
      const employees = await ctx.repos.employees.list(ctx.tenantId);
      const clientName = new Map(clients.map((c) => [c.id, c.name]));
      const employeeName = new Map(employees.map((e) => [e.id, e.name]));
      return {
        items: page.map((r) => {
          const details = (r.details ?? {}) as Record<string, unknown>;
          return {
            id: r.id,
            at: r.createdAt,
            actorType: r.actorType,
            actorLabel: r.actorLabel,
            action: r.action,
            label: activityLabel(r.action),
            clientName: r.clientId ? (clientName.get(r.clientId) ?? null) : null,
            employeeName: typeof details.employeeId === 'string' ? (employeeName.get(details.employeeId) ?? null) : null,
            details,
          };
        }),
        nextCursor: rows.length > PAGE ? (page.at(-1)?.id ?? null) : null,
      };
    }),
});
