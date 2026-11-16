/**
 * F17: offers freed slots to the waiting list. Runs every few minutes (WAITLIST_CRON) and right
 * after a cancellation made through the bot. Each free slot goes to the first client waiting for
 * it, with an approved Meta template (the client may be outside the 24 h window); if they do not
 * answer in WAITLIST_OFFER_MINUTES, the next run offers it to the next client.
 */
import { claimWaitlistOffers, releaseWaitlistOffer, runWithTenant, type Tenant, type WaitlistOffer } from '@clinicai/db';
import { formatHumanDateTime, maskPhone } from '@clinicai/shared';
import cron from 'node-cron';
import type { AppDeps } from '../deps';
import type { EngineObserver } from '../engine/engine';
import { T, firstName } from '../engine/texts';
import type { OutgoingMessage } from '../engine/types';
import { WAITLIST_BOOK, WAITLIST_SKIP } from '../flows/waitlistFlow';
import { resolveWaAccount } from '../services/whatsapp';

export interface WaitlistRunResult {
  tenants: number;
  offered: number;
  failed: number;
}

/** Slots starting sooner than this are not offered: time to read the message and get there. */
export function waitlistLeadMinutes(deps: Pick<AppDeps, 'config'>): number {
  return deps.config.WAITLIST_OFFER_MINUTES * 2;
}

export function buildWaitlistTemplate(
  deps: Pick<AppDeps, 'config'>,
  tenant: Tenant,
  offer: Pick<WaitlistOffer, 'entryId' | 'clientName' | 'start'>,
): Extract<OutgoingMessage, { type: 'template' }> {
  const name = firstName(offer.clientName);
  const when = formatHumanDateTime(offer.start, tenant.timezone);
  const minutes = String(deps.config.WAITLIST_OFFER_MINUTES);
  return {
    type: 'template',
    name: deps.config.WA_WAITLIST_TEMPLATE,
    language: deps.config.WA_TEMPLATE_LANGUAGE,
    // "Hola {{1}}, se ha liberado un hueco en {{2}}: {{3}}. ¿Quieres reservarlo? Si no respondes en
    // {{4}} minutos, se lo ofreceremos a otra persona de la lista de espera."
    bodyParams: [name, tenant.clinicName, when, minutes],
    quickReplyPayloads: [`${WAITLIST_BOOK}${offer.entryId}`, `${WAITLIST_SKIP}${offer.entryId}`],
    preview: T.waitlistOfferPreview(name, tenant.clinicName, when, minutes),
    previewButtons: [T.waitlistButtonBook, T.waitlistButtonSkip],
  };
}

export async function processWaitlist(
  deps: AppDeps,
  options: { tenantId?: string } = {},
  observer: EngineObserver = {},
): Promise<WaitlistRunResult> {
  const now = deps.clock.now();
  const result: WaitlistRunResult = { tenants: 0, offered: 0, failed: 0 };
  const tenants = (
    options.tenantId
      ? [await deps.systemRepos.tenants.findById(options.tenantId)].filter((t): t is Tenant => t !== null)
      : await deps.systemRepos.tenants.listAll()
  ).filter((t) => t.settings.waitlistEnabled);

  for (const tenant of tenants) {
    const account = resolveWaAccount(tenant, deps.config);
    if (!account) continue;
    result.tenants += 1;
    // F19: each clinic's offers run in its own context.
    await runWithTenant(tenant.id, async () => {
    const offers = await claimWaitlistOffers(deps.db, tenant.id, {
      now,
      leadMinutes: waitlistLeadMinutes(deps),
      offerMinutes: deps.config.WAITLIST_OFFER_MINUTES,
      slotMinutes: tenant.settings.slotMinutes,
      timeZone: tenant.timezone,
    });
    for (const offer of offers) {
      const message = buildWaitlistTemplate(deps, tenant, offer);
      try {
        await deps.whatsapp.send(account, offer.phone, message);
        result.offered += 1;
        observer.onOutgoing?.(tenant, offer.phone, [message]);
        deps.logger.info({ tenantId: tenant.id, entryId: offer.entryId, phone: maskPhone(offer.phone) }, 'waiting list offer sent');
      } catch (error) {
        result.failed += 1;
        await releaseWaitlistOffer(deps.db, tenant.id, offer.entryId);
        deps.logger.error(
          {
            tenantId: tenant.id,
            entryId: offer.entryId,
            phone: maskPhone(offer.phone),
            err: error instanceof Error ? error.message : String(error),
          },
          'waiting list offer not sent (is the template approved?)',
        );
      }
    }
    });
  }
  if (result.offered > 0 || result.failed > 0) deps.logger.info({ ...result }, 'waiting list run finished');
  return result;
}

/** Schedules the waiting list job (WAITLIST_CRON, every 5 minutes by default). */
export function startWaitlistCron(deps: AppDeps, observer: EngineObserver = {}): { stop: () => void } {
  const { WAITLIST_CRON, REMINDER_CRON_TZ } = deps.config;
  if (!cron.validate(WAITLIST_CRON)) throw new Error(`WAITLIST_CRON inválido: ${WAITLIST_CRON}`);
  const task = cron.schedule(
    WAITLIST_CRON,
    async () => {
      try {
        await processWaitlist(deps, {}, observer);
      } catch (error) {
        deps.logger.error({ err: error instanceof Error ? error.message : String(error) }, 'waiting list run failed');
      }
    },
    { timezone: REMINDER_CRON_TZ, name: 'waitlist', noOverlap: true },
  );
  deps.logger.info({ cron: WAITLIST_CRON }, 'waiting list cron scheduled');
  return { stop: () => void task.stop() };
}
