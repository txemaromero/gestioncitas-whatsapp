/**
 * LLM integration module. Decoupled and extensible: from the outside only
 * `getAIResponse` and three high-level functions are used. The LLM never sees other clients'
 * data nor has DB access; its outputs are validated (enum / zod) before use.
 */
import { DEFAULT_SECTOR, toZonedIso, truncate } from '@clinicai/shared';
import { z } from 'zod';
import type { AppConfig } from '../config';
import type { Logger } from '../logger';
import { createMockAIService } from './mockAi';
import { loadPrompt, renderPrompt } from './prompts';

export type Intent = 'CITA' | 'FAQ';

export interface ParsedDate {
  /** ISO 8601 with offset, e.g. `2025-05-08T12:00:00+02:00`, or null when no date was found. */
  datetime: string | null;
  hasTime: boolean;
}

export interface LLMRequest {
  system?: string;
  user: string;
  temperature?: number;
  /** Ask for a JSON object (`response_format: json_object`). */
  json?: boolean;
}

export interface LLMProvider {
  readonly name: string;
  complete(req: LLMRequest): Promise<string>;
}

export interface AIService {
  readonly mode: 'live' | 'mock';
  getAIResponse(req: LLMRequest): Promise<string>;
  detectIntent(text: string, sector?: string): Promise<Intent>;
  answerFaq(tenant: { faqPrompt: string }, text: string): Promise<string>;
  parseDate(text: string, now: Date, timeZone: string): Promise<ParsedDate>;
}

/** Maximum user text sent to the LLM (longer messages are truncated). */
export const MAX_LLM_INPUT_CHARS = 1000;

export class LLMError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/** Every provider failed (primary and, if enabled, fallback). */
export class AIUnavailableError extends Error {
  constructor(readonly causes: unknown[]) {
    super('No LLM provider is available');
    this.name = 'AIUnavailableError';
  }
}

const completionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable() }) }))
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    })
    .partial()
    .optional(),
});

export interface OpenAICompatibleOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  logger?: Logger;
  /** F31: called after every completion with its token usage (platform console counters). */
  onUsage?: (usage: LLMUsage) => void;
}

export interface LLMUsage {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Single HTTP client for any OpenAI-compatible `POST {baseUrl}/chat/completions` API
 * (OpenAI and DeepSeek share the payload).
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.name = options.name;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async complete(req: LLMRequest): Promise<string> {
    try {
      return await this.send(req, true);
    } catch (error) {
      // Some newer models reject custom temperatures: retry once without it.
      if (error instanceof LLMError && error.status === 400 && /temperature/i.test(error.message)) {
        return this.send(req, false);
      }
      throw error;
    }
  }

  private async send(req: LLMRequest, withTemperature: boolean): Promise<string> {
    const messages = [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      { role: 'user', content: req.user },
    ];
    const body: Record<string, unknown> = { model: this.options.model, messages };
    if (withTemperature && req.temperature !== undefined) body.temperature = req.temperature;
    if (req.json) body.response_format = { type: 'json_object' };

    let response: Response;
    try {
      response = await this.fetchFn(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new LLMError(
        timeout ? `Timeout after ${this.timeoutMs} ms` : `Network error: ${String(error)}`,
        this.name,
        undefined,
        true,
      );
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      const retryable = response.status === 429 || response.status >= 500;
      throw new LLMError(`HTTP ${response.status}: ${detail}`, this.name, response.status, retryable);
    }

    const parsed = completionSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new LLMError('Unexpected response shape', this.name, response.status, true);
    }
    const usage = parsed.data.usage;
    this.options.logger?.info(
      {
        provider: this.name,
        model: this.options.model,
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        totalTokens: usage?.total_tokens,
      },
      'llm usage',
    );
    this.options.onUsage?.({
      provider: this.name,
      model: this.options.model,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
    });
    return parsed.data.choices[0]?.message.content?.trim() ?? '';
  }
}

