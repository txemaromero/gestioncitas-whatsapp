import type { Db } from '../client';
import type { Prisma } from '../generated/prisma/client';

export const CONVERSATION_TTL_MINUTES = 30;

export interface StoredConversation {
  flow: string;
  step: string;
  data: Record<string, unknown>;
  errorCount: number;
  updatedAt: Date;
  expiresAt: Date;
}

/** Persisted conversation state (one active flow per tenant + phone). */
export function conversationRepo(db: Db) {
  return {
    /** Active (non-expired) state, or null. */
    async get(tenantId: string, phone: string, now: Date): Promise<StoredConversation | null> {
      const row = await db.conversationState.findUnique({
        where: { tenantId_phone: { tenantId, phone } },
      });
      if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
      const data =
        typeof row.data === 'object' && row.data !== null && !Array.isArray(row.data)
          ? (row.data as Record<string, unknown>)
          : {};
      return {
        flow: row.flow,
        step: row.step,
        data,
        errorCount: row.errorCount,
        updatedAt: row.updatedAt,
        expiresAt: row.expiresAt,
      };
    },

    async save(
      tenantId: string,
      phone: string,
      state: { flow: string; step: string; data: Record<string, unknown>; errorCount: number },
      now: Date,
      ttlMinutes = CONVERSATION_TTL_MINUTES,
    ): Promise<void> {
      const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);
      const data = state.data as Prisma.InputJsonValue;
      await db.conversationState.upsert({
        where: { tenantId_phone: { tenantId, phone } },
        create: { tenantId, phone, flow: state.flow, step: state.step, data, errorCount: state.errorCount, expiresAt },
        update: { flow: state.flow, step: state.step, data, errorCount: state.errorCount, expiresAt },
      });
    },

    async clear(tenantId: string, phone: string): Promise<void> {
      await db.conversationState.deleteMany({ where: { tenantId, phone } });
    },

    async purgeExpired(now: Date): Promise<number> {
      const { count } = await db.conversationState.deleteMany({ where: { expiresAt: { lt: now } } });
      return count;
    },
  };
}

/** Numbers with the bot paused (human handoff). */
export function blacklistRepo(db: Db) {
  return {
    async isBlocked(tenantId: string, phone: string): Promise<boolean> {
      const row = await db.botBlacklist.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
      return row !== null;
    },

    /** Returns false when it was already blocked. */
    async add(tenantId: string, phone: string, createdBy: string | null, reason?: string): Promise<boolean> {
      const result = await db.botBlacklist.createMany({
        data: [{ tenantId, phone, createdBy, reason: reason ?? null }],
        skipDuplicates: true,
      });
      return result.count > 0;
    },

    /** Returns false when it was not blocked. */
    async remove(tenantId: string, phone: string): Promise<boolean> {
      const { count } = await db.botBlacklist.deleteMany({ where: { tenantId, phone } });
      return count > 0;
    },
  };
}

/** Chatwoot contact/conversation per tenant + phone. */
export function chatwootLinksRepo(db: Db) {
  return {
    get(tenantId: string, phone: string) {
      return db.chatwootLink.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
    },

    upsert(link: {
      tenantId: string;
      phone: string;
      accountId: number;
      inboxId: number;
      contactId: number;
      conversationId: number;
    }) {
      const { tenantId, phone, ...rest } = link;
      return db.chatwootLink.upsert({
        where: { tenantId_phone: { tenantId, phone } },
        create: link,
        update: rest,
      });
    },

    /** Most recently used link for a Chatwoot conversation. */
    findByConversation(accountId: number, conversationId: number) {
      return db.chatwootLink.findFirst({ where: { accountId, conversationId }, orderBy: { updatedAt: 'desc' } });
    },

    async remove(tenantId: string, phone: string): Promise<void> {
      await db.chatwootLink.deleteMany({ where: { tenantId, phone } });
    },
  };
}
