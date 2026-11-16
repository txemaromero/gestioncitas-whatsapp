import { DEFAULT_TIMEZONE, parseTenantSettings, type TenantSettings } from '@clinicai/shared';
import type { Db } from '../client';
import type { Prisma, TenantConfig } from '../generated/prisma/client';

/** Tenant with validated settings (what the rest of the code works with). */
export interface Tenant {
  id: string;
  clinicName: string;
  phoneNormalized: string | null;
  waPhoneNumberId: string | null;
  waAccessTokenEnc: string | null;
  timezone: string;
  /** F27: address of the public booking page (`/reservar/<slug>`). */
  publicSlug: string | null;
  settings: TenantSettings;
  createdAt: Date;
  updatedAt: Date;
}

export function toTenant(row: TenantConfig): Tenant {
  return {
    id: row.id,
    clinicName: row.clinicName,
    phoneNormalized: row.phoneNormalized,
    waPhoneNumberId: row.waPhoneNumberId,
    waAccessTokenEnc: row.waAccessTokenEnc,
    timezone: row.timezone || DEFAULT_TIMEZONE,
    publicSlug: row.publicSlug,
    settings: parseTenantSettings(row.settings),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface TenantUpdate {
  clinicName?: string;
  phoneNormalized?: string | null;
  waPhoneNumberId?: string | null;
  waAccessTokenEnc?: string | null;
  timezone?: string;
  publicSlug?: string | null;
  settings?: Partial<TenantSettings>;
}

export function tenantsRepo(db: Db) {
  return {
    async findById(tenantId: string): Promise<Tenant | null> {
      const row = await db.tenantConfig.findUnique({ where: { id: tenantId } });
      return row ? toTenant(row) : null;
    },

    /** Resolves the tenant of an incoming WhatsApp webhook by Meta's phone_number_id. */
    async findByWaPhoneNumberId(phoneNumberId: string): Promise<Tenant | null> {
      const row = await db.tenantConfig.findUnique({ where: { waPhoneNumberId: phoneNumberId } });
      return row ? toTenant(row) : null;
    },

    /** F27: the clinic of a public booking page (enabled or not: the caller checks). */
    async findByPublicSlug(slug: string): Promise<Tenant | null> {
      const row = await db.tenantConfig.findUnique({ where: { publicSlug: slug } });
      return row ? toTenant(row) : null;
    },

    async listAll(): Promise<Tenant[]> {
      const rows = await db.tenantConfig.findMany({ orderBy: { createdAt: 'asc' } });
      return rows.map(toTenant);
    },

    /** Updates the tenant. `settings` is merged over the current (validated) settings. */
    async update(tenantId: string, data: TenantUpdate): Promise<Tenant> {
      const current = await db.tenantConfig.findUniqueOrThrow({ where: { id: tenantId } });
      const mergedSettings = data.settings
        ? parseTenantSettings({ ...parseTenantSettings(current.settings), ...data.settings })
        : undefined;
      const row = await db.tenantConfig.update({
        where: { id: tenantId },
        data: {
          clinicName: data.clinicName,
          phoneNormalized: data.phoneNormalized,
          waPhoneNumberId: data.waPhoneNumberId,
          waAccessTokenEnc: data.waAccessTokenEnc,
          timezone: data.timezone,
          publicSlug: data.publicSlug,
          settings: mergedSettings as Prisma.InputJsonValue | undefined,
        },
      });
      return toTenant(row);
    },

    /** Onboarding: creates the tenant and its first `owner` member atomically. */
    async createWithOwner(input: {
      clinicName: string;
      contactPhone: string;
      kindeUserId: string;
      email: string | null;
      timezone?: string;
    }): Promise<Tenant> {
      const row = await db.$transaction(async (tx) => {
        const tenant = await tx.tenantConfig.create({
          data: {
            clinicName: input.clinicName,
            timezone: input.timezone ?? DEFAULT_TIMEZONE,
            settings: parseTenantSettings({ contactPhone: input.contactPhone }) as Prisma.InputJsonValue,
          },
        });
        await tx.tenantMember.create({
          data: {
            tenantId: tenant.id,
            kindeUserId: input.kindeUserId,
            email: input.email,
            role: 'owner',
          },
        });
        return tenant;
      });
      return toTenant(row);
    },
  };
}

export type TenantsRepo = ReturnType<typeof tenantsRepo>;
