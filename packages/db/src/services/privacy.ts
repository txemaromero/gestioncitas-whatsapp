/**
 * Data protection (F12, GDPR), tenant-scoped:
 *  - eraseClient: right to erasure (art. 17). Deletes the client, their appointments and every
 *    trace of the WhatsApp conversation (state, pause, queued messages, Chatwoot link) in one
 *    transaction, and queues the deletion of the Chatwoot contact (done by the bot).
 *  - anonymizeClient / anonymizeInactiveClients: storage limitation (art. 5.1.e). Removes the
 *    personal data but keeps the appointments (without notes) for the clinic's statistics.
 *  - exportClientData: right of access / portability (arts. 15 and 20), as JSON.
 *  F17: waiting list entries are erased with the client, deleted when anonymising and exported.
 *  F24: activity log entries about the client lose their link (`client_id`) on erasure and
 *  anonymisation, and are part of the export.
 */
import {
  ANONYMIZED_CLIENT_NAME,
  parseTenantSettings,
  toZonedIso,
} from '@clinicai/shared';
import type { Db } from '../client';
import type { Prisma } from '../generated/prisma/client';

export class ClientNotFoundError extends Error {
  constructor() {
    super('Client not found');
    this.name = 'ClientNotFoundError';
  }
}

/** Internal queue job executed by the bot (it holds the Chatwoot credentials). */
export const CHATWOOT_DELETE_CONTACT_JOB = 'chatwoot.deleteContact';

export interface ChatwootDeleteContactJob {
  type: typeof CHATWOOT_DELETE_CONTACT_JOB;
  accountId: number;
  contactId: number;
}

export interface ErasureSummary {
  appointments: number;
  conversationState: number;
  botPause: number;
  inboundEvents: number;
  /** Waiting list entries removed (F17). */
  waitlist: number;
  /** Packs removed (F26): erasure only; anonymisation keeps them (no personal data). */
  packs: number;
  /** A job to delete the Chatwoot contact (and its conversations) was queued. */
  chatwootContactQueued: boolean;
}

type Tx = Prisma.TransactionClient;

/** Removes everything the bot keeps about tenant + phone and queues the Chatwoot clean-up. */
async function removeConversationData(tx: Tx, tenantId: string, phone: string) {
  const link = await tx.chatwootLink.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
  const conversationState = (await tx.conversationState.deleteMany({ where: { tenantId, phone } })).count;
  const botPause = (await tx.botBlacklist.deleteMany({ where: { tenantId, phone } })).count;
  const inboundEvents = (await tx.inboundEvent.deleteMany({ where: { tenantId, phone } })).count;
  await tx.chatwootLink.deleteMany({ where: { tenantId, phone } });
  if (link) {
    const job: ChatwootDeleteContactJob = { type: CHATWOOT_DELETE_CONTACT_JOB, accountId: link.accountId, contactId: link.contactId };
    await tx.inboundEvent.createMany({
      data: [
        {
          source: 'internal',
          externalId: `${CHATWOOT_DELETE_CONTACT_JOB}:${link.accountId}:${link.contactId}`,
          tenantId,
          // No phone: the job must not keep the erased data. All internal jobs of a tenant share
          // this conversation key, which only serialises them.
          phone: '',
          payload: { ...job },
        },
      ],
      skipDuplicates: true,
    });
  }
  return { conversationState, botPause, inboundEvents, chatwootContactQueued: link !== null };
}

