import { createDatabaseClients, createRepos, type DatabaseClients, type Db, type Repos } from '@clinicai/db';
import type { AppConfig } from './config';
import type { Logger } from './logger';
import { createAIService, type AIService } from './services/aiServices';
import { createChatwootService, type ChatwootService } from './services/chatwoot';
import { createTranscriber, type Transcriber } from './services/transcription';
import { countWhatsAppUsage, createUsageRecorder, llmUsageEntries, type UsageRecorder } from './services/usage';
import { createLiveWhatsAppClient, createMockWhatsAppClient, type WhatsAppClient } from './services/whatsapp';
import { BackgroundTasks } from './utils/background';
import { systemClock, type Clock } from './utils/clock';
import { Signal } from './utils/signal';

/** Everything the bot needs, injected (tests and the simulator replace pieces). */
export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  /**
   * Clinic work (F19): only usable inside `runWithTenant()`; with DATABASE_APP_URL, PostgreSQL itself
   * limits it to that clinic.
   */
  db: Db;
  repos: Repos;
  /** Owner connection for work that spans clinics: tenant lookup, inbound queue, cron jobs. */
  systemDb: Db;
  systemRepos: Repos;
  whatsapp: WhatsAppClient;
  ai: AIService;
  clock: Clock;
  /** Voice notes → text (F16). Null when disabled or without an OpenAI key. */
  transcriber: Transcriber | null;
  /** Null when Chatwoot is not configured (handoff disabled). */
  chatwoot: ChatwootService | null;
  background: BackgroundTasks;
  /** Wakes the inbound queue worker of this instance up when the webhook stores events. */
  inboundSignal: Signal;
  /** F31: usage counters of each clinic (platform console). */
  usage: UsageRecorder;
}

export function createDeps(config: AppConfig, logger: Logger, overrides: Partial<AppDeps> = {}): AppDeps {
  let clients: DatabaseClients | undefined;
  const connect = () => (clients ??= createDatabaseClients(config.DATABASE_URL, config.DATABASE_APP_URL ?? null));
  const db = overrides.db ?? connect().app;
  const systemDb = overrides.systemDb ?? connect().system;
  const repos = overrides.repos ?? createRepos(db);
  const systemRepos = overrides.systemRepos ?? createRepos(systemDb);
  const background = overrides.background ?? new BackgroundTasks(logger);
  const clock = overrides.clock ?? systemClock;
  const usage = overrides.usage ?? createUsageRecorder({ systemDb, background, clock, logger });
  // F31: every message sent counts, whoever sends it (replies, reminders, offers, agents).
  const whatsapp = countWhatsAppUsage(
    overrides.whatsapp ??
      (config.WHATSAPP_MODE === 'mock'
        ? createMockWhatsAppClient({ echo: (line) => logger.info(line) })
        : createLiveWhatsAppClient({ graphVersion: config.META_GRAPH_VERSION, logger })),
    usage,
  );
  const chatwoot =
    overrides.chatwoot !== undefined
      ? overrides.chatwoot
      : config.chatwootEnabled
        ? createChatwootService({ config, logger, repos, background })
        : null;
  return {
    config,
    logger,
    db,
    repos,
    systemDb,
    systemRepos,
    whatsapp,
    ai: overrides.ai ?? createAIService(config, logger, undefined, (u) => usage.record(llmUsageEntries(u))),
    transcriber: overrides.transcriber !== undefined ? overrides.transcriber : createTranscriber(config, logger),
    clock,
    chatwoot,
    background,
    inboundSignal: overrides.inboundSignal ?? new Signal(),
    usage,
  };
}
