/**
 * F31: usage counters per clinic and UTC day (`usage_daily`) and the platform overview.
 * Platform data: written and read only with the system connection (the application role has no
 * grant on the table). Only numbers and ids: no client data.
 */
import { addUsage, emptyUsageTotals, parseTenantSettings, type UsageEntry, type UsageTotals } from '@clinicai/shared';
import type { Db } from '../client';
import { Prisma } from '../generated/prisma/client';

/** Adds the entries to today's counters (UTC day) of a clinic; concurrent calls add up. */
export async function recordUsage(systemDb: Db, tenantId: string, entries: UsageEntry[], now: Date = new Date()): Promise<void> {
  const merged = new Map<string, { metric: string; model: string; amount: number }>();
  for (const e of entries) {
    const amount = Math.round(e.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const model = e.model ?? '';
    const key = `${e.metric}\u0000${model}`;
    const row = merged.get(key);
    if (row) row.amount += amount;
    else merged.set(key, { metric: e.metric, model, amount });
  }
  if (merged.size === 0) return;
  const day = now.toISOString().slice(0, 10);
  const values = [...merged.values()].map(
    (r) => Prisma.sql`(${tenantId}::uuid, ${day}::date, ${r.metric}, ${r.model}, ${BigInt(r.amount)})`,
  );
  await systemDb.$executeRaw`
    INSERT INTO usage_daily (tenant_id, day, metric, model, amount)
    VALUES ${Prisma.join(values)}
    ON CONFLICT (tenant_id, day, metric, model) DO UPDATE SET amount = usage_daily.amount + EXCLUDED.amount`;
}

/** Deletes the counters of days before `before` (UTC). */
export async function purgeUsage(systemDb: Db, before: Date): Promise<number> {
  const { count } = await systemDb.usageDaily.deleteMany({ where: { day: { lt: utcDay(before) } } });
  return count;
}

const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export interface PlatformClinic {
  id: string;
  clinicName: string;
  createdAt: Date;
  /** Email of the owner (the account that created the clinic). */
  ownerEmail: string | null;
  members: number;
  clients: number;
  /** Own number with its own token, own number with the platform token, or none. */
  whatsapp: 'own' | 'number' | 'none';
  bookingPage: boolean;
  /** Appointments booked in the period, by where they were booked. */
  appointments: { whatsapp: number; web: number };
  usage: UsageTotals;
  /** Last UTC day with a message received (any period). */
  lastInboundDay: Date | null;
  /** Inbound events that failed for good in the last 24 hours. */
  failedEvents24h: number;
}

/**
 * Figures of every clinic for the platform console: `from`–`to` (UTC, end excluded) bounds the
 * usage and the appointments booked. Read-only, no personal data of clients.
 */
export async function platformOverview(
  systemDb: Db,
  period: { from: Date; to: Date },
  now: Date = new Date(),
): Promise<PlatformClinic[]> {
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [tenants, members, owners, clients, appointments, failed, usage, lastInbound] = await Promise.all([
    systemDb.tenantConfig.findMany({
      select: {
        id: true,
        clinicName: true,
        createdAt: true,
        waPhoneNumberId: true,
        waAccessTokenEnc: true,
        publicSlug: true,
        phoneNormalized: true,
        settings: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    systemDb.tenantMember.groupBy({ by: ['tenantId'], _count: { _all: true } }),
    systemDb.tenantMember.findMany({
      where: { role: 'owner' },
      select: { tenantId: true, email: true },
      orderBy: { createdAt: 'asc' },
    }),
    systemDb.client.groupBy({ by: ['tenantId'], _count: { _all: true } }),
    systemDb.appointment.groupBy({
      by: ['tenantId', 'source'],
      where: { createdAt: { gte: period.from, lt: period.to } },
      _count: { _all: true },
    }),
    systemDb.inboundEvent.groupBy({
      by: ['tenantId'],
      where: { status: 'failed', finishedAt: { gte: since24h } },
      _count: { _all: true },
    }),
    systemDb.usageDaily.groupBy({
      by: ['tenantId', 'metric', 'model'],
      where: { day: { gte: utcDay(period.from), lt: utcDay(period.to) } },
      _sum: { amount: true },
    }),
    systemDb.usageDaily.groupBy({ by: ['tenantId'], where: { metric: 'whatsapp.inbound' }, _max: { day: true } }),
  ]);

  const count = (rows: { tenantId: string; _count: { _all: number } }[]) => new Map(rows.map((r) => [r.tenantId, r._count._all]));
  const memberCount = count(members);
  const clientCount = count(clients);
  const failedCount = count(failed);
  const owner = new Map<string, string | null>();
  for (const o of owners) if (!owner.has(o.tenantId)) owner.set(o.tenantId, o.email);
  const lastDay = new Map(lastInbound.map((r) => [r.tenantId, r._max.day]));

  return tenants.map((t) => {
    const totals = emptyUsageTotals();
    for (const u of usage) {
      if (u.tenantId === t.id) addUsage(totals, { metric: u.metric, model: u.model, amount: Number(u._sum.amount ?? 0n) });
    }
    const booked = (source: 'whatsapp' | 'web') =>
      appointments.find((a) => a.tenantId === t.id && a.source === source)?._count._all ?? 0;
    return {
      id: t.id,
      clinicName: t.clinicName,
      createdAt: t.createdAt,
      ownerEmail: owner.get(t.id) ?? null,
      members: memberCount.get(t.id) ?? 0,
      clients: clientCount.get(t.id) ?? 0,
      whatsapp: t.waPhoneNumberId ? (t.waAccessTokenEnc ? 'own' : 'number') : 'none',
      bookingPage: Boolean(t.publicSlug && t.phoneNormalized && parseTenantSettings(t.settings).bookingPageEnabled),
      appointments: { whatsapp: booked('whatsapp'), web: booked('web') },
      usage: totals,
      lastInboundDay: lastDay.get(t.id) ?? null,
      failedEvents24h: failedCount.get(t.id) ?? 0,
    };
  });
}
