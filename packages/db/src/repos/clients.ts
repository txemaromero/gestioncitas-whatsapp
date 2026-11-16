import type { Db } from '../client';
import type { ConsentChannel } from '../generated/prisma/client';

/** Acceptance of the privacy notice (F12). */
export interface ClientConsent {
  at: Date;
  channel: ConsentChannel;
  version: string;
}

export interface ClientInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  /** undefined keeps the current value, null withdraws it. */
  consent?: ClientConsent | null;
}

/** Consent columns for a create/update; undefined → no change. */
function consentData(consent: ClientConsent | null | undefined) {
  if (consent === undefined) return {};
  return {
    consentAt: consent?.at ?? null,
    consentChannel: consent?.channel ?? null,
    consentVersion: consent?.version ?? null,
  };
}

/** Every method takes `tenantId` first: queries are always scoped to one tenant. */
export function clientsRepo(db: Db) {
  return {
    findById(tenantId: string, id: string) {
      return db.client.findFirst({ where: { tenantId, id } });
    },

    findByPhone(tenantId: string, phone: string) {
      return db.client.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
    },

    list(tenantId: string, search?: string) {
      const q = search?.trim();
      return db.client.findMany({
        where: {
          tenantId,
          ...(q
            ? {
                OR: [
                  { name: { contains: q, mode: 'insensitive' } },
                  { email: { contains: q, mode: 'insensitive' } },
                  { phone: { contains: q.replace(/\s/g, '') } },
                ],
              }
            : {}),
        },
        orderBy: { name: 'asc' },
      });
    },

    create(tenantId: string, data: ClientInput) {
      return db.client.create({
        data: {
          tenantId,
          name: data.name,
          phone: data.phone ?? null,
          email: data.email ?? null,
          notes: data.notes ?? null,
          ...consentData(data.consent),
        },
      });
    },

    update(tenantId: string, id: string, data: Partial<ClientInput>) {
      const { consent, ...rest } = data;
      return db.client.update({ where: { tenantId_id: { tenantId, id } }, data: { ...rest, ...consentData(consent) } });
    },

    /** Records the acceptance of the privacy notice. */
    recordConsent(tenantId: string, id: string, consent: ClientConsent) {
      return db.client.update({ where: { tenantId_id: { tenantId, id } }, data: consentData(consent) });
    },

    getWithAppointments(tenantId: string, id: string) {
      return db.client.findFirst({
        where: { tenantId, id },
        include: {
          appointments: {
            orderBy: { date: 'desc' },
            include: { employee: { select: { id: true, name: true } } },
          },
        },
      });
    },

    countFutureAppointments(tenantId: string, id: string, now: Date) {
      return db.appointment.count({
        where: { tenantId, clientId: id, date: { gte: now }, status: { not: 'cancelled' } },
      });
    },
  };
}

export type ClientsRepo = ReturnType<typeof clientsRepo>;
