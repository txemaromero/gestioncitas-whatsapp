/**
 * WhatsApp Cloud API client. Live mode calls the Graph API; mock mode keeps an
 * in-memory outbox (simulator/tests) and optionally prints to the console.
 *
 * Limits enforced here (Meta docs): ≤ 3 reply buttons with title ≤ 20 chars; lists with
 * ≤ 10 rows in total, row title ≤ 24, description ≤ 72, button text ≤ 20.
 */
import type { Tenant } from '@clinicai/db';
import { e164ToWaId, maskPhone } from '@clinicai/shared';
import { decryptSecret } from '@clinicai/shared/crypto';
import { z } from 'zod';
import type { AppConfig } from '../config';
import type { OutgoingMessage, ReplyButton } from '../engine/types';
import { renderOutgoingAsText } from '../engine/types';
import type { Logger } from '../logger';

export interface WaAccount {
  phoneNumberId: string;
  accessToken: string;
}

export interface WhatsAppClient {
  readonly mode: 'live' | 'mock';
  /** Sends any outgoing message; returns the WhatsApp message id (wamid) when available. */
  send(account: WaAccount, to: string, message: OutgoingMessage): Promise<string | null>;
  sendText(account: WaAccount, to: string, text: string): Promise<string | null>;
  sendButtons(account: WaAccount, to: string, body: string, buttons: ReplyButton[]): Promise<string | null>;
  sendList(
    account: WaAccount,
    to: string,
    body: string,
    buttonText: string,
    sections: Extract<OutgoingMessage, { type: 'list' }>['sections'],
  ): Promise<string | null>;
  sendTemplate(account: WaAccount, to: string, template: Extract<OutgoingMessage, { type: 'template' }>): Promise<string | null>;
  markAsRead(account: WaAccount, messageId: string): Promise<void>;
  /**
   * F16: downloads an incoming media file (voice notes). Throws MediaTooLargeError above
   * `maxBytes` (checked before downloading when Meta reports the size).
   */
  downloadMedia(account: WaAccount, mediaId: string, maxBytes: number): Promise<DownloadedMedia>;
}

export interface DownloadedMedia {
  data: Buffer;
  mimeType: string;
}

export class MediaTooLargeError extends Error {
  constructor(readonly size: number) {
    super(`Media too large: ${size} bytes`);
    this.name = 'MediaTooLargeError';
  }
}

/** Meta's "Retrieve media URL" response (the URL is valid for 5 minutes). */
/**
 * F34: Meta's media URLs (lookaside.fbsbx.com and its CDNs). The download carries the access token,
 * so any other address (or one reached through a redirect) is refused.
 */
const MEDIA_HOSTS = ['fbsbx.com', 'fbcdn.net', 'facebook.com', 'whatsapp.net'];
const MAX_MEDIA_REDIRECTS = 3;

export function isMetaMediaUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && MEDIA_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** Reads a download up to `maxBytes`, also when Meta does not say the size (F34). */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new MediaTooLargeError(declared);
  if (!response.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new MediaTooLargeError(total);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const mediaUrlSchema = z
  .object({ url: z.url(), mime_type: z.string(), file_size: z.union([z.number(), z.string()]).optional() })
  .loose();

/** Simulator/tests: a mock media id carries its "audio" (the text to transcribe) in base64url. */
export const MOCK_MEDIA_PREFIX = 'mock-media:';
export function mockMediaId(content: string | Buffer): string {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return `${MOCK_MEDIA_PREFIX}${data.toString('base64url')}`;
}

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'WhatsAppApiError';
  }
}

