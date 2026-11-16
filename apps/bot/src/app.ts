import { timingSafeEqual } from 'node:crypto';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from './deps';
import { ingestWhatsAppPayload } from './queue/ingest';
import { metaWebhookSchema, verifyMetaSignature } from './webhook/meta';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface AppExtensions {
  /** Registers extra routes (reminder job, Chatwoot webhook) on the same instance. */
  register?: (app: FastifyInstance) => void;
}

/**
 * F25: the bot only answers JSON and plain text (webhooks, jobs, health), so nothing may be loaded,
 * framed or sniffed from it. HSTS only in production (Railway serves it over HTTPS).
 */
export function botSecurityHeaders(production: boolean): Record<string, string> {
  return {
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    ...(production ? { 'strict-transport-security': 'max-age=63072000; includeSubDomains' } : {}),
  };
}

/** Constant-time string comparison for shared secrets. */
export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

const verifyQuerySchema = z.object({
  'hub.mode': z.string().optional(),
  'hub.verify_token': z.string().optional(),
  'hub.challenge': z.string().optional(),
});

/**
 * HTTP layer only: webhooks are authenticated, validated and stored in the durable inbound queue
 * (F11); the queue worker (server.ts) runs the conversation engine.
 */
export function buildApp(deps: AppDeps, extensions: AppExtensions = {}): FastifyInstance {
  const { config, logger } = deps;
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
  });

  const securityHeaders = botSecurityHeaders(config.NODE_ENV === 'production');
  app.addHook('onRequest', async (_request, reply) => {
    reply.headers(securityHeaders);
  });

  // Keep the raw body: the Meta (and Chatwoot) signatures are computed over the exact bytes.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const buffer = body as Buffer;
    request.rawBody = buffer;
    if (buffer.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(buffer.toString('utf8')));
    } catch {
      const error = Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
      done(error, undefined);
    }
  });

  app.get('/health', async (request, reply) => {
    try {
      const queue = await deps.systemRepos.inboundEvents.stats();
      // F34: anyone may know it is alive; the modes and the queue only with the cron secret
      // (`pnpm preflight` and monitoring send it).
      const secret = request.headers['x-cron-secret'];
      const detailed = Boolean(config.CRON_SECRET) && safeEqual(typeof secret === 'string' ? secret : undefined, config.CRON_SECRET);
      if (!detailed) return { status: 'ok', db: 'up' };
      return { status: 'ok', db: 'up', whatsapp: config.WHATSAPP_MODE, llm: config.LLM_MODE, queue };
    } catch {
      return reply.code(503).send({ status: 'error', db: 'down' });
    }
  });

  // Meta webhook verification: echo hub.challenge as plain text.
  app.get('/webhook', async (request, reply) => {
    const query = verifyQuerySchema.safeParse(request.query);
    const q = query.success ? query.data : {};
    if (
      q['hub.mode'] === 'subscribe' &&
      safeEqual(q['hub.verify_token'], config.VERIFY_TOKEN) &&
      q['hub.challenge'] !== undefined
    ) {
      return reply.code(200).type('text/plain').send(q['hub.challenge']);
    }
    logger.warn('webhook verification failed');
    return reply.code(403).type('text/plain').send('Forbidden');
  });

  app.post('/webhook', async (request, reply) => {
    const raw = request.rawBody ?? Buffer.alloc(0);
    if (config.META_APP_SECRET) {
      const signature = request.headers['x-hub-signature-256'];
      if (!verifyMetaSignature(raw, typeof signature === 'string' ? signature : undefined, config.META_APP_SECRET)) {
        logger.warn('invalid webhook signature: rejected');
        return reply.code(401).send({ error: 'invalid signature' });
      }
    } else if (config.WHATSAPP_MODE === 'live') {
      return reply.code(401).send({ error: 'signature verification not configured' });
    }

    const parsed = metaWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues.length }, 'unexpected webhook payload: ignored');
      return reply.code(200).type('text/plain').send('EVENT_RECEIVED');
    }
    // 200 only once the messages are stored: if the database fails, Meta retries the delivery.
    try {
      const result = await ingestWhatsAppPayload(deps, parsed.data);
      logger.debug(result, 'webhook ingested');
    } catch (error) {
      logger.error({ err: error instanceof Error ? error.message : String(error) }, 'could not store webhook events: Meta will retry');
      return reply.code(500).type('text/plain').send('TEMPORARILY_UNAVAILABLE');
    }
    return reply.code(200).type('text/plain').send('EVENT_RECEIVED');
  });

  extensions.register?.(app);
  return app;
}
