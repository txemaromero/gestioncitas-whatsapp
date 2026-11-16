/**
 * F19, local development only: lets the restricted application role `clinicai_app` log in on the
 * local database (created by the migrations without a password) and prints DATABASE_APP_URL.
 * Refuses any host other than localhost: in Supabase, set a strong password by hand (docs/deploy.md).
 *   pnpm db:migrate && pnpm db:app-role
 */
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';

loadEnv({ path: path.resolve(import.meta.dirname, '../.env'), quiet: true });
loadEnv({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

const LOCAL_PASSWORD = 'clinicai_app_local';

async function main(): Promise<void> {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL (o DIRECT_URL) no está definida');
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)) {
    throw new Error(`Solo para la base de datos local (host: ${parsed.hostname}). En producción, sigue docs/deploy.md.`);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rowCount } = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'clinicai_app'`);
    if (!rowCount) throw new Error('El rol clinicai_app no existe: ejecuta antes pnpm db:migrate');
    await client.query(`ALTER ROLE clinicai_app WITH LOGIN PASSWORD '${LOCAL_PASSWORD}'`);
  } finally {
    await client.end();
  }
  parsed.username = 'clinicai_app';
  parsed.password = LOCAL_PASSWORD;
  console.log('Rol clinicai_app activado. Añade a apps/bot/.env y apps/web/.env.local:\n');
  console.log(`DATABASE_APP_URL=${parsed.toString()}\n`);
}

main().catch((error: unknown) => {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
