/**
 * Human handoff with Chatwoot (RF-W5; CU-A10 consult, CU-A11/A12/A13 bot off/on/status,
 * CU-A14 manual message) through an "API channel" inbox:
 *  - mirror: every incoming client message and every bot reply is copied to Chatwoot
 *    (queued per conversation, never blocks the bot; failures are only logged);
 *  - agents' replies written in Chatwoot are sent to the client via WhatsApp;
 *  - private notes `/bot off|on|status` pause/resume the bot for that contact.
 * Messages created by the bot carry `source_id = clinicai-bot:<uuid>` and
 * `content_attributes.clinicai_bot = true`, so the webhook can discard them (no loops).
 */
import { randomUUID } from 'node:crypto';
import type { Repos, Tenant } from '@clinicai/db';
import { maskPhone } from '@clinicai/shared';
import type { AppConfig } from '../config';
import type { EngineObserver } from '../engine/engine';
import { renderOutgoingAsText, type IncomingMessage, type OutgoingMessage } from '../engine/types';
import type { Logger } from '../logger';
import type { BackgroundTasks } from '../utils/background';

export const BOT_SOURCE_PREFIX = 'clinicai-bot:';

export interface ChatwootTarget {
  baseUrl: string;
  accountId: number;
  inboxId: number;
}

export class ChatwootApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ChatwootApiError';
  }
}

export interface ChatwootServiceOptions {
  config: AppConfig;
  logger: Logger;
  repos: Repos;
  background?: BackgroundTasks;
  fetchFn?: typeof fetch;
}

export interface ChatwootService {
  mirrorIncoming(tenant: Tenant, message: IncomingMessage): void;
  mirrorOutgoing(tenant: Tenant, phone: string, messages: OutgoingMessage[]): void;
  /** Posts a message created by the bot (e.g. private notes answering commands). */
  postBotMessage(target: { accountId: number; conversationId: number; baseUrl: string }, content: string, isPrivate: boolean): Promise<void>;
  resolveTarget(tenant: Tenant): Promise<ChatwootTarget>;
  /**
   * Deletes a contact; Chatwoot also deletes its conversations (GDPR erasure, F12).
   * 404 → already gone. Chatwoot answers 422 while the contact is online (retried by the queue).
   */
  deleteContact(tenant: Tenant, accountId: number, contactId: number): Promise<'deleted' | 'not_found'>;
  /** Waits until queued mirror operations finish (tests, shutdown). */
  idle(): Promise<void>;
}

function describeIncoming(message: IncomingMessage): string {
  switch (message.type) {
    case 'text':
      return message.transcribed ? `🎤 ${message.text}` : message.text;
    case 'button':
      return `[Botón] ${message.text}`;
    case 'list':
      return `[Lista] ${message.text}`;
    case 'other':
      return message.media ? '🎤 Nota de voz (sin transcribir)' : `[${message.rawType}] (mensaje no textual)`;
  }
}

