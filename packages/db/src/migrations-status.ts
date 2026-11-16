/**
 * F20: compares the migrations shipped with the code (prisma/migrations) with the ones applied to a
 * database (`_prisma_migrations`, written by `prisma migrate deploy`). Read-only. Server-side only:
 * import it from `@clinicai/db/migrations`.
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Db } from './client';

/** Resolved on use (not on import), so merely importing the module never touches the file system. */
export function migrationsDir(): string {
  return path.resolve(import.meta.dirname, '../prisma/migrations');
}

export function listMigrationNames(dir = migrationsDir()): string[] {
  return readdirSync(dir)
    .filter((name) => statSync(path.join(dir, name)).isDirectory())
    .sort();
}

export interface MigrationStatus {
  /** `_prisma_migrations` does not exist: migrations were never applied with Prisma. */
  tableMissing: boolean;
  applied: string[];
  /** Started but not finished (a failed `migrate deploy` that must be resolved by hand). */
  failed: string[];
  /** In the code but not applied yet. */
  pending: string[];
}

export async function migrationStatus(db: Db, expected = listMigrationNames()): Promise<MigrationStatus> {
  let rows: { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[];
  try {
    rows = await db.$queryRaw`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`;
  } catch (error) {
    if (/_prisma_migrations/.test(error instanceof Error ? error.message : String(error))) {
      return { tableMissing: true, applied: [], failed: [], pending: expected };
    }
    throw error;
  }
  const applied = rows.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name);
  const failed = rows.filter((r) => !r.finished_at && !r.rolled_back_at).map((r) => r.migration_name);
  const done = new Set(applied);
  return { tableMissing: false, applied: applied.sort(), failed, pending: expected.filter((name) => !done.has(name)) };
}
