/**
 * F20 — migrations in the code vs. applied in a database (used by `pnpm preflight`).
 */
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Db } from './client';
import { listMigrationNames, migrationStatus } from './migrations-status';
import { createTestDb } from './testing';

let db: Db;
beforeAll(() => {
  db = createTestDb(inject('databaseUrl'));
});
afterAll(async () => {
  await db.$executeRaw`DROP TABLE IF EXISTS _prisma_migrations`;
  await db.$disconnect();
});

describe('migrationStatus', () => {
  it('lists the migrations of the code in order', () => {
    const names = listMigrationNames();
    expect(names).toEqual([...names].sort());
    expect(names).toContain('20261112180000_tenant_isolation');
  });

  it('tells applied, failed and pending migrations apart', async () => {
    const expected = ['001_a', '002_b', '003_c', '004_d'];
    // Test databases are created without Prisma: no migrations table at all.
    expect(await migrationStatus(db, expected)).toEqual({ tableMissing: true, applied: [], failed: [], pending: expected });

    await db.$executeRaw`CREATE TABLE _prisma_migrations (migration_name text NOT NULL, finished_at timestamptz, rolled_back_at timestamptz)`;
    await db.$executeRaw`INSERT INTO _prisma_migrations VALUES
      ('001_a', now(), NULL), ('002_b', now(), NULL), ('003_c', NULL, NULL), ('003_c', NULL, now())`;
    expect(await migrationStatus(db, expected)).toEqual({
      tableMissing: false,
      applied: ['001_a', '002_b'],
      failed: ['003_c'],
      pending: ['003_c', '004_d'],
    });
  });
});
