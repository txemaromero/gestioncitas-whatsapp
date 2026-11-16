import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';
import { createTenantScopedClient } from './tenant-context';

export type Db = PrismaClient;

/**
 * Creates a Prisma client over node-postgres (Prisma 7 driver adapter).
 * On Supabase use the pooled URL (pgbouncer, port 6543) for the app and DIRECT_URL for migrations.
 */
export function createPrismaClient(connectionString?: string): PrismaClient {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL no está definida (docs/deploy.md)');
  }
  const adapter = new PrismaPg({ connectionString: url });
  return new PrismaClient({ adapter });
}

/**
 * Time zone of the database sessions. It must be UTC: the pg adapter sends and reads timestamps
 * without offset, so with any other zone the stored instants are shifted against `now()` in SQL
 * (queue leases, rate limit). Check it with `SHOW timezone` when deploying; the bot warns at startup.
 */
export async function databaseTimeZone(db: PrismaClient): Promise<string> {
  const [row] = await db.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
  return row?.tz ?? 'unknown';
}

export function isUtcTimeZone(name: string): boolean {
  return ['utc', 'etc/utc', 'etc/universal', 'universal', 'zulu', 'etc/zulu', 'gmt', 'etc/gmt'].includes(name.toLowerCase());
}

/**
 * F19: the two connections of an app.
 *  - `system`: the owner role (DATABASE_URL). Not subject to row level security; only for work that
 *    spans clinics (tenant lookup, inbound queue, cron jobs, onboarding, panel membership).
 *  - `app`: tenant-scoped client (see tenant-context.ts) over the `clinicai_app` role
 *    (DATABASE_APP_URL), where PostgreSQL itself only shows the current clinic's rows. Without
 *    DATABASE_APP_URL it uses the owner connection: the clinic context is still required, but the
 *    database does not enforce it (`enforced: false`).
 */
export interface DatabaseClients {
  system: PrismaClient;
  app: PrismaClient;
  enforced: boolean;
}

/**
 * F32: in production the clinics must also be isolated by PostgreSQL (DATABASE_APP_URL): without it
 * the apps refuse to start, unless ALLOW_OWNER_CONNECTION=true says it on purpose.
 */
export function assertAppDatabaseUrl(appUrl: string | null | undefined, env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV !== 'production' || appUrl || env.ALLOW_OWNER_CONNECTION === 'true') return;
  throw new Error(
    'DATABASE_APP_URL es obligatoria en producción: sin ella la base de datos no aísla las clínicas (docs/deploy.md). ' +
      'Si de verdad quieres usar solo la conexión de propietario, define ALLOW_OWNER_CONNECTION=true.',
  );
}

export function createDatabaseClients(systemUrl?: string, appUrl?: string | null): DatabaseClients {
  assertAppDatabaseUrl(appUrl);
  const system = createPrismaClient(systemUrl);
  const appBase = appUrl ? createPrismaClient(appUrl) : system;
  return { system, app: createTenantScopedClient(appBase), enforced: Boolean(appUrl) };
}

export async function disconnectDatabaseClients(clients: DatabaseClients): Promise<void> {
  await Promise.all([clients.system.$disconnect(), clients.app.$disconnect()]);
}

const globalForPrisma = globalThis as unknown as { __clinicaiDb?: DatabaseClients };

/** Process-wide singletons (survive Next.js dev hot reloads). */
export function getDatabase(): DatabaseClients {
  globalForPrisma.__clinicaiDb ??= createDatabaseClients(process.env.DATABASE_URL, process.env.DATABASE_APP_URL || null);
  return globalForPrisma.__clinicaiDb;
}
