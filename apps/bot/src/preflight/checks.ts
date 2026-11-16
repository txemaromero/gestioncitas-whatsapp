/**
 * F20: pre-deployment check. Reads the configuration and asks every service whether it is ready,
 * WITHOUT writing anything nor sending any message: database (UTC, migrations, the restricted role
 * of F19), clinics, Meta (number, templates, webhook subscription), OpenAI (models and their shutdown
 * date), Kinde, Chatwoot, and optionally the deployed bot and panel (F25: with their security headers).
 *
 * External calls follow the official docs (checked on 2026-11-12):
 *  - Meta Graph API: GET /{phone-number-id}?fields=…status (must be CONNECTED);
 *    GET /{waba-id}/message_templates?fields=name,language,status,components (no name filter:
 *    filtered here; F30: the body must have the variables the bot sends);
 *    GET /{waba-id}/subscribed_apps. Errors are told apart by `error.code` (190 = token).
 *  - OpenAI: GET /v1/models/{model} (`shutdown_date` when announced; 401 = key).
 *  - Kinde: <domain>/.well-known/openid-configuration.
 */
import { randomUUID } from 'node:crypto';
import { createRepos, databaseTimeZone, isUtcTimeZone, type Db, type Tenant } from '@clinicai/db';
import { migrationStatus } from '@clinicai/db/migrations';
import { parsePlatformAdminEmails, parseTenantSettings, resolveUsagePrices } from '@clinicai/shared';
import { isTestEncryptionKey } from '@clinicai/shared/crypto';
import type { AppConfig } from '../config';
import type { Logger } from '../logger';
import { createChatwootService } from '../services/chatwoot';
import { resolveWaAccount } from '../services/whatsapp';
import { BackgroundTasks } from '../utils/background';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  area: string;
  check: string;
  status: CheckStatus;
  detail: string;
}

/** Variables of the panel (apps/web/.env.local or the Netlify ones), when available. */
export interface WebEnv {
  KINDE_ISSUER_URL?: string;
  KINDE_SITE_URL?: string;
  KINDE_POST_LOGIN_REDIRECT_URL?: string;
  KINDE_POST_LOGOUT_REDIRECT_URL?: string;
  ENCRYPTION_KEY?: string;
  DATABASE_URL?: string;
  DATABASE_APP_URL?: string;
  PLATFORM_ADMIN_EMAILS?: string;
  PLATFORM_PRICES?: string;
  WHATSAPP_MODE?: string;
  ALLOW_OWNER_CONNECTION?: string;
}

export interface PreflightInput {
  config: AppConfig;
  logger: Logger;
  /** Owner connection (DATABASE_URL). */
  systemDb: Db;
  /** The restricted role (DATABASE_APP_URL) WITHOUT the tenant wrapper, or null when not configured. */
  appRoleDb: Db | null;
  fetchFn?: typeof fetch;
  now?: Date;
  web?: WebEnv | null;
  botUrl?: string | null;
  webUrl?: string | null;
}

/** Shutdown dates closer than this are reported as a warning. */
const SHUTDOWN_WARNING_DAYS = 120;
const TEMPLATE_PAGES = 10;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isLocal = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url);
const trimSlash = (url: string) => url.replace(/\/+$/, '');

type Graph = { ok: true; data: unknown } | { ok: false; status: number; code: number | undefined; message: string };

/** What a Graph API error means for whoever deploys. */
export function explainGraphError(error: Extract<Graph, { ok: false }>): string {
  if (error.code === 190) return 'el token de acceso no es válido o ha caducado (código 190)';
  if (error.code !== undefined && ([3, 10, 131005].includes(error.code) || (error.code >= 200 && error.code <= 299))) {
    return `el token no tiene permiso sobre ese recurso (código ${error.code})`;
  }
  if (error.code === 803 || error.code === 100) return `el identificador no existe o no es de esta cuenta (código ${error.code})`;
  return `${error.message} (HTTP ${error.status}${error.code !== undefined ? `, código ${error.code}` : ''})`;
}