/** Right to erasure: the client and all their data disappear from the database. */
export async function eraseClient(db: Db, tenantId: string, clientId: string): Promise<ErasureSummary> {
  return db.$transaction(async (tx) => {
    const client = await tx.client.findFirst({ where: { tenantId, id: clientId } });
    if (!client) throw new ClientNotFoundError();
    const appointments = await tx.appointment.count({ where: { tenantId, clientId } });
    const conversation = client.phone
      ? await removeConversationData(tx, tenantId, client.phone)
      : { conversationState: 0, botPause: 0, inboundEvents: 0, chatwootContactQueued: false };
    const { count: waitlist } = await tx.waitlistEntry.deleteMany({ where: { tenantId, clientId } });
    await tx.activityLog.updateMany({ where: { tenantId, clientId }, data: { clientId: null } });
    const packs = await tx.clientPack.count({ where: { tenantId, clientId } });
    // Appointments and packs go with the client (ON DELETE CASCADE).
    await tx.client.delete({ where: { tenantId_id: { tenantId, id: clientId } } });
    return { appointments, waitlist, packs, ...conversation };
  });
}

/** Removes the personal data of a client but keeps their appointments (without notes). */
export async function anonymizeClient(db: Db, tenantId: string, clientId: string, now = new Date()): Promise<ErasureSummary> {
  return db.$transaction(async (tx) => {
    const client = await tx.client.findFirst({ where: { tenantId, id: clientId } });
    if (!client) throw new ClientNotFoundError();
    const conversation = client.phone
      ? await removeConversationData(tx, tenantId, client.phone)
      : { conversationState: 0, botPause: 0, inboundEvents: 0, chatwootContactQueued: false };
    const { count: appointments } = await tx.appointment.updateMany({ where: { tenantId, clientId }, data: { notes: null } });
    // Without a phone they could never be notified: the waiting list entries go (F17).
    const { count: waitlist } = await tx.waitlistEntry.deleteMany({ where: { tenantId, clientId } });
    await tx.activityLog.updateMany({ where: { tenantId, clientId }, data: { clientId: null } });
    await tx.client.update({
      where: { tenantId_id: { tenantId, id: clientId } },
      data: {
        name: ANONYMIZED_CLIENT_NAME,
        phone: null,
        email: null,
        notes: null,
        consentAt: null,
        consentChannel: null,
        consentVersion: null,
        anonymizedAt: now,
      },
    });
    return { appointments, waitlist, packs: 0, ...conversation };
  });
}

/**
 * Retention policy: for every tenant with `settings.retentionMonths`, anonymises the clients
 * created before the cutoff with no appointment on or after it (future ones included).
 * Idempotent (already anonymised clients are skipped); at most `batch` clients per tenant per run.
 */
