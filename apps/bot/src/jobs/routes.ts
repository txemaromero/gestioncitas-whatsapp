import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { safeEqual } from '../app';
import type { AppDeps } from '../deps';
import type { EngineObserver } from '../engine/engine';
import { checkAndSendReminders } from './reminders';
import { processWaitlist } from './waitlist';

const bodySchema = z
  .object({
    /** true → ignore each tenant's reminderHour (default for manual runs). */
    force: z.boolean().optional(),
    tenantId: z.uuid().optional(),
  })
  .default({});

/** POST /jobs/reminders/run — manual or external-cron trigger, protected by `x-cron-secret`. */
export function registerJobRoutes(app: FastifyInstance, deps: AppDeps, observer: EngineObserver = {}): void {
  app.post('/jobs/reminders/run', async (request, reply) => {
    const secret = request.headers['x-cron-secret'];
    if (!deps.config.CRON_SECRET || !safeEqual(typeof secret === 'string' ? secret : undefined, deps.config.CRON_SECRET)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const parsed = bodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    const result = await checkAndSendReminders(
      deps,
      { force: parsed.data.force ?? true, ...(parsed.data.tenantId ? { tenantId: parsed.data.tenantId } : {}) },
      observer,
    );
    return reply.send(result);
  });

  /** POST /jobs/waitlist/run — offers freed slots now (F17). Body: `{ tenantId? }`. */
  app.post('/jobs/waitlist/run', async (request, reply) => {
    const secret = request.headers['x-cron-secret'];
    if (!deps.config.CRON_SECRET || !safeEqual(typeof secret === 'string' ? secret : undefined, deps.config.CRON_SECRET)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const parsed = bodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    return reply.send(await processWaitlist(deps, parsed.data.tenantId ? { tenantId: parsed.data.tenantId } : {}, observer));
  });
}
