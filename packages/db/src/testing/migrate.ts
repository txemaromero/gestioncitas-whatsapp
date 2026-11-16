import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../prisma/migrations');

/** Applies every `prisma/migrations/<name>/migration.sql` in order (test databases only). */
export async function applyMigrations(databaseUrl: string): Promise<void> {
  const dirs = readdirSync(MIGRATIONS_DIR)
    .filter((name) => statSync(path.join(MIGRATIONS_DIR, name)).isDirectory())
    .sort();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const dir of dirs) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8');
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}