export async function anonymizeInactiveClients(
  db: Db,
  now = new Date(),
  batch = 200,
): Promise<{ tenants: number; clients: number }> {
  const tenants = await db.tenantConfig.findMany({ select: { id: true, settings: true } });
  let tenantCount = 0;
  let clientCount = 0;
  for (const tenant of tenants) {
    const months = parseTenantSettings(tenant.settings).retentionMonths;
    if (!months) continue;
    tenantCount += 1;
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
    const candidates = await db.client.findMany({
      where: {
        tenantId: tenant.id,
        anonymizedAt: null,
        createdAt: { lt: cutoff },
        appointments: { none: { date: { gte: cutoff } } },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: batch,
    });
    for (const { id } of candidates) {
      await anonymizeClient(db, tenant.id, id, now);
      await db.activityLog.create({
        data: { tenantId: tenant.id, actorType: 'system', actorLabel: 'Sistema', action: 'system.client_anonymized', entityType: 'client', entityId: id, details: { retentionMonths: months } },
      });
      clientCount += 1;
    }
  }
  return { tenants: tenantCount, clients: clientCount };
}

/** Right of access / portability: everything stored about a client, as plain JSON. */
export async function exportClientData(db: Db, tenantId: string, clientId: string, now = new Date()) {
  const tenant = await db.tenantConfig.findUnique({ where: { id: tenantId }, select: { clinicName: true, timezone: true } });
  const client = await db.client.findFirst({
    where: { tenantId, id: clientId },
    include: {
      appointments: {
        orderBy: { date: 'asc' },
        include: { employee: { select: { name: true } }, service: { select: { name: true } } },
      },
      waitlist: { orderBy: { createdAt: 'asc' }, include: { service: { select: { name: true } } } },
      packs: {
        orderBy: { createdAt: 'asc' },
        include: { service: { select: { name: true } }, appointments: { orderBy: { date: 'asc' }, select: { id: true } } },
      },
    },
  });
  if (!tenant || !client) throw new ClientNotFoundError();
  const tz = tenant.timezone;
  const activity = await db.activityLog.findMany({ where: { tenantId, clientId }, orderBy: { id: 'asc' } });
  const [conversation, pause, link] = client.phone
    ? await Promise.all([
        db.conversationState.findUnique({ where: { tenantId_phone: { tenantId, phone: client.phone } } }),
        db.botBlacklist.findUnique({ where: { tenantId_phone: { tenantId, phone: client.phone } } }),
        db.chatwootLink.findUnique({ where: { tenantId_phone: { tenantId, phone: client.phone } } }),
      ])
    : [null, null, null];

  return {
    format: 'clinicai.client-export.v1',
    exportedAt: now.toISOString(),
    controller: { clinic: tenant.clinicName },
    client: {
      id: client.id,
      name: client.name,
      phone: client.phone,
      email: client.email,
      notes: client.notes,
      createdAt: client.createdAt.toISOString(),
      updatedAt: client.updatedAt.toISOString(),
      anonymizedAt: client.anonymizedAt?.toISOString() ?? null,
      privacyNotice: client.consentAt
        ? { acceptedAt: client.consentAt.toISOString(), channel: client.consentChannel, version: client.consentVersion }
        : null,
    },
    appointments: client.appointments.map((a) => ({
      id: a.id,
      start: toZonedIso(a.date, tz),
      timeZone: tz,
      durationMinutes: a.durationMinutes,
      status: a.status,
      attendance: a.attendance,
      professional: a.employee.name,
      service: a.service?.name ?? null,
      bookedVia: a.source,
      /** F26: treatment (series of appointments) and pack whose session it spent. */
      treatment: a.seriesId,
      pack: a.packId,
      notes: a.notes,
      reminderSentAt: a.reminderSentAt?.toISOString() ?? null,
      secondReminderSentAt: a.secondReminderSentAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
    })),
    waitlist: client.waitlist.map((w) => ({
      id: w.id,
      from: toZonedIso(w.windowStart, tz),
      to: toZonedIso(w.windowEnd, tz),
      timeZone: tz,
      wholeDay: w.wholeDay,
      durationMinutes: w.durationMinutes,
      service: w.service?.name ?? null,
      status: w.status,
      lastOffer: w.offerStart ? toZonedIso(w.offerStart, tz) : null,
      createdAt: w.createdAt.toISOString(),
      closedAt: w.closedAt?.toISOString() ?? null,
    })),
    packs: client.packs.map((p) => ({
      id: p.id,
      name: p.name,
      service: p.service?.name ?? null,
      totalSessions: p.totalSessions,
      usedSessions: p.appointments.length,
      spentBy: p.appointments.map((a) => a.id),
      expiresOn: p.expiresOn ? p.expiresOn.toISOString().slice(0, 10) : null,
      createdAt: p.createdAt.toISOString(),
    })),
    activity: activity.map((a) => ({
      at: a.createdAt.toISOString(),
      action: a.action,
      by: a.actorType === 'member' ? 'clinic staff' : a.actorType,
    })),
    whatsappBot: {
      paused: pause !== null,
      pausedAt: pause?.createdAt.toISOString() ?? null,
      activeConversation:
        conversation && conversation.expiresAt > now
          ? { flow: conversation.flow, step: conversation.step, lastActivity: conversation.updatedAt.toISOString() }
          : null,
      chatwoot: link ? { conversationId: link.conversationId, contactId: link.contactId } : null,
    },
  };
}

export type ClientExport = Awaited<ReturnType<typeof exportClientData>>;