export function createChatwootService(options: ChatwootServiceOptions): ChatwootService {
  const { config, logger, repos } = options;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const token = config.CHATWOOT_TOKEN ?? '';
  const inboxCache = new Map<string, number>();
  const queues = new Map<string, Promise<void>>();

  async function api<T>(baseUrl: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await fetchFn(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', api_access_token: token },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new ChatwootApiError(`Chatwoot ${response.status} on ${path}`, response.status);
    }
    return (await response.json().catch(() => ({}))) as T;
  }

  async function resolveTarget(tenant: Tenant): Promise<ChatwootTarget> {
    const own = tenant.settings.chatwoot;
    if (own) return { baseUrl: own.baseUrl, accountId: own.accountId, inboxId: own.inboxId };
    const baseUrl = config.CHATWOOT_URL ?? '';
    const accountId = config.CHATWOOT_ACCOUNT_ID ?? 0;
    const inboxName = config.CHATWOOT_INBOX_NAME ?? '';
    const key = `${baseUrl}|${accountId}|${inboxName}`;
    let inboxId = inboxCache.get(key);
    if (inboxId === undefined) {
      const data = await api<{ payload?: { id: number; name: string }[] } | { id: number; name: string }[]>(
        baseUrl,
        `/api/v1/accounts/${accountId}/inboxes`,
      );
      const inboxes = Array.isArray(data) ? data : (data.payload ?? []);
      const inbox = inboxes.find((i) => i.name === inboxName);
      if (!inbox) throw new Error(`No existe la bandeja «${inboxName}» en Chatwoot (CHATWOOT_INBOX_NAME)`);
      inboxId = inbox.id;
      inboxCache.set(key, inboxId);
    }
    return { baseUrl, accountId, inboxId };
  }

  /** Finds or creates the Chatwoot contact + conversation for tenant + phone (cached in DB). */
  async function ensureConversation(tenant: Tenant, phone: string, name: string | undefined) {
    const target = await resolveTarget(tenant);
    const existing = await repos.chatwootLinks.get(tenant.id, phone);
    if (existing && existing.accountId === target.accountId && existing.inboxId === target.inboxId) {
      return { target, conversationId: existing.conversationId };
    }
    const identifier = `${tenant.id}:${phone}`;
    const search = await api<{ payload?: { id: number; identifier?: string | null }[] }>(
      target.baseUrl,
      `/api/v1/accounts/${target.accountId}/contacts/search?q=${encodeURIComponent(identifier)}`,
    );
    let contactId = search.payload?.find((c) => c.identifier === identifier)?.id;
    let sourceId: string | undefined;
    if (contactId === undefined) {
      const client = await repos.clients.findByPhone(tenant.id, phone);
      const created = await api<{
        payload?: { contact?: { id: number }; contact_inbox?: { source_id?: string }; id?: number };
        id?: number;
      }>(target.baseUrl, `/api/v1/accounts/${target.accountId}/contacts`, {
        method: 'POST',
        body: {
          inbox_id: target.inboxId,
          name: client?.name ?? name ?? phone,
          phone_number: phone,
          identifier,
          ...(client?.email ? { email: client.email } : {}),
          custom_attributes: { tenant_id: tenant.id, clinic: tenant.clinicName },
        },
      });
      contactId = created.payload?.contact?.id ?? created.payload?.id ?? created.id;
      sourceId = created.payload?.contact_inbox?.source_id;
    }
    if (contactId === undefined) throw new Error('Chatwoot contact could not be created');
    const conversation = await api<{ id: number }>(target.baseUrl, `/api/v1/accounts/${target.accountId}/conversations`, {
      method: 'POST',
      body: {
        inbox_id: target.inboxId,
        contact_id: contactId,
        ...(sourceId ? { source_id: sourceId } : {}),
        custom_attributes: { tenant_id: tenant.id, phone },
      },
    });
    await repos.chatwootLinks.upsert({
      tenantId: tenant.id,
      phone,
      accountId: target.accountId,
      inboxId: target.inboxId,
      contactId,
      conversationId: conversation.id,
    });
    return { target, conversationId: conversation.id };
  }

  async function postBotMessage(
    target: { accountId: number; conversationId: number; baseUrl: string },
    content: string,
    isPrivate: boolean,
    messageType: 'incoming' | 'outgoing' = 'outgoing',
  ): Promise<void> {
    await api(target.baseUrl, `/api/v1/accounts/${target.accountId}/conversations/${target.conversationId}/messages`, {
      method: 'POST',
      body: {
        content,
        message_type: messageType,
        private: isPrivate,
        source_id: `${BOT_SOURCE_PREFIX}${randomUUID()}`,
        content_attributes: { clinicai_bot: true },
      },
    });
  }

  async function mirror(tenant: Tenant, phone: string, name: string | undefined, contents: string[], type: 'incoming' | 'outgoing') {
    let { target, conversationId } = await ensureConversation(tenant, phone, name);
    for (const content of contents) {
      try {
        await postBotMessage({ ...target, conversationId }, content, false, type);
      } catch (error) {
        // Conversation deleted in Chatwoot: forget the link and retry once with a new one.
        if (!(error instanceof ChatwootApiError) || error.status !== 404) throw error;
        await repos.chatwootLinks.remove(tenant.id, phone);
        ({ target, conversationId } = await ensureConversation(tenant, phone, name));
        await postBotMessage({ ...target, conversationId }, content, false, type);
      }
    }
  }

  function enqueue(tenant: Tenant, phone: string, task: () => Promise<void>): void {
    const key = `${tenant.id}:${phone}`;
    const run = (queues.get(key) ?? Promise.resolve())
      .then(task)
      .catch((error: unknown) => {
        logger.warn(
          { tenantId: tenant.id, phone: maskPhone(phone), err: error instanceof Error ? error.message : String(error) },
          'chatwoot mirror failed',
        );
      });
    queues.set(key, run);
    void run.finally(() => {
      if (queues.get(key) === run) queues.delete(key);
    });
    options.background?.run('chatwoot-mirror', () => run);
  }

  return {
    resolveTarget,
    async deleteContact(tenant, accountId, contactId) {
      const { baseUrl } = await resolveTarget(tenant);
      try {
        await api(baseUrl, `/api/v1/accounts/${accountId}/contacts/${contactId}`, { method: 'DELETE' });
        return 'deleted';
      } catch (error) {
        if (error instanceof ChatwootApiError && error.status === 404) return 'not_found';
        throw error;
      }
    },
    postBotMessage: (target, content, isPrivate) => postBotMessage(target, content, isPrivate),
    mirrorIncoming(tenant, message) {
      enqueue(tenant, message.phone, () =>
        mirror(tenant, message.phone, message.profileName, [describeIncoming(message)], 'incoming'),
      );
    },
    mirrorOutgoing(tenant, phone, messages) {
      if (messages.length === 0) return;
      enqueue(tenant, phone, () => mirror(tenant, phone, undefined, messages.map(renderOutgoingAsText), 'outgoing'));
    },
    async idle() {
      while (queues.size > 0) {
        await Promise.all([...queues.values()]);
      }
    },
  };
}

/** Engine observer that mirrors the conversation into Chatwoot (no-op when disabled). */
export function chatwootObserver(chatwoot: ChatwootService | null): EngineObserver {
  if (!chatwoot) return {};
  return {
    onIncoming: (tenant, message) => chatwoot.mirrorIncoming(tenant, message),
    onOutgoing: (tenant, phone, messages) => chatwoot.mirrorOutgoing(tenant, phone, messages),
  };
}
