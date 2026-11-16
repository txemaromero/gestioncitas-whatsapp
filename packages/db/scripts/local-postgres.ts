/**
 * Local PostgreSQL without Docker (embedded-postgres). Keeps running until Ctrl+C.
 *   pnpm db:local            → postgresql://postgres:postgres@localhost:5433/clinicai
 * Data persists in <repo>/.data/postgres. Alternative: `docker compose up -d`.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const port = Number(process.env.LOCAL_PG_PORT ?? 5433);
const database = process.env.LOCAL_PG_DB ?? 'clinicai';
const dataDir = path.resolve(import.meta.dirname, '../../../.data/postgres');

async function main(): Promise<void> {
  mkdirSync(path.dirname(dataDir), { recursive: true });
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: 'postgres',
    password: 'postgres',
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    // UTC sessions: Prisma's pg adapter sends and reads timestamps without offset, so with another
    // server time zone (the OS one by default) they would be shifted against now() in SQL.
    postgresFlags: ['-c', 'TimeZone=UTC'],
    onLog: () => undefined,
    onError: (error) => console.error(String(error)),
  });

  if (!existsSync(path.join(dataDir, 'PG_VERSION'))) {
    console.log(`Initialising PostgreSQL data directory at ${dataDir}…`);
    await pg.initialise();
  }
  await pg.start();
  try {
    await pg.createDatabase(database);
  } catch {
    // Already exists.
  }

  const url = `postgresql://postgres:postgres@localhost:${port}/${database}`;
  console.log('\nPostgreSQL local listo ✅');
  console.log(`  DATABASE_URL=${url}`);
  console.log(`  DIRECT_URL=${url}`);
  console.log('\nSiguiente: pnpm db:migrate && pnpm db:seed   (Ctrl+C para parar)\n');

  const shutdown = async (): Promise<void> => {
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  setInterval(() => undefined, 1 << 30);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
