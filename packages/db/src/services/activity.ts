/**
 * F24: activity log. Writes are best effort for the caller (an action is never undone because its
 * entry could not be stored), reads are for the owner and administrators in the panel.
 */
import { ACTIVITY_CATEGORIES, type ActivityActorValue, type ActivityCategory } from '@clinicai/shared';
import type { Db } from '../client';
import type { Prisma } from '../generated/prisma/client';

/** Entries are kept 2 years (accountability), then purged by the bot's maintenance. */
export const ACTIVITY_RETENTION_MONTHS = 24;

export interface ActivityEntry {
  actorType: ActivityActorValue;
  actorMemberId?: string | null;
  /** Email of the panel user, or "WhatsApp" / "Sistema". */
  actorLabel: string;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  clientId?: string | null;
  details?: Record<string, unknown>;
}

export async function logActivity(db: Db, tenantId: string, entry: ActivityEntry): Promise<void> {
  await db.activityLog.create({
    data: {
      tenantId,
      actorType: entry.actorType,
      actorMemberId: entry.actorMemberId ?? null,
      actorLabel: entry.actorLabel,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      clientId: entry.clientId ?? null,
      details: (entry.details ?? {}) as Prisma.InputJsonValue,
    },
  });
}

/** Newest first, `limit` entries before the entry `before` (cursor), optionally by category. */
export async function listActivity(
  db: Db,
  tenantId: string,
  options: { limit: number; before?: string | null; category?: ActivityCategory | null; clientId?: string | null },
) {
  const prefixes = options.category ? ACTIVITY_CATEGORIES[options.category].prefixes : null;
  const rows = await db.activityLog.findMany({
    where: {
      tenantId,
      ...(options.before ? { id: { lt: BigInt(options.before) } } : {}),
      ...(options.clientId ? { clientId: options.clientId } : {}),
      ...(prefixes ? { OR: prefixes.map((prefix) => ({ action: { startsWith: prefix } })) } : {}),
    },
    orderBy: { id: 'desc' },
    take: options.limit,
  });
  return rows.map(({ id, ...row }) => ({ ...row, id: id.toString() }));
}
export type ActivityItem = Awaited<ReturnType<typeof listActivity>>[number];

/** Deletes entries older than `before` (owner connection; the application role cannot delete). */
export async function purgeActivity(db: Db, before: Date): Promise<number> {
  const { count } = await db.activityLog.deleteMany({ where: { createdAt: { lt: before } } });
  return count;
}
