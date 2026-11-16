/**
 * WhatsApp webhook ingestion (F11): resolve the tenant by phone_number_id,
 * apply the rate limit per phone (counted in the database, so it holds across instances) and
 * store every message in `inbound_events`, idempotent by WhatsApp message id. The engine runs
 * later, in the queue worker. Throws when the database is unavailable: the webhook then answers
 * 500 and Meta retries the delivery, so no message is lost.
 */
import type { Prisma, Tenant } from '@clinicai/db';
import { maskPhone, waIdToE164 } from '@clinicai/shared';
import type { AppDeps } from '../deps';
import { extractMessages, type MetaWebhookPayload } from '../webhook/meta';

export const RATE_LIMIT_WINDOW_MS = 60_000;
/**
 * F34: older messages are not taken. Meta stops retrying a delivery after 7 days and the register
 * of processed messages (duplicates) is kept 7 days, so an older one can only be a replay.
 */
export const MAX_MESSAGE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface IngestResult {
  queued: number;
  duplicates: number;
  discarded: number;
  rateLimited: number;
}

export async function ingestWhatsAppPayload(
  deps: Pick<AppDeps, 'systemRepos' | 'logger' | 'config' | 'inboundSignal' | 'clock'>,
  payload: MetaWebhookPayload,
): Promise<IngestResult> {
  const result: IngestResult = { queued: 0, duplicates: 0, discarded: 0, rateLimited: 0 };
  const tenants = new Map<string, Tenant | null>();

  for (const envelope of extractMessages(payload)) {
    let tenant = tenants.get(envelope.phoneNumberId);
    if (tenant === undefined) {
      tenant = await deps.systemRepos.tenants.findByWaPhoneNumberId(envelope.phoneNumberId);
      tenants.set(envelope.phoneNumberId, tenant);
    }
    if (!tenant) {
      deps.logger.warn({ phoneNumberId: envelope.phoneNumberId }, 'webhook for unknown phone_number_id: discarded');
      result.discarded += 1;
      continue;
    }
    if (!envelope.message.from) {
      deps.logger.warn({ tenantId: tenant.id, waMessageId: envelope.message.id }, 'message without phone number: ignored');
      result.discarded += 1;
      continue;
    }
    const phone = waIdToE164(envelope.message.from);
    const sentAt = Number(envelope.message.timestamp) * 1000;
    if (Number.isFinite(sentAt) && sentAt < deps.clock.now().getTime() - MAX_MESSAGE_AGE_MS) {
      deps.logger.warn({ tenantId: tenant.id, waMessageId: envelope.message.id }, 'message older than 7 days: discarded');
      result.discarded += 1;
      continue;
    }

    const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
    if ((await deps.systemRepos.inboundEvents.countRecent(tenant.id, phone, since)) >= deps.config.RATE_LIMIT_PER_MINUTE) {
      deps.logger.warn({ tenantId: tenant.id, phone: maskPhone(phone) }, 'rate limit exceeded: message dropped');
      result.rateLimited += 1;
      continue;
    }

    const stored = await deps.systemRepos.inboundEvents.enqueue({
      source: 'whatsapp',
      externalId: envelope.message.id,
      tenantId: tenant.id,
      phone,
      payload: envelope as unknown as Prisma.InputJsonValue,
    });
    if (stored) {
      result.queued += 1;
    } else {
      deps.logger.info({ tenantId: tenant.id, waMessageId: envelope.message.id }, 'duplicate webhook message: ignored');
      result.duplicates += 1;
    }
  }

  if (result.queued > 0) deps.inboundSignal.notify();
  return result;
}
