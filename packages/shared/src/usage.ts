/**
 * F31: usage counters of each clinic (platform console) and their estimated cost.
 * Only numbers: messages, AI requests and tokens per model, seconds of voice transcribed.
 */
import { z } from 'zod';

export const USAGE_METRICS = [
  'whatsapp.inbound',
  'whatsapp.outbound',
  'whatsapp.template',
  'llm.requests',
  'llm.prompt_tokens',
  'llm.completion_tokens',
  'transcription.seconds',
] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export interface UsageEntry {
  metric: UsageMetric;
  amount: number;
  /** Model of the AI metrics (LLM and transcription); empty for the rest. */
  model?: string;
}

/**
 * Emails of the platform administrators (`PLATFORM_ADMIN_EMAILS`: comma, semicolon or space
 * separated, case-insensitive).
 */
export function parsePlatformAdminEmails(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes('@')),
  );
}

/** Counters are kept 24 months, then deleted. */
export const USAGE_RETENTION_MONTHS = 24;

/** Usage of one clinic (or of the platform) in a period. */
export interface UsageTotals {
  inbound: number;
  /** Free-form replies (Meta «service» messages). */
  outbound: number;
  /** Templates (reminders, waiting list offers): Meta «utility» messages. */
  templates: number;
  llm: Record<string, { requests: number; promptTokens: number; completionTokens: number }>;
  /** Seconds of voice notes transcribed, per model. */
  transcription: Record<string, number>;
}

export const emptyUsageTotals = (): UsageTotals => ({ inbound: 0, outbound: 0, templates: 0, llm: {}, transcription: {} });

/** Adds one counter row to the totals. */
export function addUsage(totals: UsageTotals, row: { metric: string; model: string; amount: number }): UsageTotals {
  const llm = (model: string) => (totals.llm[model] ??= { requests: 0, promptTokens: 0, completionTokens: 0 });
  switch (row.metric as UsageMetric) {
    case 'whatsapp.inbound':
      totals.inbound += row.amount;
      break;
    case 'whatsapp.outbound':
      totals.outbound += row.amount;
      break;
    case 'whatsapp.template':
      totals.templates += row.amount;
      break;
    case 'llm.requests':
      llm(row.model).requests += row.amount;
      break;
    case 'llm.prompt_tokens':
      llm(row.model).promptTokens += row.amount;
      break;
    case 'llm.completion_tokens':
      llm(row.model).completionTokens += row.amount;
      break;
    case 'transcription.seconds':
      totals.transcription[row.model] = (totals.transcription[row.model] ?? 0) + row.amount;
      break;
  }
  return totals;
}

export function mergeUsageTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  const out = emptyUsageTotals();
  for (const t of [a, b]) {
    addUsage(out, { metric: 'whatsapp.inbound', model: '', amount: t.inbound });
    addUsage(out, { metric: 'whatsapp.outbound', model: '', amount: t.outbound });
    addUsage(out, { metric: 'whatsapp.template', model: '', amount: t.templates });
    for (const [model, u] of Object.entries(t.llm)) {
      addUsage(out, { metric: 'llm.requests', model, amount: u.requests });
      addUsage(out, { metric: 'llm.prompt_tokens', model, amount: u.promptTokens });
      addUsage(out, { metric: 'llm.completion_tokens', model, amount: u.completionTokens });
    }
    for (const [model, seconds] of Object.entries(t.transcription)) {
      addUsage(out, { metric: 'transcription.seconds', model, amount: seconds });
    }
  }
  return out;
}

/**
 * Prices in USD (list prices on the official pages, November 2026):
 *  - OpenAI (developers.openai.com/api/docs/pricing, Standard): per 1M tokens and per minute of audio.
 *  - Meta (WhatsApp pricing, Spain, from 2026-10-01): per delivered message. Templates are priced as
 *    «utility»; free-form replies are «service» messages, the first 1,000 a month of each business
 *    number are free.
 * Override with the `PLATFORM_PRICES` variable (same shape, partial).
 */
export interface UsagePrices {
  llm: Record<string, { input: number; output: number }>;
  transcriptionPerMinute: Record<string, number>;
  whatsapp: { template: number; service: number; serviceFreePerMonth: number };
}

export const DEFAULT_USAGE_PRICES: UsagePrices = {
  llm: {
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'gpt-6-luna': { input: 0.1, output: 0.5 },
  },
  transcriptionPerMinute: {
    'gpt-transcribe': 0.0045,
    'gpt-4o-mini-transcribe': 0.003,
    'gpt-4o-transcribe': 0.006,
    'whisper-1': 0.006,
  },
  whatsapp: { template: 0.02, service: 0.02, serviceFreePerMonth: 1000 },
};

const price = z.number().nonnegative().finite();
export const usagePricesOverrideSchema = z
  .object({
    llm: z.record(z.string().min(1), z.object({ input: price, output: price })),
    transcriptionPerMinute: z.record(z.string().min(1), price),
    whatsapp: z.object({ template: price, service: price, serviceFreePerMonth: z.number().int().nonnegative() }).partial(),
  })
  .partial()
  .strict();

/**
 * Default prices with the `PLATFORM_PRICES` override (JSON) on top. An invalid value is ignored
 * (`error` says why) so a typo never takes the console down.
 */
export function resolveUsagePrices(raw: string | undefined): { prices: UsagePrices; error: string | null } {
  if (!raw?.trim()) return { prices: DEFAULT_USAGE_PRICES, error: null };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { prices: DEFAULT_USAGE_PRICES, error: 'PLATFORM_PRICES no es un JSON válido' };
  }
  const parsed = usagePricesOverrideSchema.safeParse(json);
  if (!parsed.success) return { prices: DEFAULT_USAGE_PRICES, error: `PLATFORM_PRICES no válido: ${parsed.error.issues[0]?.message ?? ''}` };
  const o = parsed.data;
  return {
    prices: {
      llm: { ...DEFAULT_USAGE_PRICES.llm, ...o.llm },
      transcriptionPerMinute: { ...DEFAULT_USAGE_PRICES.transcriptionPerMinute, ...o.transcriptionPerMinute },
      whatsapp: { ...DEFAULT_USAGE_PRICES.whatsapp, ...o.whatsapp },
    },
    error: null,
  };
}

export interface UsageCost {
  /** AI (LLM + transcription) of the priced models. */
  ai: number;
  /** Templates plus replies above the free monthly allowance. */
  whatsapp: number;
  /** Models used without a price: their usage is shown without cost. */
  unpriced: string[];
}

/**
 * Estimated cost of one clinic's usage in one month (the free allowance of replies is per month
 * and per number: each clinic is assumed to have its own).
 */
export function estimateUsageCost(totals: UsageTotals, prices: UsagePrices): UsageCost {
  const unpriced = new Set<string>();
  let ai = 0;
  for (const [model, u] of Object.entries(totals.llm)) {
    const p = prices.llm[model];
    if (!p) {
      unpriced.add(model || '(sin modelo)');
      continue;
    }
    ai += (u.promptTokens * p.input + u.completionTokens * p.output) / 1_000_000;
  }
  for (const [model, seconds] of Object.entries(totals.transcription)) {
    const p = prices.transcriptionPerMinute[model];
    if (p === undefined) {
      unpriced.add(model || '(sin modelo)');
      continue;
    }
    ai += (seconds / 60) * p;
  }
  const { template, service, serviceFreePerMonth } = prices.whatsapp;
  const whatsapp = totals.templates * template + Math.max(0, totals.outbound - serviceFreePerMonth) * service;
  return { ai, whatsapp, unpriced: [...unpriced].sort() };
}