/** Meta error codes worth retrying with backoff (throughput / temporary errors). */
const RETRYABLE_CODES = new Set([1, 2, 4, 80007, 130429, 131016, 131056, 133004]);
/** Outside the 24 h customer-service window (only templates allowed). */
export const OUTSIDE_WINDOW_CODE = 131047;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Builds the Graph API payload for a message (exported for tests). */
export function buildPayload(to: string, message: OutgoingMessage): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: e164ToWaId(to) };
  switch (message.type) {
    case 'text':
      return { ...base, type: 'text', text: { preview_url: false, body: clip(message.text, 4096) } };
    case 'buttons':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: clip(message.body, 1024) },
          ...(message.footer ? { footer: { text: clip(message.footer, 60) } } : {}),
          action: {
            buttons: message.buttons.slice(0, 3).map((b) => ({
              type: 'reply',
              reply: { id: clip(b.id, 256), title: clip(b.title, 20) },
            })),
          },
        },
      };
    case 'list': {
      let remaining = 10;
      const sections = message.sections
        .map((s) => {
          const rows = s.rows.slice(0, Math.max(0, remaining));
          remaining -= rows.length;
          return {
            ...(s.title ? { title: clip(s.title, 24) } : {}),
            rows: rows.map((r) => ({
              id: clip(r.id, 200),
              title: clip(r.title, 24),
              ...(r.description ? { description: clip(r.description, 72) } : {}),
            })),
          };
        })
        .filter((s) => s.rows.length > 0)
        .slice(0, 10);
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: clip(message.body, 4096) },
          ...(message.footer ? { footer: { text: clip(message.footer, 60) } } : {}),
          action: { button: clip(message.buttonText, 20), sections },
        },
      };
    }
    case 'template':
      return {
        ...base,
        type: 'template',
        template: {
          name: message.name,
          language: { code: message.language },
          components: [
            { type: 'body', parameters: message.bodyParams.map((text) => ({ type: 'text', text })) },
            ...message.quickReplyPayloads.map((payload, index) => ({
              type: 'button',
              sub_type: 'quick_reply',
              index: String(index),
              parameters: [{ type: 'payload', payload }],
            })),
          ],
        },
      };
  }
}

export interface LiveWhatsAppOptions {
  graphVersion: string;
  logger: Logger;
  fetchFn?: typeof fetch;
  maxAttempts?: number;
  baseDelayMs?: number;
}

export function createLiveWhatsAppClient(options: LiveWhatsAppOptions): WhatsAppClient {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;

  async function post(account: WaAccount, payload: Record<string, unknown>): Promise<unknown> {
    const url = `https://graph.facebook.com/${options.graphVersion}/${account.phoneNumberId}/messages`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${account.accessToken}` },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15_000),
        });
        const json: unknown = await response.json().catch(() => ({}));
        if (response.ok) return json;
        const err = (json as { error?: { code?: number; message?: string } }).error;
        const retryable =
          response.status === 429 || response.status >= 500 || (err?.code !== undefined && RETRYABLE_CODES.has(err.code));
        throw new WhatsAppApiError(
          `WhatsApp API ${response.status}: ${err?.message ?? 'error'}`,
          response.status,
          err?.code,
          retryable,
        );
      } catch (error) {
        lastError = error;
        const retryable = !(error instanceof WhatsAppApiError) || error.retryable;
        if (!retryable || attempt === maxAttempts) break;
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
      }
    }
    throw lastError;
  }

  const client: WhatsAppClient = {
    mode: 'live',
    async send(account, to, message) {
      const json = (await post(account, buildPayload(to, message))) as { messages?: { id?: string }[] };
      options.logger.debug({ to: maskPhone(to), type: message.type }, 'whatsapp message sent');
      return json.messages?.[0]?.id ?? null;
    },
    sendText: (account, to, text) => client.send(account, to, { type: 'text', text }),
    sendButtons: (account, to, body, buttons) => client.send(account, to, { type: 'buttons', body, buttons }),
    sendList: (account, to, body, buttonText, sections) =>
      client.send(account, to, { type: 'list', body, buttonText, sections }),
    sendTemplate: (account, to, template) => client.send(account, to, template),
    async markAsRead(account, messageId) {
      await post(account, { messaging_product: 'whatsapp', status: 'read', message_id: messageId });
    },
    async downloadMedia(account, mediaId, maxBytes) {
      const auth = { authorization: `Bearer ${account.accessToken}` };
      const locate = async () => {
        const response = await fetchFn(`https://graph.facebook.com/${options.graphVersion}/${encodeURIComponent(mediaId)}`, {
          headers: auth,
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new WhatsAppApiError(`Media lookup ${response.status}`, response.status, undefined, response.status >= 500);
        const info = mediaUrlSchema.parse(await response.json());
        const size = Number(info.file_size ?? 0);
        if (size > maxBytes) throw new MediaTooLargeError(size);
        return info;
      };
      // Redirects are followed by hand, only within Meta's hosts; the token only goes to the first URL.
      const download = async (url: string) => {
        let current = url;
        for (let hop = 0; hop <= MAX_MEDIA_REDIRECTS; hop++) {
          if (!isMetaMediaUrl(current)) throw new WhatsAppApiError('Media URL outside Meta', 400, undefined, false);
          const response = await fetchFn(current, {
            headers: hop === 0 ? auth : {},
            redirect: 'manual',
            signal: AbortSignal.timeout(15_000),
          });
          const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
          if (!location) return response;
          current = new URL(location, current).toString();
        }
        throw new WhatsAppApiError('Too many media redirects', 400, undefined, false);
      };
      let info = await locate();
      let response = await download(info.url);
      // Meta: a failed download returns 404; get a new URL and try once more.
      if (response.status === 404) {
        info = await locate();
        response = await download(info.url);
      }
      if (!response.ok) throw new WhatsAppApiError(`Media download ${response.status}`, response.status, undefined, response.status >= 500);
      const data = await readCapped(response, maxBytes);
      return { data, mimeType: info.mime_type };
    },
  };
  return client;
}

