/**
 * POST /chatwoot/webhook (CU-A11 /bot off, CU-A12 /bot on, CU-A13 /bot status, CU-A14 manual message).
 * Auth: `X-Chatwoot-Signature: sha256=HMAC(secret, "<X-Chatwoot-Timestamp>.<raw body>")` (recent
 * Chatwoot versions with a webhook secret) or `?token=<secret>` / `x-chatwoot-token` header.
 * Events that need work go through the durable inbound queue (F11), in order with the client's
 * WhatsApp messages of the same contact and idempotent by Chatwoot message id.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Tenant } from '@clinicai/db';
import { maskPhone } from '@clinicai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { safeEqual } from '../app';
import type { AppDeps } from '../deps';
import { BOT_SOURCE_PREFIX, type ChatwootService } from '../services/chatwoot';
import { OUTSIDE_WINDOW_CODE, resolveWaAccount, WhatsAppApiError } from '../services/whatsapp';

const MESSAGE_TYPES = ['incoming', 'outgoing', 'activity', 'template'] as const;

const webhookSchema = z
  .object({
    event: z.string(),
    id: z.union([z.number(), z.string()]).optional(),
    content: z.string().nullable().optional(),
    message_type: z.union([z.enum(MESSAGE_TYPES), z.number()]).optional(),
    private: z.boolean().optional(),
    source_id: z.string().nullable().optional(),
    content_attributes: z.record(z.string(), z.unknown()).nullable().optional(),
    sender: z.object({ id: z.union([z.number(), z.string()]).optional(), name: z.string().nullable().optional() }).loose().nullable().optional(),
    account: z.object({ id: z.number() }).loose().optional(),
    conversation: z.object({ id: z.number() }).loose().optional(),
  })
  .loose();
type ChatwootWebhook = z.infer<typeof webhookSchema>;

export const BOT_COMMAND_HELP =
  '🤖 Comandos disponibles: /bot off (pausar el bot para este contacto), /bot on (reactivarlo), /bot status (ver el estado).';

export function signChatwootPayload(secret: string, timestamp: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody.toString()}`).digest('hex')}`;
}

/** F34: a signed webhook older (or newer) than this is refused, so a captured one cannot be replayed. */
export const CHATWOOT_SIGNATURE_MAX_AGE_SECONDS = 300;

function verify(
  secret: string | undefined,
  headers: Record<string, unknown>,
  query: Record<string, unknown>,
  raw: Buffer,
  nowMs: number = Date.now(),
): boolean {
  if (!secret) return false;
  const signature = headers['x-chatwoot-signature'];
  const timestamp = headers['x-chatwoot-timestamp'];
  if (typeof signature === 'string' && typeof timestamp === 'string') {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds) || Math.abs(nowMs / 1000 - seconds) > CHATWOOT_SIGNATURE_MAX_AGE_SECONDS) return false;
    const expected = Buffer.from(signChatwootPayload(secret, timestamp, raw));
    const received = Buffer.from(signature);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }
  // Without signature: the shared secret in the header or, as a fallback, in the URL (docs/deploy.md
  // recommends the signature: a URL may end up in proxy logs).
  const token = typeof query.token === 'string' ? query.token : headers['x-chatwoot-token'];
  return safeEqual(typeof token === 'string' ? token : undefined, secret);
}

function messageType(value: ChatwootWebhook['message_type']): (typeof MESSAGE_TYPES)[number] | undefined {
  return typeof value === 'number' ? MESSAGE_TYPES[value] : value;
}

export type BotCommand = 'off' | 'on' | 'status' | 'invalid';

export function parseBotCommand(content: string): BotCommand | null {
  const t = content.trim().toLowerCase();
  if (!t.startsWith('/bot')) return null;
  const m = /^\/bot\s+(off|on|status)\s*$/.exec(t);
  return m ? (m[1] as BotCommand) : 'invalid';
}

/**
 * The clinic and phone of a conversation, only from the link the bot stored when it created it
 * (account + conversation id). F32: the conversation's custom attributes are not trusted any more:
 * any agent can edit them, and with a Chatwoot shared by several clinics they could point at another
 * clinic (its WhatsApp number would send the message).
 */
async function resolveContact(deps: AppDeps, payload: ChatwootWebhook): Promise<{ tenant: Tenant; phone: string } | null> {
  const conversationId = payload.conversation?.id;
  const accountId = payload.account?.id;
  if (conversationId === undefined || accountId === undefined) return null;
  // The clinic is not known yet: lookups span clinics (F19: owner connection).
  const link = await deps.systemRepos.chatwootLinks.findByConversation(accountId, conversationId);
  if (!link) return null;
  const tenant = await deps.systemRepos.tenants.findById(link.tenantId);
  return tenant ? { tenant, phone: link.phone } : null;
}

/** What the queue stores for a Chatwoot event that needs work (validated again when executed). */
export const chatwootActionSchema = z.object({
  accountId: z.number(),
  conversationId: z.number(),
  content: z.string().min(1),
  private: z.boolean(),
  senderName: z.string().nullable(),
});
export type ChatwootAction = z.infer<typeof chatwootActionSchema>;

export type PreparedChatwootEvent =
  | { ignored: string }
  | { tenantId: string; phone: string; externalId: string; action: ChatwootAction };

/**
 * Decides whether a webhook needs work and for which contact, without side effects. Only agent
 * messages and `/bot` commands written as private notes are kept.
 */
