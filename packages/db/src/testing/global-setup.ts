/**
 * Vitest globalSetup for projects that need PostgreSQL.
 * - Uses TEST_DATABASE_URL (any database on the target server, e.g. a CI service container),
 *   or starts an ephemeral embedded PostgreSQL on a free port.
 * - Creates a fresh database per Vitest project and applies every Prisma migration SQL.
 * - Exposes the URL through `inject('databaseUrl')`, and the same database as the restricted
 *   application role `clinicai_app` (F19, row level security) through `inject('appDatabaseUrl')`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import './context';
import { applyMigrations } from './migrate';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Test password for the application role (roles are cluster-wide; projects run in parallel). */
const APP_ROLE_PASSWORD = 'clinicai_app_test';

async function enableAppRole(databaseUrl: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`ALTER ROLE clinicai_app WITH LOGIN PASSWORD '${APP_ROLE_PASSWORD}'`);
      break;
    } catch (error) {
      // "tuple concurrently updated" when two projects alter the role at once.
      if (attempt >= 5) throw error;
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    } finally {
      await client.end();
    }
  }
  const url = new URL(databaseUrl);
  url.username = 'clinicai_app';
  url.password = APP_ROLE_PASSWORD;
  return url.toString();
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let serverUrl = process.env.TEST_DATABASE_URL;
  let embedded: EmbeddedPostgres | undefined;
  let tempDir: string | undefined;

  if (!serverUrl) {
    const port = await freePort();
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'clinicai-pg-'));
    embedded = new EmbeddedPostgres({
      databaseDir: path.join(tempDir, 'data'),
      port,
      user: 'postgres',
      password: 'postgres',
      persistent: false,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      // UTC sessions: Prisma's pg adapter sends and reads timestamps without offset, so with another
      // server time zone (the OS one by default) they would be shifted against now() in SQL.
      postgresFlags: ['-c', 'TimeZone=UTC'],
      onLog: () => undefined,
      onError: () => undefined,
    });
    await embedded.initialise();
    await embedded.start();
    serverUrl = `postgresql://postgres:postgres@localhost:${port}/postgres`;
  }

  const dbName = `clinicai_test_${project.name.replace(/\W/g, '_')}`;
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const databaseUrl = withDatabase(serverUrl, dbName);
  await applyMigrations(databaseUrl);
  project.provide('databaseUrl', databaseUrl);
  project.provide('appDatabaseUrl', await enableAppRole(databaseUrl));

  return async () => {
    if (embedded) {
      await embedded.stop();
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
}
