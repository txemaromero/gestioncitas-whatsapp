/**
 * Recreates the `clinicai_e2e` database, applies the Prisma migrations and creates the clinic
 * of the mocked user (kp_e2e_admin). F19: the panel runs on the restricted role `clinicai_app`
 * (row level security), with the same local password as `pnpm db:app-role`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { E2E_APP_ROLE_PASSWORD, E2E_SERVER_URL } from '../playwright.config';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../../packages/db/prisma/migrations');

export default async function globalSetup(): Promise<void> {
  const admin = new pg.Client({ connectionString: E2E_SERVER_URL });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS clinicai_e2e WITH (FORCE)');
  await admin.query('CREATE DATABASE clinicai_e2e');
  await admin.end();

  const db = new pg.Client({ connectionString: E2E_SERVER_URL.replace(/\/[^/]*$/, '/clinicai_e2e') });
  await db.connect();
  try {
    for (const dir of readdirSync(MIGRATIONS).filter((d) => statSync(path.join(MIGRATIONS, d)).isDirectory()).sort()) {
      await db.query(readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
    }
    const {
      rows: [tenant],
    } = await db.query<{ id: string }>(
      `INSERT INTO tenant_config (clinic_name, wa_phone_number_id, phone_normalized, settings)
       VALUES ('Clínica E2E', 'e2e-phone', '+34965000000', '{"contactPhone":"965 000 000","slotMinutes":60}') RETURNING id`,
    );
    await db.query(
      `INSERT INTO tenant_members (tenant_id, kinde_user_id, email, role) VALUES ($1, 'kp_e2e_admin', 'admin@e2e.test', 'owner')`,
      [tenant?.id],
    );
    await db.query(`ALTER ROLE clinicai_app WITH LOGIN PASSWORD '${E2E_APP_ROLE_PASSWORD}'`);
  } finally {
    await db.end();
  }
}