export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(options: Omit<OpenAICompatibleOptions, 'name' | 'baseUrl'> & { baseUrl?: string }) {
    super({ ...options, name: 'openai', baseUrl: options.baseUrl ?? 'https://api.openai.com/v1' });
  }
}

export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(options: Omit<OpenAICompatibleOptions, 'name' | 'baseUrl'> & { baseUrl?: string }) {
    super({ ...options, name: 'deepseek', baseUrl: options.baseUrl ?? 'https://api.deepseek.com' });
  }
}

/** `" cita. "` → `CITA`; anything that is not exactly CITA/FAQ → FAQ (when in doubt, FAQ). */
export function normalizeIntent(raw: string): Intent {
  const value = raw
    .trim()
    .replace(/^["'“”«»`\s]+|["'“”«»`.!\s]+$/g, '')
    .toUpperCase();
  return value === 'CITA' ? 'CITA' : 'FAQ';
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:\d{2}|Z)$/;

export const parsedDateSchema = z.object({
  datetime: z
    .string()
    .regex(ISO_WITH_OFFSET)
    .refine((v) => !Number.isNaN(Date.parse(v)), 'invalid date')
    .nullable(),
  hasTime: z.boolean(),
});

/** Validates the raw LLM output of `parseDate`. Invalid output → "no date understood". */
export function validateParsedDate(raw: string): ParsedDate {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch {
    return { datetime: null, hasTime: false };
  }
  const parsed = parsedDateSchema.safeParse(json);
  if (!parsed.success) return { datetime: null, hasTime: false };
  return parsed.data.datetime === null
    ? { datetime: null, hasTime: false }
    : { datetime: parsed.data.datetime, hasTime: parsed.data.hasTime };
}

export interface LiveAIServiceOptions {
  primary: LLMProvider;
  fallback?: LLMProvider;
  logger: Logger;
  /** Retries per provider after the first attempt (1 by default). */
  retries?: number;
  retryDelayMs?: number;
}

export function createLiveAIService(options: LiveAIServiceOptions): AIService {
  const { primary, fallback, logger } = options;
  const retries = options.retries ?? 1;
  const retryDelayMs = options.retryDelayMs ?? 500;

  async function callWithRetry(provider: LLMProvider, req: LLMRequest): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await provider.complete(req);
      } catch (error) {
        lastError = error;
        const retryable = !(error instanceof LLMError) || error.retryable;
        logger.warn(
          { provider: provider.name, attempt: attempt + 1, err: error instanceof Error ? error.message : String(error) },
          'llm call failed',
        );
        if (!retryable) break;
        if (attempt < retries) await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
      }
    }
    throw lastError;
  }

  async function getAIResponse(req: LLMRequest): Promise<string> {
    const request = { ...req, user: truncate(req.user, MAX_LLM_INPUT_CHARS * 20) };
    const causes: unknown[] = [];
    try {
      return await callWithRetry(primary, request);
    } catch (error) {
      causes.push(error);
    }
    if (fallback) {
      logger.warn({ from: primary.name, to: fallback.name }, 'llm fallback');
      try {
        return await callWithRetry(fallback, request);
      } catch (error) {
        causes.push(error);
      }
    }
    throw new AIUnavailableError(causes);
  }

  return {
    mode: 'live',
    getAIResponse,

    async detectIntent(text, sector = DEFAULT_SECTOR) {
      const user = renderPrompt(loadPrompt('intent'), {
        sector,
        mensaje: truncate(text, MAX_LLM_INPUT_CHARS),
      });
      return normalizeIntent(await getAIResponse({ user, temperature: 0 }));
    },

    async answerFaq(tenant, text) {
      const system = `${tenant.faqPrompt.trim()}\n\n${loadPrompt('faq-guard')}`;
      const answer = await getAIResponse({ system, user: truncate(text, MAX_LLM_INPUT_CHARS), temperature: 0.3 });
      return answer.trim();
    },

    async parseDate(text, now, timeZone) {
      const user = renderPrompt(loadPrompt('parse-date'), {
        now: toZonedIso(now, timeZone),
        timezone: timeZone,
        mensaje: truncate(text, MAX_LLM_INPUT_CHARS),
      });
      return validateParsedDate(await getAIResponse({ user, temperature: 0, json: true }));
    },
  };
}

