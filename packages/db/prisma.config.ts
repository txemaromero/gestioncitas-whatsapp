import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer loads .env automatically: load packages/db/.env, then the repo root .env.
loadEnv({ path: path.resolve(import.meta.dirname, '.env'), quiet: true });
loadEnv({ path: path.resolve(import.meta.dirname, '../../.env'), quiet: true });

// Migrations need a direct (non-pooled) connection on Supabase. `generate` needs no URL at all,
// so the value is optional here and the CLI reports a clear error if a command requires it.
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  ...(url ? { datasource: { url } } : {}),
});