export async function runPreflight(input: PreflightInput): Promise<CheckResult[]> {
  const { config } = input;
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  const now = input.now ?? new Date();
  const results: CheckResult[] = [];
  const add = (area: string, check: string, status: CheckStatus, detail: string) => results.push({ area, check, status, detail });

  const get = async (url: string, headers: Record<string, string> = {}) =>
    fetchFn(url, { headers, signal: AbortSignal.timeout(15_000) });

  async function graph(token: string, pathAndQuery: string): Promise<Graph> {
    const url = pathAndQuery.startsWith('https://')
      ? pathAndQuery
      : `https://graph.facebook.com/${config.META_GRAPH_VERSION}/${pathAndQuery}`;
    try {
      const response = await get(url, { authorization: `Bearer ${token}` });
      const body = (await response.json().catch(() => null)) as { error?: { code?: number; message?: string } } | null;
      if (response.ok) return { ok: true, data: body };
      return { ok: false, status: response.status, code: body?.error?.code, message: body?.error?.message ?? 'error' };
    } catch (error) {
      return { ok: false, status: 0, code: undefined, message: `no se pudo conectar: ${errorText(error)}` };
    }
  }

  // ─── Configuration ──────────────────────────────────────────────────────────────────────
  add('Configuración', 'Variables del bot', 'ok', 'Válidas (zod)');
  if (config.WHATSAPP_MODE === 'mock') add('Configuración', 'WhatsApp', 'warn', 'WHATSAPP_MODE=mock: el bot no envía ni recibe mensajes reales');
  if (config.LLM_MODE === 'mock') add('Configuración', 'IA', 'warn', 'LLM_MODE=mock: respuestas por reglas, sin IA real');
  if (!config.CRON_SECRET) add('Configuración', 'CRON_SECRET', 'warn', 'Vacío: POST /jobs/*/run rechazará todas las peticiones');

  // ─── Database ───────────────────────────────────────────────────────────────────────────
  let tenants: Tenant[] = [];
  let databaseUp = false;
  try {
    await input.systemDb.$queryRaw`SELECT 1`;
    databaseUp = true;
    add('Base de datos', 'Conexión (DATABASE_URL)', 'ok', 'Conecta');
  } catch (error) {
    add('Base de datos', 'Conexión (DATABASE_URL)', 'fail', `No conecta: ${errorText(error)}`);
  }
  if (databaseUp) {
    const timeZone = await databaseTimeZone(input.systemDb);
    add(
      'Base de datos',
      'Zona horaria',
      isUtcTimeZone(timeZone) ? 'ok' : 'fail',
      isUtcTimeZone(timeZone) ? timeZone : `${timeZone}: tiene que ser UTC (ALTER DATABASE … SET timezone TO 'UTC')`,
    );

    const migrations = await migrationStatus(input.systemDb);
    if (migrations.tableMissing) {
      add('Base de datos', 'Migraciones', 'fail', 'No hay registro de migraciones: ejecuta `pnpm db:migrate` (prisma migrate deploy)');
    } else if (migrations.failed.length) {
      add('Base de datos', 'Migraciones', 'fail', `Migraciones a medias, hay que resolverlas a mano: ${migrations.failed.join(', ')}`);
    } else if (migrations.pending.length) {
      add('Base de datos', 'Migraciones', 'fail', `Faltan ${migrations.pending.length}: ${migrations.pending.join(', ')}`);
    } else {
      add('Base de datos', 'Migraciones', 'ok', `Al día (${migrations.applied.length})`);
    }

    if (!input.appRoleDb) {
      add('Base de datos', 'Aislamiento por clínica (DATABASE_APP_URL)', 'warn', 'Sin configurar: solo el código separa las clínicas (docs/deploy.md, paso 1.4)');
    } else {
      try {
        const [role] = await input.appRoleDb.$queryRaw<{ name: string; bypass: boolean }[]>`
          SELECT current_user AS name, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`;
        const [visible] = await input.appRoleDb.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM tenant_config`;
        const restricted = role?.name === 'clinicai_app' && !role.bypass && visible?.n === 0;
        add(
          'Base de datos',
          'Aislamiento por clínica (DATABASE_APP_URL)',
          restricted ? 'ok' : 'fail',
          restricted
            ? 'Rol clinicai_app con RLS: sin clínica no ve ninguna fila'
            : `El usuario ${role?.name ?? '?'} no es el rol restringido (o ve clínicas sin contexto)`,
        );
      } catch (error) {
        add('Base de datos', 'Aislamiento por clínica (DATABASE_APP_URL)', 'fail', `No conecta con el rol clinicai_app: ${errorText(error)}`);
      }
    }
    tenants = await createRepos(input.systemDb).tenants.listAll();
    add('Base de datos', 'Clínicas', tenants.length ? 'ok' : 'warn', tenants.length ? `${tenants.length}` : 'Ninguna todavía (se crean al entrar en el panel)');
  }

  // ─── WhatsApp (Meta) ────────────────────────────────────────────────────────────────────
  if (config.WHATSAPP_MODE === 'live') {
    for (const tenant of tenants) {
      const label = `Número de ${tenant.clinicName}`;
      let account: ReturnType<typeof resolveWaAccount>;
      try {
        account = resolveWaAccount(tenant, config);
      } catch {
        add('WhatsApp', label, 'fail', 'No se puede descifrar su token: ENCRYPTION_KEY no es la misma que la del panel');
        continue;
      }
      if (!account) {
        add('WhatsApp', label, 'warn', 'Sin número o sin token: esta clínica no recibirá mensajes');
        continue;
      }
      const phone = await graph(
        account.accessToken,
        `${encodeURIComponent(account.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,status`,
      );
      if (!phone.ok) {
        add('WhatsApp', label, 'fail', explainGraphError(phone));
        continue;
      }
      const info = phone.data as { display_phone_number?: string; verified_name?: string; quality_rating?: string; status?: string };
      const name = `${info.display_phone_number ?? account.phoneNumberId} (${info.verified_name ?? 'sin nombre'})`;
      if (info.status && info.status !== 'CONNECTED') {
        add('WhatsApp', label, 'fail', `${name}: estado ${info.status}; tiene que estar CONNECTED para enviar y recibir`);
      } else if (info.quality_rating === 'RED' || info.quality_rating === 'YELLOW') {
        add('WhatsApp', label, 'warn', `${name}: calidad ${info.quality_rating}`);
      } else {
        add('WhatsApp', label, 'ok', `${name}${info.quality_rating ? `, calidad ${info.quality_rating}` : ''}`);
      }
    }

    const token = config.META_JWT_TOKEN;
    if (!config.META_WABA_ID || !token) {
      add('WhatsApp', 'Plantillas y webhook', 'skip', 'Sin META_WABA_ID (y META_JWT_TOKEN): compruébalos en WhatsApp Manager');
    } else {
      const waba = encodeURIComponent(config.META_WABA_ID);
      type TemplateRow = { name: string; language: string; status: string; components?: { type: string; text?: string }[] };
      const templates: TemplateRow[] = [];
      let next: string | null = `${waba}/message_templates?fields=name,language,status,components&limit=100`;
      let failure: Extract<Graph, { ok: false }> | null = null;
      for (let page = 0; next && page < TEMPLATE_PAGES; page++) {
        const response: Graph = await graph(token, next);
        if (!response.ok) {
          failure = response;
          break;
        }
        const data = response.data as { data?: TemplateRow[]; paging?: { next?: string } };
        templates.push(...(data.data ?? []));
        next = data.paging?.next ?? null;
      }
      const waitlistNeeded = tenants.some((t) => t.settings.waitlistEnabled);
      // Variables of the body the bot fills (F30: the reminder carries the date since then).
      const wanted: { name: string; required: boolean; variables: number }[] = [
        { name: config.WA_REMINDER_TEMPLATE, required: true, variables: 4 },
        { name: config.WA_WAITLIST_TEMPLATE, required: waitlistNeeded, variables: 4 },
      ];
      const bodyVariables = (t: TemplateRow) => {
        const body = t.components?.find((c) => c.type === 'BODY')?.text;
        return body === undefined ? null : new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
      };
      for (const { name, required, variables } of wanted) {
        const check = `Plantilla ${name}`;
        if (failure) {
          add('WhatsApp', check, 'fail', explainGraphError(failure));
          continue;
        }
        const template = templates.find((t) => t.name === name && t.language === config.WA_TEMPLATE_LANGUAGE);
        const missingStatus: CheckStatus = required ? 'fail' : 'warn';
        if (!template) {
          const other = templates.filter((t) => t.name === name).map((t) => t.language);
          add('WhatsApp', check, missingStatus, `No existe en el idioma ${config.WA_TEMPLATE_LANGUAGE}${other.length ? ` (sí en: ${other.join(', ')})` : ''}`);
        } else if (template.status === 'APPROVED' && bodyVariables(template) !== null && bodyVariables(template) !== variables) {
          add('WhatsApp', check, missingStatus,
            `Aprobada, pero el texto tiene ${bodyVariables(template)} variables y el bot envía ${variables}: edítala con el texto de docs/meta-template.md`);
        } else if (template.status === 'APPROVED') {
          add('WhatsApp', check, 'ok', 'Aprobada');
        } else if (template.status === 'PENDING' || template.status === 'IN_APPEAL') {
          add('WhatsApp', check, 'warn', `En revisión (${template.status})`);
        } else {
          add('WhatsApp', check, missingStatus, `Estado ${template.status}: no se puede enviar`);
        }
        if (!required && template?.status !== 'APPROVED') {
          results[results.length - 1]!.detail += '. Solo hace falta si se activa la lista de espera';
        }
      }

      const apps = await graph(token, `${waba}/subscribed_apps`);
      if (!apps.ok) {
        add('WhatsApp', 'Webhook suscrito', 'fail', explainGraphError(apps));
      } else {
        const list = ((apps.data as { data?: { whatsapp_business_api_data?: { id?: string; name?: string } }[] }).data ?? [])
          .map((a) => a.whatsapp_business_api_data)
          .filter((a): a is { id?: string; name?: string } => Boolean(a));
        if (list.length === 0) {
          add('WhatsApp', 'Webhook suscrito', 'fail', 'Ninguna app suscrita a la cuenta: no llegará ningún mensaje');
        } else if (config.META_APP_ID && !list.some((a) => a.id === config.META_APP_ID)) {
          add('WhatsApp', 'Webhook suscrito', 'fail', `La app ${config.META_APP_ID} no está suscrita (sí: ${list.map((a) => a.name ?? a.id).join(', ')})`);
        } else {
          add('WhatsApp', 'Webhook suscrito', 'ok', list.map((a) => a.name ?? a.id).join(', '));
        }
      }
    }
  }

  // ─── AI (OpenAI) ────────────────────────────────────────────────────────────────────────
  if (config.LLM_MODE === 'live') {
    const models: { model: string; use: string; certain: boolean }[] = [];
    if (config.AI_PROVIDER === 'openai') models.push({ model: config.OPENAI_MODEL, use: 'principal', certain: true });
    if (config.ENABLE_FALLBACK && config.FALLBACK_PROVIDER === 'openai' && config.OPENAI_FALLBACK_MODEL) {
      models.push({ model: config.OPENAI_FALLBACK_MODEL, use: 'respaldo', certain: true });
    }
    // The docs do not say whether transcription models are listed by this endpoint.
    if (config.VOICE_NOTES) models.push({ model: config.OPENAI_TRANSCRIBE_MODEL, use: 'notas de voz', certain: false });
    if (config.AI_PROVIDER === 'deepseek' || config.FALLBACK_PROVIDER === 'deepseek') {
      add('IA', 'DeepSeek', 'skip', 'No se comprueba (su API no se ha verificado en la documentación oficial)');
    }
    if (models.length && !config.OPENAI_API_KEY) {
      add('IA', 'OpenAI', 'fail', 'Falta OPENAI_API_KEY');
    } else {
      for (const { model, use, certain } of models) {
        const check = `Modelo ${model} (${use})`;
        try {
          const response = await get(`${trimSlash(config.OPENAI_BASE_URL)}/models/${encodeURIComponent(model)}`, {
            authorization: `Bearer ${config.OPENAI_API_KEY}`,
          });
          if (response.status === 401) {
            add('IA', check, 'fail', 'OPENAI_API_KEY no es válida (HTTP 401)');
            continue;
          }
          if (!response.ok) {
            add('IA', check, certain ? 'fail' : 'warn', `No disponible para esta clave (HTTP ${response.status})${certain ? '' : '; no se ha podido confirmar'}`);
            continue;
          }
          const body = (await response.json().catch(() => ({}))) as { shutdown_date?: string | null };
          const shutdown = body.shutdown_date ? new Date(body.shutdown_date) : null;
          const days = shutdown ? Math.floor((shutdown.getTime() - now.getTime()) / 86_400_000) : null;
          if (shutdown && days !== null && days < 0) {
            add('IA', check, 'fail', `Apagado desde el ${body.shutdown_date}: cambia de modelo`);
          } else if (shutdown && days !== null && days <= SHUTDOWN_WARNING_DAYS) {
            add('IA', check, 'warn', `Se apaga el ${body.shutdown_date} (en ${days} días): cambia de modelo y repite eval/`);
          } else {
            add('IA', check, 'ok', shutdown ? `Disponible (apagado anunciado: ${body.shutdown_date})` : 'Disponible');
          }
        } catch (error) {
          add('IA', check, 'fail', `No se pudo conectar: ${errorText(error)}`);
        }
      }
    }
  }

  // ─── Chatwoot ───────────────────────────────────────────────────────────────────────────
  if (config.chatwootEnabled) {
    const chatwoot = createChatwootService({
      config,
      logger: input.logger,
      repos: createRepos(input.systemDb),
      background: new BackgroundTasks(input.logger),
      fetchFn,
    });
    try {
      const target = await chatwoot.resolveTarget({ settings: parseTenantSettings({}) } as Tenant);
      add('Chatwoot', `Bandeja ${config.CHATWOOT_INBOX_NAME}`, 'ok', `Encontrada (id ${target.inboxId})`);
    } catch (error) {
      add('Chatwoot', `Bandeja ${config.CHATWOOT_INBOX_NAME}`, 'fail', errorText(error));
    }
    if (!config.CHATWOOT_WEBHOOK_SECRET) add('Chatwoot', 'CHATWOOT_WEBHOOK_SECRET', 'fail', 'Vacío: el webhook de Chatwoot rechazará todo');
  }

  // ─── Panel (variables of the web) ───────────────────────────────────────────────────────
  const web = input.web;
  if (!web) {
    add('Panel', 'Variables del panel', 'skip', 'No se han leído (usa --web-env apps/web/.env.local)');
  } else {
    if (!web.ENCRYPTION_KEY || !config.ENCRYPTION_KEY) {
      add('Panel', 'ENCRYPTION_KEY', 'warn', 'Falta en el bot o en el panel: los tokens de WhatsApp de cada clínica no se podrán usar');
    } else if (isTestEncryptionKey(config.ENCRYPTION_KEY) || isTestEncryptionKey(web.ENCRYPTION_KEY)) {
      // F34: e.g. the all-zero key of the tests: the tokens would be as good as unencrypted.
      add('Panel', 'ENCRYPTION_KEY', 'fail', 'Es una clave de pruebas (todos los bytes iguales): genera una nueva (README) antes de guardar tokens');
    } else {
      add('Panel', 'ENCRYPTION_KEY', web.ENCRYPTION_KEY === config.ENCRYPTION_KEY ? 'ok' : 'fail',
        web.ENCRYPTION_KEY === config.ENCRYPTION_KEY ? 'La misma en el bot y en el panel' : 'Distinta en el bot y en el panel: el bot no podrá descifrar los tokens');
    }
    if (web.DATABASE_URL && web.DATABASE_URL !== config.DATABASE_URL) {
      add('Panel', 'DATABASE_URL', 'warn', 'Distinta de la del bot: ¿es la misma base de datos?');
    }
    if (Boolean(web.DATABASE_APP_URL) !== Boolean(config.DATABASE_APP_URL)) {
      add('Panel', 'DATABASE_APP_URL', 'warn', `Configurada solo en ${config.DATABASE_APP_URL ? 'el bot' : 'el panel'}`);
    }
    const site = web.KINDE_SITE_URL ? trimSlash(web.KINDE_SITE_URL) : null;
    if (!site) {
      add('Panel', 'KINDE_SITE_URL', 'fail', 'Falta');
    } else {
      add('Panel', 'KINDE_SITE_URL', site.startsWith('https://') || isLocal(site) ? 'ok' : 'warn', site);
      for (const [name, value] of [
        ['KINDE_POST_LOGIN_REDIRECT_URL', web.KINDE_POST_LOGIN_REDIRECT_URL],
        ['KINDE_POST_LOGOUT_REDIRECT_URL', web.KINDE_POST_LOGOUT_REDIRECT_URL],
      ] as const) {
        if (!value || !value.startsWith(site)) add('Panel', name, 'warn', `${value ?? 'Falta'}: debería empezar por ${site}`);
      }
    }
    if (!web.KINDE_ISSUER_URL) {
      add('Panel', 'Kinde', 'fail', 'Falta KINDE_ISSUER_URL');
    } else {
      try {
        const response = await get(`${trimSlash(web.KINDE_ISSUER_URL)}/.well-known/openid-configuration`);
        add('Panel', 'Kinde', response.ok ? 'ok' : 'fail',
          response.ok ? `${trimSlash(web.KINDE_ISSUER_URL)} responde` : `${web.KINDE_ISSUER_URL}: HTTP ${response.status} (¿dominio de Kinde correcto?)`);
      } catch (error) {
        add('Panel', 'Kinde', 'fail', `No se pudo conectar con ${web.KINDE_ISSUER_URL}: ${errorText(error)}`);
      }
    }
    // F32: the panel checks new WhatsApp numbers with Meta unless it runs in mock mode.
    if (web.WHATSAPP_MODE === 'mock' && config.WHATSAPP_MODE === 'live') {
      add('Panel', 'Comprobación de números de WhatsApp', 'warn', 'WHATSAPP_MODE=mock en el panel: no comprobará con Meta los números que guarden las clínicas');
    }
    if (web.ALLOW_OWNER_CONNECTION === 'true') {
      add('Panel', 'ALLOW_OWNER_CONNECTION', 'warn', 'Activo: el panel puede funcionar sin DATABASE_APP_URL (sin aislamiento de la base de datos)');
    }
    // F31: who can open the platform console, and the prices of its cost estimate.
    const admins = parsePlatformAdminEmails(web.PLATFORM_ADMIN_EMAILS).size;
    const prices = resolveUsagePrices(web.PLATFORM_PRICES);
    if (prices.error) add('Panel', 'Consola de la plataforma', 'fail', `${prices.error}: se usarán los precios por defecto`);
    else if (admins === 0) add('Panel', 'Consola de la plataforma', 'warn', 'Sin PLATFORM_ADMIN_EMAILS: nadie puede abrir /plataforma');
    else add('Panel', 'Consola de la plataforma', 'ok', `${admins} ${admins === 1 ? 'administrador' : 'administradores'}${web.PLATFORM_PRICES ? ', con precios propios' : ''}`);
  }

  // ─── Deployed services ──────────────────────────────────────────────────────────────────
  if (input.botUrl) {
    const bot = trimSlash(input.botUrl);
    if (!bot.startsWith('https://') && !isLocal(bot)) add('Despliegue', 'URL del bot', 'warn', 'Meta exige https para el webhook');
    try {
      // F34: the queue figures are only given with the cron secret.
      const response = await get(`${bot}/health`, config.CRON_SECRET ? { 'x-cron-secret': config.CRON_SECRET } : {});
      const body = (await response.json().catch(() => ({}))) as { status?: string; queue?: { failedLast24h?: number; pending?: number } };
      // F25: security headers (HSTS only with NODE_ENV=production, as the Docker image sets).
      if (response.headers.get('x-content-type-options') !== 'nosniff') {
        add('Despliegue', 'Bot: cabeceras de seguridad', 'warn', 'No las envía: ¿se ha desplegado la última versión?');
      } else if (bot.startsWith('https://') && !response.headers.get('strict-transport-security')) {
        add('Despliegue', 'Bot: cabeceras de seguridad', 'warn', 'Sin HSTS: ¿NODE_ENV=production?');
      } else {
        add('Despliegue', 'Bot: cabeceras de seguridad', 'ok', bot.startsWith('https://') ? 'Con HSTS' : 'Enviadas');
      }
      if (!response.ok || body.status !== 'ok') {
        add('Despliegue', 'Bot /health', 'fail', `HTTP ${response.status}${body.status ? ` (${body.status})` : ''}`);
      } else if ((body.queue?.failedLast24h ?? 0) > 0) {
        add('Despliegue', 'Bot /health', 'warn', `Responde, pero hay ${body.queue?.failedLast24h} mensajes fallidos en 24 h (tabla inbound_events)`);
      } else {
        add('Despliegue', 'Bot /health', 'ok', `Responde; ${body.queue?.pending ?? 0} mensajes en cola`);
      }
      if (config.VERIFY_TOKEN) {
        const challenge = `preflight-${randomUUID()}`;
        const query = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': config.VERIFY_TOKEN, 'hub.challenge': challenge });
        const verify = await get(`${bot}/webhook?${query.toString()}`);
        const echoed = verify.ok && (await verify.text()) === challenge;
        add('Despliegue', 'Verificación del webhook', echoed ? 'ok' : 'fail',
          echoed ? 'El VERIFY_TOKEN coincide con el del bot desplegado' : `El bot desplegado no acepta este VERIFY_TOKEN (HTTP ${verify.status})`);
      }
    } catch (error) {
      add('Despliegue', 'Bot', 'fail', `No se pudo conectar con ${bot}: ${errorText(error)}`);
    }
  }
  if (input.webUrl) {
    const site = trimSlash(input.webUrl);
    try {
      const response = await get(`${site}/api/health`);
      add('Despliegue', 'Panel /api/health', response.ok ? 'ok' : 'fail', response.ok ? 'Responde' : `HTTP ${response.status}`);
      // F25: the landing page carries the Content Security Policy with its nonce.
      const page = await get(`${site}/`);
      const csp = page.headers.get('content-security-policy') ?? '';
      const hsts = page.headers.get('strict-transport-security');
      if (/'nonce-[^']+'/.test(csp) && csp.includes("'strict-dynamic'")) {
        if (site.startsWith('https://') && !hsts) add('Despliegue', 'Panel: cabeceras de seguridad', 'warn', 'Política de seguridad (CSP) activa, pero sin HSTS');
        else add('Despliegue', 'Panel: cabeceras de seguridad', 'ok', `Política de seguridad (CSP) con nonce${hsts ? ' y HSTS' : ''}`);
      } else if (page.headers.get('content-security-policy-report-only')) {
        add('Despliegue', 'Panel: cabeceras de seguridad', 'warn', 'La política de seguridad solo informa (CSP_REPORT_ONLY=true): quítalo cuando esté corregido');
      } else {
        add('Despliegue', 'Panel: cabeceras de seguridad', 'fail', `Sin política de seguridad (CSP) en ${site}/ (HTTP ${page.status}): ¿se ha desplegado la última versión?`);
      }
    } catch (error) {
      add('Despliegue', 'Panel', 'fail', `No se pudo conectar con ${site}: ${errorText(error)}`);
    }
  }

  return results;
}

const ICONS: Record<CheckStatus, string> = { ok: '✅', warn: '⚠️ ', fail: '❌', skip: '⏭️ ' };

/** Plain-text report, grouped by area, with a summary line. */
export function formatPreflight(results: CheckResult[]): string {
  const lines: string[] = [];
  let area = '';
  for (const r of results) {
    if (r.area !== area) {
      area = r.area;
      lines.push('', area);
    }
    lines.push(`  ${ICONS[r.status]} ${r.check}: ${r.detail}`);
  }
  const count = (s: CheckStatus) => results.filter((r) => r.status === s).length;
  lines.push('', `Resultado: ${count('ok')} correctas · ${count('warn')} avisos · ${count('fail')} errores · ${count('skip')} sin comprobar`);
  return lines.join('\n');
}