export interface OutboxEntry {
  account: WaAccount;
  to: string;
  message: OutgoingMessage;
  at: Date;
}

export interface MockWhatsAppClient extends WhatsAppClient {
  readonly outbox: OutboxEntry[];
  readonly readReceipts: string[];
  clear(): void;
}

/** WHATSAPP_MODE=mock: messages go to memory (and to the console when `echo` is set). */
export function createMockWhatsAppClient(options: { echo?: (line: string) => void } = {}): MockWhatsAppClient {
  const outbox: OutboxEntry[] = [];
  const readReceipts: string[] = [];
  let counter = 0;
  const client: MockWhatsAppClient = {
    mode: 'mock',
    outbox,
    readReceipts,
    clear() {
      outbox.length = 0;
      readReceipts.length = 0;
    },
    async send(account, to, message) {
      // Validate exactly like the live client would build it.
      buildPayload(to, message);
      outbox.push({ account, to, message, at: new Date() });
      options.echo?.(`[whatsapp:mock → ${maskPhone(to)}] ${renderOutgoingAsText(message)}`);
      counter += 1;
      return `wamid.mock.${counter}`;
    },
    sendText: (account, to, text) => client.send(account, to, { type: 'text', text }),
    sendButtons: (account, to, body, buttons) => client.send(account, to, { type: 'buttons', body, buttons }),
    sendList: (account, to, body, buttonText, sections) =>
      client.send(account, to, { type: 'list', body, buttonText, sections }),
    sendTemplate: (account, to, template) => client.send(account, to, template),
    async markAsRead(_account, messageId) {
      readReceipts.push(messageId);
    },
    async downloadMedia(_account, mediaId, maxBytes) {
      if (!mediaId.startsWith(MOCK_MEDIA_PREFIX)) throw new WhatsAppApiError('Mock media not found', 404, undefined, false);
      const data = Buffer.from(mediaId.slice(MOCK_MEDIA_PREFIX.length), 'base64url');
      if (data.length > maxBytes) throw new MediaTooLargeError(data.length);
      return { data, mimeType: 'audio/ogg; codecs=opus' };
    },
  };
  return client;
}

/** WhatsApp credentials of a tenant: its own (encrypted) token, or the global one. */
export function resolveWaAccount(tenant: Tenant, config: AppConfig): WaAccount | null {
  const phoneNumberId = tenant.waPhoneNumberId ?? config.NUMBER_ID;
  let accessToken = config.META_JWT_TOKEN;
  if (tenant.waAccessTokenEnc && config.ENCRYPTION_KEY) {
    accessToken = decryptSecret(tenant.waAccessTokenEnc, config.ENCRYPTION_KEY);
  }
  if (config.WHATSAPP_MODE === 'mock') {
    return { phoneNumberId: phoneNumberId ?? 'mock', accessToken: accessToken ?? 'mock' };
  }
  if (!phoneNumberId || !accessToken) return null;
  return { phoneNumberId, accessToken };
}
