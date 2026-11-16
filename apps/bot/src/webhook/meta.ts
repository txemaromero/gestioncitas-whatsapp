/**
 * Meta webhook helpers: signature verification (X-Hub-Signature-256), payload schema and
 * normalization of incoming messages to `IncomingMessage`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { waIdToE164 } from '@clinicai/shared';
import { z } from 'zod';
import type { IncomingMessage } from '../engine/types';

/** `sha256=` + HMAC-SHA256(raw body, app secret), compared in constant time. */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function signMetaPayload(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

export const rawMessageSchema = z
  .object({
    from: z.string().optional(),
    id: z.string(),
    timestamp: z.string().optional(),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    interactive: z
      .object({
        type: z.string(),
        button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
        list_reply: z.object({ id: z.string(), title: z.string(), description: z.string().optional() }).optional(),
      })
      .optional(),
    button: z.object({ payload: z.string().optional(), text: z.string().optional() }).optional(),
    // F16: voice notes / audio files (Meta sends no duration).
    audio: z.object({ id: z.string(), mime_type: z.string().optional(), voice: z.boolean().optional() }).loose().optional(),
  })
  .loose();
export type RawWhatsAppMessage = z.infer<typeof rawMessageSchema>;

const valueSchema = z
  .object({
    messaging_product: z.string().optional(),
    metadata: z.object({ phone_number_id: z.string(), display_phone_number: z.string().optional() }).loose(),
    contacts: z
      .array(z.object({ wa_id: z.string().optional(), profile: z.object({ name: z.string().optional() }).loose().optional() }).loose())
      .optional(),
    messages: z.array(rawMessageSchema).optional(),
    statuses: z.array(z.unknown()).optional(),
  })
  .loose();

export const metaWebhookSchema = z
  .object({
    object: z.string(),
    entry: z.array(
      z
        .object({
          id: z.string().optional(),
          changes: z.array(z.object({ field: z.string().optional(), value: valueSchema }).loose()),
        })
        .loose(),
    ),
  })
  .loose();
export type MetaWebhookPayload = z.infer<typeof metaWebhookSchema>;

/** One message of a webhook payload with its routing data (stored as-is in the inbound queue). */
export const webhookEnvelopeSchema = z.object({
  phoneNumberId: z.string(),
  message: rawMessageSchema,
  profileName: z.string().optional(),
});
export type WebhookMessageEnvelope = z.infer<typeof webhookEnvelopeSchema>;

/** Flattens entries/changes into incoming messages; `statuses` events are ignored. */
export function extractMessages(payload: MetaWebhookPayload): WebhookMessageEnvelope[] {
  const result: WebhookMessageEnvelope[] = [];
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const { value } = change;
      for (const message of value.messages ?? []) {
        const contact = value.contacts?.find((c) => c.wa_id === message.from) ?? value.contacts?.[0];
        const profileName = contact?.profile?.name;
        result.push({
          phoneNumberId: value.metadata.phone_number_id,
          message,
          ...(profileName ? { profileName } : {}),
        });
      }
    }
  }
  return result;
}

/** Normalizes a raw WhatsApp message. Returns null when there is no phone (BSUID-only users). */
export function normalizeMessage(
  tenantId: string,
  envelope: WebhookMessageEnvelope,
): IncomingMessage | null {
  const { message } = envelope;
  if (!message.from) return null;
  const base = {
    tenantId,
    phone: waIdToE164(message.from),
    waMessageId: message.id,
    rawType: message.type,
    timestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date(),
    ...(envelope.profileName ? { profileName: envelope.profileName } : {}),
  };
  if (message.type === 'text' && message.text) {
    return { ...base, type: 'text', text: message.text.body, payloadId: null };
  }
  if (message.type === 'interactive' && message.interactive?.button_reply) {
    const reply = message.interactive.button_reply;
    return { ...base, type: 'button', text: reply.title, payloadId: reply.id };
  }
  if (message.type === 'interactive' && message.interactive?.list_reply) {
    const reply = message.interactive.list_reply;
    return { ...base, type: 'list', text: reply.title, payloadId: reply.id };
  }
  if (message.type === 'button' && message.button) {
    // Template quick-reply button.
    return {
      ...base,
      type: 'button',
      text: message.button.text ?? '',
      payloadId: message.button.payload ?? null,
    };
  }
  if (message.type === 'audio' && message.audio) {
    const media = { id: message.audio.id, mimeType: message.audio.mime_type ?? null, voice: message.audio.voice ?? false };
    return { ...base, type: 'other', text: '', payloadId: null, media };
  }
  return { ...base, type: 'other', text: '', payloadId: null };
}
