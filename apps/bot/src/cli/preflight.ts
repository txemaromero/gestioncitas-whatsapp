/**
 * F20: `pnpm preflight [--web-env apps/web/.env.local] [--bot-url https://…] [--web-url https://…]`
 * Checks the deployment configuration without writing anything or sending any message. Uses the
 * bot's environment (apps/bot/.env, or the service variables with `railway run`). Exit code 1 if
 * any check fails.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { createPrismaClient } from '@clinicai/db';
import { loadConfig } from '../config';
import { createSilentLogger } from '../logger';
import { formatPreflight, runPreflight, type WebEnv } from '../preflight/checks';

const out = (line: string) => process.stdout.write(`${line}
`);

const DEFAULT_WEB_ENV = path.resolve(import.meta.dirname, '../../../web/.env.local');

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { 'web-env': { type: 'string' }, 'bot-url': { type: 'string' }, 'web-url': { type: 'string' } },
  });
  const config = loadConfig();
  // pnpm runs the script inside apps/bot: relative paths are taken from where it was launched.
  const webEnvPath = values['web-env'] ? path.resolve(process.env.INIT_CWD ?? process.cwd(), values['web-env']) : DEFAULT_WEB_ENV;
  const web: WebEnv | null = existsSync(webEnvPath) ? (parseEnv(readFileSync(webEnvPath, 'utf8')) as WebEnv) : null;

  const systemDb = createPrismaClient(config.DATABASE_URL);
  const appRoleDb = config.DATABASE_APP_URL ? createPrismaClient(config.DATABASE_APP_URL) : null;
  try {
    out('ClinicAI · comprobación previa al despliegue (no escribe nada ni envía mensajes)');
    if (web) out(`Variables del panel: ${webEnvPath}`);
    const results = await runPreflight({
      config,
      logger: createSilentLogger(),
      systemDb,
      appRoleDb,
      web,
      botUrl: values['bot-url'] ?? null,
      webUrl: values['web-url'] ?? null,
    });
    out(formatPreflight(results));
    process.exitCode = results.some((r) => r.status === 'fail') ? 1 : 0;
  } finally {
    await Promise.all([systemDb.$disconnect(), appRoleDb?.$disconnect()]);
  }
}

main().catch((error: unknown) => {
  // Invalid configuration (zod) or an unexpected error.
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
