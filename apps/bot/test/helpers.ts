import { readFileSync } from 'node:fs';
import { createRepos, type Db } from '@clinicai/db';
import { createTestAppDb, createTestDb, resetInboundQueue } from '@clinicai/db/testing';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { createDeps, type AppDeps } from '../src/deps';
import type { MessageHandler } from '../src/engine/types';
import { createSilentLogger } from '../src/logger';
import { createInboundEventHandler } from '../src/queue/handler';
import { createInboundWorker, type InboundWorker, type InboundWorkerOptions } from '../src/queue/worker';
import type { ChatwootService } from '../src/services/chatwoot';
import { createMockAIService } from '../src/services/mockAi';
import { createMockWhatsAppClient, type MockWhatsAppClient } from '../src/services/whatsapp';
import { BackgroundTasks } from '../src/utils/background';
import { ManualClock } from '../src/utils/clock';

export const APP_SECRET = 'test-app-secret';
export const VERIFY_TOKEN = 'test-verify-token';
export const CRON_SECRET = 'test-cron-secret';

let sharedDb: Db | undefined;
let sharedAppDb: Db | undefined;

/** One owner Prisma client per test file (bound to the project's test database): setup and checks. */
export function getTestDb(): Db {
  sharedDb ??= createTestDb(inject('databaseUrl'));
  return sharedDb;
}

/** F19: the bot's clinic work runs on the restricted role, with row level security, as in production. */
export function getTestAppDb(): Db {
  sharedAppDb ??= createTestAppDb(inject('appDatabaseUrl'));
  return sharedAppDb;
}

/** Called from test/setup.ts after each file so the pg pool does not keep Vitest alive. */
export async function disconnectTestDb(): Promise<void> {
  await Promise.all([sharedDb?.$disconnect(), sharedAppDb?.$disconnect()]);
  sharedDb = undefined;
  sharedAppDb = undefined;
}

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: inject('databaseUrl'),
    WHATSAPP_MODE: 'mock',
    LLM_MODE: 'mock',
    META_APP_SECRET: APP_SECRET,
    VERIFY_TOKEN,
    CRON_SECRET,
    ENABLE_CRON: 'false',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_PER_MINUTE: '1000',
    ...overrides,
  });
}

export interface TestDeps extends AppDeps {
  whatsapp: MockWhatsAppClient;
  clock: ManualClock;
}

export function createTestDeps(
  options: { now?: string; config?: Record<string, string>; overrides?: Partial<AppDeps> } = {},
): TestDeps {
  const logger = createSilentLogger();
  const db = getTestDb();
  const appDb = getTestAppDb();
  const deps = createDeps(testConfig(options.config), logger, {
    db: appDb,
    repos: createRepos(appDb),
    systemDb: db,
    systemRepos: createRepos(db),
    whatsapp: createMockWhatsAppClient(),
    ai: createMockAIService(),
    clock: new ManualClock(options.now ?? '2025-05-06T07:15:00Z'),
    background: new BackgroundTasks(logger),
    ...options.overrides,
  });
  return deps as TestDeps;
}

/** Loads a Meta webhook fixture replacing `__PLACEHOLDERS__`. */
export function loadFixture(name: string, replacements: Record<string, string> = {}): string {
  let raw = readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
  for (const [key, value] of Object.entries(replacements)) {
    raw = raw.replaceAll(`__${key}__`, value);
  }
  return raw;
}

/** Empties the inbound queue (claims are global: each test starts from an empty queue). */
export async function resetQueue(): Promise<void> {
  await resetInboundQueue(getTestDb());
}

export interface Pipeline {
  app: FastifyInstance;
  worker: InboundWorker;
  /** Processes everything queued (in order) and waits for background work (mirror, read receipts). */
  flush(): Promise<number>;
}

/**
 * Production wiring for tests: webhooks → inbound queue → worker → engine / Chatwoot actions.
 * The worker is not started: tests call flush() to process the queue deterministically.
 */
export function createPipeline(
  deps: AppDeps,
  engine: MessageHandler,
  options: {
    chatwoot?: ChatwootService | null;
    register?: (app: FastifyInstance) => void;
    worker?: InboundWorkerOptions;
  } = {},
): Pipeline {
  const chatwoot = options.chatwoot === undefined ? deps.chatwoot : options.chatwoot;
  const worker = createInboundWorker(deps, createInboundEventHandler(deps, engine, chatwoot), {
    retryBaseMs: 0,
    ...options.worker,
  });
  const app = buildApp(deps, options.register ? { register: options.register } : {});
  return {
    app,
    worker,
    async flush() {
      const processed = await worker.drain();
      await deps.background.idle();
      await chatwoot?.idle();
      return processed;
    },
  };
}