/** Builds the AI service from the environment (AI_PROVIDER + ENABLE_FALLBACK / FALLBACK_PROVIDER). */
export function createAIService(
  config: AppConfig,
  logger: Logger,
  fetchFn?: typeof fetch,
  onUsage?: (usage: LLMUsage) => void,
): AIService {
  if (config.LLM_MODE === 'mock') return createMockAIService();
  const extra = { ...(fetchFn ? { fetchFn } : {}), ...(onUsage ? { onUsage } : {}) };

  const openai = config.OPENAI_API_KEY
    ? new OpenAIProvider({
        apiKey: config.OPENAI_API_KEY,
        model: config.OPENAI_MODEL,
        baseUrl: config.OPENAI_BASE_URL,
        timeoutMs: config.LLM_TIMEOUT_MS,
        logger,
        ...extra,
      })
    : undefined;
  const deepseek = config.DEEPSEEK_API_KEY
    ? new DeepSeekProvider({
        apiKey: config.DEEPSEEK_API_KEY,
        model: config.DEEPSEEK_MODEL,
        baseUrl: config.DEEPSEEK_BASE_URL,
        timeoutMs: config.LLM_TIMEOUT_MS,
        logger,
        ...extra,
      })
    : undefined;

  const primary = config.AI_PROVIDER === 'openai' ? openai : deepseek;
  if (!primary) {
    throw new Error(`Falta la API key del proveedor ${config.AI_PROVIDER}`);
  }
  const fallback = buildFallback(config, logger, deepseek, extra);
  return createLiveAIService({ primary, ...(fallback ? { fallback } : {}), logger });
}

/**
 * Fallback provider (F12): another OpenAI model (OPENAI_FALLBACK_MODEL) by default; DeepSeek
 * only with FALLBACK_PROVIDER=deepseek. Misconfigurations disable the fallback with a warning.
 */
function buildFallback(
  config: AppConfig,
  logger: Logger,
  deepseek: LLMProvider | undefined,
  extra: Pick<OpenAICompatibleOptions, 'fetchFn' | 'onUsage'>,
): LLMProvider | undefined {
  if (!config.ENABLE_FALLBACK) return undefined;
  if (config.FALLBACK_PROVIDER === 'openai') {
    if (!config.OPENAI_API_KEY || !config.OPENAI_FALLBACK_MODEL) {
      logger.warn('ENABLE_FALLBACK=true con FALLBACK_PROVIDER=openai necesita OPENAI_API_KEY y OPENAI_FALLBACK_MODEL: sin fallback');
      return undefined;
    }
    if (config.AI_PROVIDER === 'openai' && config.OPENAI_FALLBACK_MODEL === config.OPENAI_MODEL) {
      logger.warn('OPENAI_FALLBACK_MODEL es el mismo modelo que OPENAI_MODEL: sin fallback');
      return undefined;
    }
    return new OpenAICompatibleProvider({
      name: 'openai-fallback',
      apiKey: config.OPENAI_API_KEY,
      model: config.OPENAI_FALLBACK_MODEL,
      baseUrl: config.OPENAI_BASE_URL,
      timeoutMs: config.LLM_TIMEOUT_MS,
      logger,
      ...extra,
    });
  }
  if (config.AI_PROVIDER === 'deepseek' || !deepseek) {
    logger.warn('FALLBACK_PROVIDER=deepseek necesita DEEPSEEK_API_KEY y otro proveedor principal: sin fallback');
    return undefined;
  }
  logger.warn('Fallback a DeepSeek activado: los mensajes de los clientes pueden salir del EEE (ver docs/rgpd.md)');
  return deepseek;
}
