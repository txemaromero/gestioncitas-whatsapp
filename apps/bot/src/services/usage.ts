/**
 * F31: usage counters for the platform console (messages, AI tokens, seconds of voice).
 * Recording never blocks nor breaks a conversation: it runs as a background task and a failure is
 * only logged. The clinic comes from the tenant context (`runWithTenant`).
 */
import { currentTenantId, recordUsage, type Db } from '@clinicai/db';
import type { UsageEntry } from '@clinicai/shared';
import type { OutgoingMessage } from '../engine/types';
import type { Logger } from '../logger';
import type { BackgroundTasks } from '../utils/background';
import type { Clock } from '../utils/clock';
import type { LLMUsage } from './aiServices';
import type { WhatsAppClient } from './whatsapp';

export interface UsageRecorder {
  /** Adds the entries to the counters of the clinic of the current context (or `tenantId`). */
  record(entries: UsageEntry[], tenantId?: string): void;
}

export function createUsageRecorder(deps: {
  systemDb: Db;
  background: BackgroundTasks;
  clock: Clock;
  logger: Logger;
}): UsageRecorder {
  return {
    record(entries, tenantId = currentTenantId()) {
      if (!tenantId) {
        deps.logger.debug({ metrics: entries.map((e) => e.metric) }, 'usage without a clinic context: not counted');
        return;
      }
      const now = deps.clock.now();
      deps.background.run('usage', () => recordUsage(deps.systemDb, tenantId, entries, now));
    },
  };
}

/** Entries of one AI completion. */
export const llmUsageEntries = (u: LLMUsage): UsageEntry[] => [
  { metric: 'llm.requests', model: u.model, amount: 1 },
  { metric: 'llm.prompt_tokens', model: u.model, amount: u.promptTokens },
  { metric: 'llm.completion_tokens', model: u.model, amount: u.completionTokens },
];

/**
 * Counts every message the client sends successfully: templates (what Meta bills as «utility»)
 * apart from free-form replies. The rest of the client (mock outbox included) is kept as is.
 */
export function countWhatsAppUsage<T extends WhatsAppClient>(client: T, usage: UsageRecorder): T {
  const counted = async (sending: Promise<string | null>, template: boolean) => {
    const id = await sending;
    usage.record([{ metric: template ? 'whatsapp.template' : 'whatsapp.outbound', amount: 1 }]);
    return id;
  };
  const sending: Pick<WhatsAppClient, 'send' | 'sendText' | 'sendButtons' | 'sendList' | 'sendTemplate'> = {
    send: (account, to, message: OutgoingMessage) => counted(client.send(account, to, message), message.type === 'template'),
    sendText: (account, to, text) => counted(client.sendText(account, to, text), false),
    sendButtons: (account, to, body, buttons) => counted(client.sendButtons(account, to, body, buttons), false),
    sendList: (account, to, body, buttonText, sections) => counted(client.sendList(account, to, body, buttonText, sections), false),
    sendTemplate: (account, to, template) => counted(client.sendTemplate(account, to, template), true),
  };
  // Inherits from the client, so everything else (own or inherited: mode, outbox…) stays reachable.
  return Object.assign(Object.create(client) as T, sending);
}
