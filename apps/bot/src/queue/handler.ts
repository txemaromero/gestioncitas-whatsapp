/**
 * Executes one inbound event (F11): WhatsApp messages go to the conversation engine, Chatwoot
 * actions to the handoff module and internal jobs (F12: delete a Chatwoot contact after an
 * erasure) to their service. Stored payloads are validated again; an invalid one is not retried.
 */
import { CHATWOOT_DELETE_CONTACT_JOB, WAITLIST_CHECK_JOB, runWithTenant, type Tenant } from '@clinicai/db';
import { maskPhone } from '@clinicai/shared';
import { z } from 'zod';
import type { AppDeps } from '../deps';
import type { MessageHandler } from '../engine/types';
import { processWaitlist } from '../jobs/waitlist';
import { chatwootObserver, type ChatwootService } from '../services/chatwoot';
import { chatwootActionSchema, executeChatwootAction } from '../webhook/chatwoot';
import { normalizeMessage, webhookEnvelopeSchema } from '../webhook/meta';
import { NonRetryableError, type InboundEventHandler } from './worker';

const internalJobSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal(CHATWOOT_DELETE_CONTACT_JOB), accountId: z.number().int(), contactId: z.number().int() }),
  // F21: a slot may have been freed from the panel (cancellation, change, absence removed…).
  z.object({ type: z.literal(WAITLIST_CHECK_JOB), reason: z.string().optional() }),
]);

async function runInternalJob(deps: AppDeps, chatwoot: ChatwootService | null, tenant: Tenant, payload: unknown): Promise<void> {
  const job = internalJobSchema.safeParse(payload);
  if (!job.success) throw new NonRetryableError('invalid internal job');
  if (job.data.type === WAITLIST_CHECK_JOB) {
    const result = await processWaitlist(deps, { tenantId: tenant.id }, chatwootObserver(chatwoot));
    deps.logger.info({ tenantId: tenant.id, reason: job.data.reason, ...result }, 'waiting list checked (panel change)');
    return;
  }
  // Delete the Chatwoot contact of an erased client.
  if (!chatwoot) throw new NonRetryableError('Chatwoot is not configured: delete the contact by hand');
  const outcome = await chatwoot.deleteContact(tenant, job.data.accountId, job.data.contactId);
  deps.logger.info({ tenantId: tenant.id, contactId: job.data.contactId, outcome }, 'chatwoot contact deleted (erasure)');
}

export function createInboundEventHandler(
  deps: AppDeps,
  engine: MessageHandler,
  chatwoot: ChatwootService | null,
): InboundEventHandler {
  return async (event) => {
    const tenant = await deps.systemRepos.tenants.findById(event.tenantId);
    if (!tenant) {
      deps.logger.warn({ eventId: event.id, tenantId: event.tenantId }, 'inbound event of a deleted tenant: skipped');
      return;
    }
    // F19: from here on, everything is work of this clinic.
    await runWithTenant(tenant.id, () => handleForTenant(tenant, event));
  };

  async function handleForTenant(tenant: Tenant, event: Parameters<InboundEventHandler>[0]): Promise<void> {

    if (event.source === 'whatsapp') {
      const envelope = webhookEnvelopeSchema.safeParse(event.payload);
      if (!envelope.success) throw new NonRetryableError('invalid stored WhatsApp payload');
      const message = normalizeMessage(tenant.id, envelope.data);
      if (!message) throw new NonRetryableError('stored WhatsApp message without phone number');
      deps.logger.info(
        { tenantId: tenant.id, phone: maskPhone(message.phone), type: message.type, rawType: message.rawType, attempt: event.attempts },
        'incoming whatsapp message',
      );
      // F31: counted once, on the first attempt (retries are the same message).
      if (event.attempts <= 1) deps.usage.record([{ metric: 'whatsapp.inbound', amount: 1 }]);
      await engine.handle(tenant, message);
      return;
    }

    if (event.source === 'internal') {
      await runInternalJob(deps, chatwoot, tenant, event.payload);
      return;
    }

    if (!chatwoot) {
      deps.logger.warn({ eventId: event.id, tenantId: tenant.id }, 'chatwoot event but Chatwoot is not configured: skipped');
      return;
    }
    const action = chatwootActionSchema.safeParse(event.payload);
    if (!action.success) throw new NonRetryableError('invalid stored Chatwoot payload');
    const outcome = await executeChatwootAction(deps, chatwoot, tenant, event.phone, action.data);
    deps.logger.debug({ eventId: event.id, outcome }, 'chatwoot event processed');
  }
}
