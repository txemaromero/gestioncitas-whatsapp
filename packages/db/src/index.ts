import type { Db } from './client';
import { appointmentsRepo } from './repos/appointments';
import { blacklistRepo, chatwootLinksRepo, conversationRepo } from './repos/bot-state';
import { clientsRepo } from './repos/clients';
import { employeesRepo } from './repos/employees';
import { inboundEventsRepo } from './repos/inbound-events';
import { servicesRepo } from './repos/services';
import { timeOffRepo } from './repos/time-off';
import { membersRepo } from './repos/members';
import { tenantsRepo } from './repos/tenants';

export {
  assertAppDatabaseUrl,
  createDatabaseClients,
  createPrismaClient,
  databaseTimeZone,
  disconnectDatabaseClients,
  getDatabase,
  isUtcTimeZone,
  type DatabaseClients,
  type Db,
} from './client';
export { MissingTenantContextError, createTenantScopedClient, currentTenantId, runWithTenant } from './tenant-context';
export {
  Prisma,
  PrismaClient,
  AppointmentStatus,
  AppointmentSource,
  Attendance,
  ConsentChannel,
  MemberRole,
  type TenantInvitation,
  WaitlistStatus,
  type Appointment,
  type Client,
  type ClientPack,
  type Employee,
  type Service,
  type TimeOff,
  type TenantConfig,
  type TenantMember,
} from './generated/prisma/client';

export * from './repos/tenants';
export * from './repos/members';
export * from './repos/clients';
export * from './repos/employees';
export * from './repos/appointments';
export * from './repos/bot-state';
export * from './repos/inbound-events';
export * from './repos/services';
export * from './repos/time-off';
export * from './services/availability';
export * from './services/booking';
export * from './services/reminders';
export * from './services/privacy';
export * from './services/attendance';
export * from './services/waitlist';
export * from './services/team';
export * from './services/clients-import';
export * from './services/activity';
export * from './services/series';
export * from './services/packs';
export * from './services/booking-page';
export * from './services/calendar-feeds';
export * from './services/usage';
export * from './services/locks';
// Migration status (F20) is a separate entry point, `@clinicai/db/migrations`: it reads the file
// system, which the web bundle cannot do.

/** All repositories bound to one Prisma client. Every method takes `tenantId` first. */
export function createRepos(db: Db) {
  return {
    tenants: tenantsRepo(db),
    members: membersRepo(db),
    clients: clientsRepo(db),
    employees: employeesRepo(db),
    appointments: appointmentsRepo(db),
    conversations: conversationRepo(db),
    blacklist: blacklistRepo(db),
    inboundEvents: inboundEventsRepo(db),
    services: servicesRepo(db),
    timeOff: timeOffRepo(db),
    chatwootLinks: chatwootLinksRepo(db),
  };
}

export type Repos = ReturnType<typeof createRepos>;

/** Prisma "record not found" error code (update/delete by a tenant-scoped unique key). */
export function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2025'
  );
}

/** Prisma foreign-key violation (e.g. an id of another tenant in a composite FK). */
export function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2003'
  );
}

/** Prisma unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2002'
  );
}