export async function prepareChatwootEvent(deps: AppDeps, payload: ChatwootWebhook, raw: Buffer): Promise<PreparedChatwootEvent> {
  if (payload.event !== 'message_created') return { ignored: 'ignored:event' };
  if (messageType(payload.message_type) !== 'outgoing') return { ignored: 'ignored:not-outgoing' };
  const own = payload.source_id?.startsWith(BOT_SOURCE_PREFIX) || payload.content_attributes?.clinicai_bot === true;
  if (own) return { ignored: 'ignored:own-message' };
  const content = payload.content?.trim() ?? '';
  if (!content) return { ignored: 'ignored:empty' };
  const isPrivate = payload.private === true;
  if (isPrivate && !parseBotCommand(content)) return { ignored: 'ignored:private-note' };

  const contact = await resolveContact(deps, payload);
  if (!contact || !payload.conversation || !payload.account) {
    deps.logger.warn({ conversationId: payload.conversation?.id }, 'chatwoot webhook for an unknown conversation');
    return { ignored: 'ignored:unknown-conversation' };
  }
  const externalId =
    payload.id !== undefined
      ? `${payload.account.id}:${String(payload.id)}`
      : `sha256:${createHash('sha256').update(raw).digest('hex')}`;
  const senderName = payload.sender?.name ?? (payload.sender?.id !== undefined ? String(payload.sender.id) : null);
  return {
    tenantId: contact.tenant.id,
    phone: contact.phone,
    externalId,
    action: {
      accountId: payload.account.id,
      conversationId: payload.conversation.id,
      content,
      private: isPrivate,
      senderName,
    },
  };
}

/** Runs a queued Chatwoot action: `/bot` command (private note) or agent message to WhatsApp. */
export async function executeChatwootAction(
  deps: AppDeps,
  chatwoot: ChatwootService,
  tenant: Tenant,
  phone: string,
  action: ChatwootAction,
): Promise<string> {
  const target = await chatwoot.resolveTarget(tenant);
  const conversation = { baseUrl: target.baseUrl, accountId: action.accountId, conversationId: action.conversationId };

  if (action.private) {
    const command = parseBotCommand(action.content);
    if (!command) return 'ignored:private-note';
    let reply: string;
    if (command === 'off') {
      const added = await deps.repos.blacklist.add(tenant.id, phone, action.senderName ?? 'chatwoot', 'chatwoot /bot off');
      reply = added ? '🤖 Bot desactivado para este contacto' : '🤖 El bot ya estaba desactivado para este contacto';
    } else if (command === 'on') {
      const removed = await deps.repos.blacklist.remove(tenant.id, phone);
      reply = removed ? '🤖 Bot activado' : '🤖 El bot ya estaba activo para este contacto';
    } else if (command === 'status') {
      const paused = await deps.repos.blacklist.isBlocked(tenant.id, phone);
      reply = `🤖 Estado del bot: ${paused ? 'pausado' : 'activo'}`;
    } else {
      reply = BOT_COMMAND_HELP;
    }
    deps.logger.info({ tenantId: tenant.id, phone: maskPhone(phone), command }, 'chatwoot bot command');
    await chatwoot.postBotMessage(conversation, reply, true);
    return `command:${command}`;
  }

  // Message written by a human agent → deliver it to the client on WhatsApp. The live client
  // already retries temporary errors; a final failure is reported to the agent as a private note.
  const account = resolveWaAccount(tenant, deps.config);
  if (!account) return 'ignored:no-whatsapp-credentials';
  try {
    await deps.whatsapp.sendText(account, phone, action.content);
    deps.logger.info({ tenantId: tenant.id, phone: maskPhone(phone) }, 'agent message sent to whatsapp');
    return 'sent';
  } catch (error) {
    const outside = error instanceof WhatsAppApiError && error.code === OUTSIDE_WINDOW_CODE;
    const note = outside
      ? '⚠️ No se pudo enviar por WhatsApp: han pasado más de 24 h desde el último mensaje del cliente (solo se permiten plantillas).'
      : `⚠️ No se pudo enviar el mensaje por WhatsApp: ${error instanceof Error ? error.message : String(error)}`;
    await chatwoot.postBotMessage(conversation, note, true);
    return 'failed';
  }
}

/**
 * The webhook authenticates, filters and stores the event; the queue worker executes it.
 * Answers 500 when the event cannot be stored.
 */
export function registerChatwootRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post('/chatwoot/webhook', async (request, reply) => {
    const raw = request.rawBody ?? Buffer.alloc(0);
    if (!verify(deps.config.CHATWOOT_WEBHOOK_SECRET, request.headers, request.query as Record<string, unknown>, raw)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const parsed = webhookSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(200).send({ status: 'ignored:invalid-payload' });
    try {
      const prepared = await prepareChatwootEvent(deps, parsed.data, raw);
      if ('ignored' in prepared) return reply.code(200).send({ status: prepared.ignored });
      const stored = await deps.systemRepos.inboundEvents.enqueue({
        source: 'chatwoot',
        externalId: prepared.externalId,
        tenantId: prepared.tenantId,
        phone: prepared.phone,
        payload: prepared.action,
      });
      if (stored) deps.inboundSignal.notify();
      return reply.code(200).send({ status: stored ? 'queued' : 'duplicate' });
    } catch (error) {
      deps.logger.error({ err: error instanceof Error ? error.message : String(error) }, 'could not store chatwoot event');
      return reply.code(500).send({ error: 'temporarily unavailable' });
    }
  });
}
