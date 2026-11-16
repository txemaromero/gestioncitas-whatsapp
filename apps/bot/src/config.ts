import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1'));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

export const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(3008),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatorio'),
  // F19: restricted role `clinicai_app` (row level security per clinic). Empty: the owner connection
  // is used for clinic work too, and only the code keeps the clinics apart.
  DATABASE_APP_URL: optionalString,

  // WhatsApp Cloud API
  WHATSAPP_MODE: z.enum(['live', 'mock']).default('live'),
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v27.0'),
  META_JWT_TOKEN: optionalString,
  META_APP_SECRET: optionalString,
  VERIFY_TOKEN: optionalString,
  NUMBER_ID: optionalString,
  WA_REMINDER_TEMPLATE: z.string().default('recordatorio_cita'),
  WA_TEMPLATE_LANGUAGE: z.string().default('es'),
  // F20: only for `pnpm preflight` (templates and webhook subscription live in the WhatsApp
  // Business Account, whose id cannot be derived from the phone number id).
  META_WABA_ID: optionalString,
  META_APP_ID: optionalString,
  // F17: waiting list offers (template with two quick replies) and how long each offer lasts.
  WA_WAITLIST_TEMPLATE: z.string().default('aviso_hueco_libre'),
  WAITLIST_CRON: z.string().default('*/5 * * * *'),
  WAITLIST_OFFER_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
  ENCRYPTION_KEY: optionalString,

  // Reminders
  /** F30: every 15 minutes; each clinic's reminder hour and the marks avoid duplicates. */
  REMINDER_CRON: z.string().default('*/15 * * * *'),
  REMINDER_CRON_TZ: z.string().default('Europe/Madrid'),
  ENABLE_CRON: bool(true),
  CRON_SECRET: optionalString,

  // LLM
  LLM_MODE: z.enum(['live', 'mock']).default('live'),
  AI_PROVIDER: z.enum(['openai', 'deepseek']).default('openai'),
  ENABLE_FALLBACK: bool(false),
  /**
   * Fallback provider (F12): another OpenAI model by default. DeepSeek only when chosen
   * explicitly: it means an international transfer of the clients' messages (docs/rgpd.md).
   */
  FALLBACK_PROVIDER: z.enum(['openai', 'deepseek']).default('openai'),
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_FALLBACK_MODEL: optionalString,
  OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
  DEEPSEEK_API_KEY: optionalString,
  DEEPSEEK_MODEL: z.string().default('deepseek-chat'),
  DEEPSEEK_BASE_URL: z.url().default('https://api.deepseek.com'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // F16: voice notes, transcribed with OpenAI (no transcription with DeepSeek).
  VOICE_NOTES: bool(true),
  VOICE_MAX_SECONDS: z.coerce.number().int().min(10).max(600).default(120),
  OPENAI_TRANSCRIBE_MODEL: z.string().default('gpt-transcribe'),

  // Chatwoot (optional)
  CHATWOOT_URL: optionalString,
  CHATWOOT_ACCOUNT_ID: z.coerce.number().int().positive().optional(),
  CHATWOOT_TOKEN: optionalString,
  CHATWOOT_INBOX_NAME: optionalString,
  CHATWOOT_WEBHOOK_SECRET: optionalString,

  // Abuse protection: messages per phone and minute (counted in the database, all instances)
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),

  // Durable inbound queue (F11)
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  QUEUE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig extends Env {
  chatwootEnabled: boolean;
}

/** Parses and cross-validates the environment. Throws with a readable message. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuración inválida: ${details}`);
  }
  const env = parsed.data;
  const problems: string[] = [];
  if (env.WHATSAPP_MODE === 'live') {
    if (!env.META_APP_SECRET) problems.push('META_APP_SECRET es obligatorio con WHATSAPP_MODE=live');
    if (!env.VERIFY_TOKEN) problems.push('VERIFY_TOKEN es obligatorio con WHATSAPP_MODE=live');
  }
  if (env.LLM_MODE === 'live') {
    const primaryKey = env.AI_PROVIDER === 'openai' ? env.OPENAI_API_KEY : env.DEEPSEEK_API_KEY;
    if (!primaryKey) {
      problems.push(`${env.AI_PROVIDER.toUpperCase()}_API_KEY es obligatorio con LLM_MODE=live`);
    }
  }
  if (env.ENCRYPTION_KEY && Buffer.from(env.ENCRYPTION_KEY, 'base64').length !== 32) {
    problems.push('ENCRYPTION_KEY debe ser de 32 bytes en base64');
  }
  if (problems.length > 0) {
    throw new Error(`Configuración inválida: ${problems.join('; ')}`);
  }
  const chatwootEnabled = Boolean(
    env.CHATWOOT_URL && env.CHATWOOT_ACCOUNT_ID && env.CHATWOOT_TOKEN && env.CHATWOOT_INBOX_NAME,
  );
  return { ...env, chatwootEnabled };
}
