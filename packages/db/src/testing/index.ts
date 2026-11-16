/**
 * Test helpers: a Prisma client bound to the per-project test database and data factories.
 * Each test creates its own tenants (random UUIDs), so tests never depend on each other.
 */
import './context';
import { randomUUID } from 'node:crypto';
import { PRIVACY_NOTICE_VERSION, type ScheduleSlot, type TenantSettings } from '@clinicai/shared';
import { createPrismaClient, type Db } from '../client';
import type { AppointmentSource, AppointmentStatus, Prisma } from '../generated/prisma/client';
import { createTenantScopedClient } from '../tenant-context';

export function createTestDb(databaseUrl: string): Db {
  return createPrismaClient(databaseUrl);
}

/** F19: tenant-scoped client over the restricted role, as the apps use it in production. */
export function createTestAppDb(appDatabaseUrl: string): Db {
  return createTenantScopedClient(createPrismaClient(appDatabaseUrl));
}

let phoneCounter = 0;
/** Unique valid Spanish mobile number per call. */
export function uniquePhone(): string {
  phoneCounter += 1;
  const n = (Date.now() % 1_000_000) * 100 + (phoneCounter % 100);
  return `+346${String(n).padStart(8, '0').slice(-8)}`;
}

export async function createTenant(
  db: Db,
  overrides: {
    clinicName?: string;
    timezone?: string;
    waPhoneNumberId?: string | null;
    settings?: Partial<TenantSettings>;
  } = {},
) {
  return db.tenantConfig.create({
    data: {
      clinicName: overrides.clinicName ?? 'Clínica Test',
      timezone: overrides.timezone ?? 'Europe/Madrid',
      waPhoneNumberId:
        overrides.waPhoneNumberId === undefined ? `pnid-${randomUUID()}` : overrides.waPhoneNumberId,
      settings: {
        contactPhone: '+34965000000',
        slotMinutes: 60,
        ...overrides.settings,
      } as Prisma.InputJsonValue,
    },
  });
}

export const FULL_WEEK_SCHEDULE: ScheduleSlot[] = (
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const
).map((day) => ({ day, start: '07:00', end: '21:00' }));

export async function createEmployee(
  db: Db,
  tenantId: string,
  overrides: { name?: string; role?: string; schedule?: ScheduleSlot[]; active?: boolean } = {},
) {
  return db.employee.create({
    data: {
      tenantId,
      name: overrides.name ?? 'Empleado Test',
      role: overrides.role ?? 'fisioterapeuta',
      schedule: (overrides.schedule ?? FULL_WEEK_SCHEDULE) as Prisma.InputJsonValue,
      active: overrides.active ?? true,
    },
  });
}

export async function createClient(
  db: Db,
  tenantId: string,
  overrides: { name?: string; phone?: string | null; email?: string | null; notes?: string | null; consent?: boolean } = {},
) {
  // By default the client already accepted the privacy notice (pass consent: false to test the gate).
  const consent = overrides.consent ?? true;
  return db.client.create({
    data: {
      tenantId,
      name: overrides.name ?? 'Cliente Test',
      phone: overrides.phone === undefined ? uniquePhone() : overrides.phone,
      email: overrides.email === undefined ? 'cliente@test.es' : overrides.email,
      notes: overrides.notes ?? null,
      ...(consent ? { consentAt: new Date(), consentChannel: 'whatsapp' as const, consentVersion: PRIVACY_NOTICE_VERSION } : {}),
    },
  });
}

export async function createAppointment(
  db: Db,
  input: {
    tenantId: string;
    clientId: string;
    employeeId: string;
    date: Date;
    durationMinutes?: number;
    status?: AppointmentStatus;
    source?: AppointmentSource;
    reminderSentAt?: Date | null;
    serviceId?: string | null;
  },
) {
  return db.appointment.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      employeeId: input.employeeId,
      date: input.date,
      durationMinutes: input.durationMinutes ?? 60,
      status: input.status ?? 'pending',
      source: input.source ?? 'web',
      reminderSentAt: input.reminderSentAt ?? null,
      serviceId: input.serviceId ?? null,
    },
  });
}

/**
 * Drops unfinished inbound events. Claiming is global, so tests that use the queue start from
 * an empty one (test files of a Vitest project run sequentially on the same database).
 */
export async function resetInboundQueue(db: Db): Promise<void> {
  await db.inboundEvent.deleteMany({ where: { status: { in: ['pending', 'processing'] } } });
}

/** A service of the tenant (F14). */
export function createService(db: Db, tenantId: string, overrides: { name?: string; durationMinutes?: number; active?: boolean } = {}) {
  return db.service.create({
    data: {
      tenantId,
      name: overrides.name ?? `Servicio ${randomUUID().slice(0, 8)}`,
      durationMinutes: overrides.durationMinutes ?? 60,
      active: overrides.active ?? true,
    },
  });
}

/** Time off (F14): absence of `employeeId`, or clinic closure when it is null. */
export function createTimeOff(
  db: Db,
  input: { tenantId: string; employeeId: string | null; startsAt: Date; endsAt: Date; reason?: string },
) {
  return db.timeOff.create({ data: { ...input, reason: input.reason ?? null } });
}
