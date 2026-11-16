/**
 * ClinicAI WhatsApp bot — entry point (Railway: `pnpm --filter @clinicai/bot start`).
 */
import { databaseTimeZone, isUtcTimeZone } from '@clinicai/db';
import { isTestEncryptionKey } from '@clinicai/shared/crypto';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDeps } from './deps';
import { createConversationEngine } from './engine/engine';
import { scheduleMaintenance } from './jobs/maintenance';
import { startReminderCron } from './jobs/reminders';
import { startWaitlistCron } from './jobs/waitlist';
import { registerJobRoutes } from './jobs/routes';
import { createLogger } from './logger';
import { createInboundEventHandler } from './queue/handler';
import { createInboundWorker } from './queue/worker';
import { chatwootObserver } from './services/chatwoot';
import { registerChatwootRoutes } from './webhook/chatwoot';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development' && process.stdout.isTTY);
  const deps = createDeps(config, logger);
  const dbTimeZone = await databaseTimeZone(deps.systemDb);
  if (!config.DATABASE_APP_URL) {
    logger.warn('DATABASE_APP_URL vacío: la base de datos no aísla las clínicas por sí misma (solo el código)');
  }
  if (config.ENCRYPTION_KEY && isTestEncryptionKey(config.ENCRYPTION_KEY) && config.WHATSAPP_MODE === 'live') {
    logger.error('ENCRYPTION_KEY es una clave de pruebas: los tokens de WhatsApp quedarían sin protección. Genera una nueva (README)');
  }
  if (!isUtcTimeZone(dbTimeZone)) {
    logger.warn({ timeZone: dbTimeZone }, 'La base de datos no usa UTC: las horas guardadas quedarían desplazadas (configura TimeZone=UTC)');
  }
  const observer = chatwootObserver(deps.chatwoot);
  const engine = createConversationEngine(deps, observer);
  const worker = createInboundWorker(deps, createInboundEventHandler(deps, engine, deps.chatwoot), {
    concurrency: config.QUEUE_CONCURRENCY,
    maxAttempts: config.QUEUE_MAX_ATTEMPTS,
  });
  const app = buildApp(deps, {
    register: (instance) => {
      registerJobRoutes(instance, deps, observer);
      if (deps.chatwoot) registerChatwootRoutes(instance, deps);
    },
  });
  if (!deps.chatwoot) {
    logger.warn('Chatwoot no configurado (CHATWOOT_URL/ACCOUNT_ID/TOKEN/INBOX_NAME): handoff humano desactivado');
  } else if (!config.CHATWOOT_WEBHOOK_SECRET) {
    logger.warn('CHATWOOT_WEBHOOK_SECRET vacío: el webhook de Chatwoot rechazará todas las peticiones');
  }

  const stopMaintenance = scheduleMaintenance(deps);
  const reminderCron = config.ENABLE_CRON ? startReminderCron(deps, observer) : null;
  const waitlistCron = config.ENABLE_CRON ? startWaitlistCron(deps, observer) : null;
  if (!config.ENABLE_CRON) logger.info('reminder cron disabled (ENABLE_CRON=false)');

  await app.listen({ port: config.PORT, host: config.HOST });
  worker.start();
  logger.info(
    { port: config.PORT, whatsapp: config.WHATSAPP_MODE, llm: config.LLM_MODE, provider: config.AI_PROVIDER },
    'ClinicAI bot listening',
  );

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    stopMaintenance();
    reminderCron?.stop();
    waitlistCron?.stop();
    // Stop accepting webhooks, then finish the messages in progress (pending ones stay queued
    // for the next instance). Set RAILWAY_DEPLOYMENT_DRAINING_SECONDS so the platform waits.
    await app.close();
    await worker.stop();
    await deps.background.idle();
    await Promise.all([deps.db.$disconnect(), deps.systemDb.$disconnect()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
