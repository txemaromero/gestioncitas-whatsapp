/**
 * F20 — pre-deployment check against simulated Meta, OpenAI, Kinde and deployed services, and the
 * real test database (owner connection and the restricted role of F19).
 */
import { randomUUID } from 'node:crypto';
import { createPrismaClient, type Db } from '@clinicai/db';
import { createTenant } from '@clinicai/db/testing';
import { encryptSecret } from '@clinicai/shared/crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { getTestDb, testConfig } from '../../test/helpers';
import { createSilentLogger } from '../logger';
import { explainGraphError, formatPreflight, runPreflight, type CheckResult, type PreflightInput } from './checks';

// Not uniform: a key with every byte equal is a test key that preflight refuses (F34).
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 7)).toString('base64');
const OTHER_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => 200 - i)).toString('base64');
const NOW = new Date('2026-11-12T10:00:00Z');

let restricted: Db;
beforeAll(() => {
  restricted = createPrismaClient(inject('appDatabaseUrl'));
});
afterAll(async () => {
  await restricted.$disconnect();
});

type Route = [RegExp, (url: URL, init?: RequestInit) => Response];

/** A fetch that answers from the routes and records the requests (all must be GET). */
function fakeFetch(routes: Route[]) {
  const requests: { url: string; method: string; auth: string | null }[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    requests.push({ url: url.toString(), method: init?.method ?? 'GET', auth: headers.get('authorization') });
    const route = routes.find(([pattern]) => pattern.test(url.toString()));
    if (!route) return Response.json({ error: { message: 'not found', code: 803 } }, { status: 404 });
    return route[1](url, init);
  };
  return { fetchFn: fetchFn as typeof fetch, requests };
}

const graphError = (status: number, code: number, message = 'error') => Response.json({ error: { message, type: 'OAuthException', code } }, { status });

async function scenario(overrides: Partial<PreflightInput> = {}, env: Record<string, string> = {}) {
  const phoneNumberId = `pn-${randomUUID()}`;
  const clinicName = `Preflight ${randomUUID().slice(0, 6)}`;
  await createTenant(getTestDb(), {
    clinicName,
    waPhoneNumberId: phoneNumberId,
    settings: { waitlistEnabled: true },
  });
  const config = testConfig({
    WHATSAPP_MODE: 'live',
    LLM_MODE: 'live',
    OPENAI_API_KEY: 'sk-test',
    META_JWT_TOKEN: 'meta-token',
    META_WABA_ID: 'waba-1',
    META_APP_ID: 'app-1',
    ENCRYPTION_KEY: KEY,
    DATABASE_APP_URL: inject('appDatabaseUrl'),
    ...env,
  });
  const fake = fakeFetch([
    [new RegExp(`/v27\\.0/${phoneNumberId}\\?`), () => Response.json({ display_phone_number: '+34 965 000 000', verified_name: 'Clínica', quality_rating: 'GREEN', status: 'CONNECTED' })],
    [/\/waba-1\/message_templates\?.*after=page2/, () => Response.json({ data: [{ name: 'aviso_hueco_libre', language: 'es', status: 'PENDING' }] })],
    [
      /\/waba-1\/message_templates\?/,
      () =>
        Response.json({
          data: [
            { name: 'recordatorio_cita', language: 'es', status: 'APPROVED' },
            { name: 'aviso_hueco_libre', language: 'en_US', status: 'APPROVED' },
          ],
          paging: { next: 'https://graph.facebook.com/v27.0/waba-1/message_templates?fields=name,language,status&limit=100&after=page2' },
        }),
    ],
    [/\/waba-1\/subscribed_apps/, () => Response.json({ data: [{ whatsapp_business_api_data: { id: 'app-1', name: 'ClinicAI' } }] })],
    [/\/v27\.0\/pn-/, () => graphError(404, 803, 'Unsupported get request')],
    [/api\.openai\.com\/v1\/models\/gpt-4o-mini$/, () => Response.json({ id: 'gpt-4o-mini', object: 'model', owned_by: 'openai', shutdown_date: '2027-01-14' })],
    [/api\.openai\.com\/v1\/models\/gpt-transcribe$/, () => Response.json({ id: 'gpt-transcribe', object: 'model', owned_by: 'openai', shutdown_date: null })],
    [/clinicai\.kinde\.com\/\.well-known\/openid-configuration$/, () => Response.json({ issuer: 'https://clinicai.kinde.com' })],
    [
      /bot\.example\.com\/health$/,
      // F34: the queue only comes with the cron secret.
      (_url, init) =>
        Response.json(
          new Headers(init?.headers).get('x-cron-secret') === config.CRON_SECRET
            ? { status: 'ok', db: 'up', queue: { pending: 4, failedLast24h: 0 } }
            : { status: 'ok', db: 'up' },
          { headers: { 'x-content-type-options': 'nosniff', 'strict-transport-security': 'max-age=63072000' } },
        ),
    ],
    [/bot\.example\.com\/webhook\?/, (url) => new Response(url.searchParams.get('hub.verify_token') === config.VERIFY_TOKEN ? url.searchParams.get('hub.challenge') : 'Forbidden', {
      status: url.searchParams.get('hub.verify_token') === config.VERIFY_TOKEN ? 200 : 403,
    })],
    [/panel\.example\.com\/api\/health$/, () => Response.json({ status: 'ok' })],
    [
      /panel\.example\.com\/$/,
      () =>
        new Response('<html></html>', {
          headers: {
            'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-YWJj' 'strict-dynamic'",
            'strict-transport-security': 'max-age=63072000',
          },
        }),
    ],
  ]);
  const results = await runPreflight({
    config,
    logger: createSilentLogger(),
    systemDb: getTestDb(),
    appRoleDb: restricted,
    fetchFn: fake.fetchFn,
    now: NOW,
    web: {
      ENCRYPTION_KEY: KEY,
      DATABASE_URL: config.DATABASE_URL,
      DATABASE_APP_URL: config.DATABASE_APP_URL,
      KINDE_ISSUER_URL: 'https://clinicai.kinde.com',
      KINDE_SITE_URL: 'https://panel.example.com',
      KINDE_POST_LOGIN_REDIRECT_URL: 'https://panel.example.com/dashboard',
      KINDE_POST_LOGOUT_REDIRECT_URL: 'https://panel.example.com',
    },
    botUrl: 'https://bot.example.com',
    webUrl: 'https://panel.example.com',
    ...overrides,
  });
  const find = (check: string) => results.find((r) => r.check === check);
  return { results, find, requests: fake.requests, clinicName, phoneNumberId, config };
}

const pick = (r: CheckResult | undefined) => (r ? { status: r.status, detail: r.detail } : undefined);

describe('F20 — pre-deployment check', () => {
  it('reports what is ready, what needs attention and what is broken, only with GET requests', async () => {
    const s = await scenario();
    expect(pick(s.find('Zona horaria'))).toEqual({ status: 'ok', detail: 'UTC' });
    // The test database is created without `prisma migrate`, so there is no migrations table.
    expect(s.find('Migraciones')?.status).toBe('fail');
    expect(pick(s.find('Aislamiento por clínica (DATABASE_APP_URL)'))).toEqual({
      status: 'ok',
      detail: 'Rol clinicai_app con RLS: sin clínica no ve ninguna fila',
    });
    expect(pick(s.find(`Número de ${s.clinicName}`))).toEqual({ status: 'ok', detail: '+34 965 000 000 (Clínica), calidad GREEN' });
    expect(s.find('Plantilla recordatorio_cita')?.status).toBe('ok');
    // Found on the second page, still under review.
    expect(pick(s.find('Plantilla aviso_hueco_libre'))).toEqual({ status: 'warn', detail: 'En revisión (PENDING)' });
    expect(pick(s.find('Webhook suscrito'))).toEqual({ status: 'ok', detail: 'ClinicAI' });
    expect(pick(s.find('Modelo gpt-4o-mini (principal)'))).toEqual({
      status: 'warn',
      detail: 'Se apaga el 2027-01-14 (en 62 días): cambia de modelo y repite eval/',
    });
    expect(s.find('Modelo gpt-transcribe (notas de voz)')?.status).toBe('ok');
    expect(pick(s.find('ENCRYPTION_KEY'))).toEqual({ status: 'ok', detail: 'La misma en el bot y en el panel' });
    expect(s.find('Kinde')?.status).toBe('ok');
    expect(pick(s.find('Bot /health'))).toEqual({ status: 'ok', detail: 'Responde; 4 mensajes en cola' });
    expect(pick(s.find('Verificación del webhook'))).toEqual({ status: 'ok', detail: 'El VERIFY_TOKEN coincide con el del bot desplegado' });
    expect(s.find('Panel /api/health')?.status).toBe('ok');
    // F25: security headers of what is deployed.
    expect(pick(s.find('Panel: cabeceras de seguridad'))).toEqual({ status: 'ok', detail: 'Política de seguridad (CSP) con nonce y HSTS' });
    expect(pick(s.find('Bot: cabeceras de seguridad'))).toEqual({ status: 'ok', detail: 'Con HSTS' });

    // Read-only: no POST, and the tokens travel in the Authorization header, never in the URL.
    expect(s.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(s.requests.some((r) => r.url.includes('meta-token') || r.url.includes('sk-test'))).toBe(false);
    expect(s.requests.find((r) => r.url.includes('/message_templates'))?.auth).toBe('Bearer meta-token');
    expect(formatPreflight(s.results)).toMatch(/Resultado: \d+ correctas · \d+ avisos · \d+ errores · \d+ sin comprobar$/);
  });

  it('explains Meta errors by their code', async () => {
    expect(explainGraphError({ ok: false, status: 401, code: 190, message: 'Invalid OAuth access token' })).toBe(
      'el token de acceso no es válido o ha caducado (código 190)',
    );
    expect(explainGraphError({ ok: false, status: 403, code: 200, message: 'x' })).toMatch(/no tiene permiso/);
    expect(explainGraphError({ ok: false, status: 404, code: 803, message: 'x' })).toMatch(/no existe/);
  });

  it('catches the usual deployment mistakes', async () => {
    const s = await scenario(
      {
        appRoleDb: getTestDb(),
        fetchFn: fakeFetch([
          [/\/waba-1\/message_templates/, () => Response.json({ data: [{ name: 'recordatorio_cita', language: 'es', status: 'REJECTED' }] })],
          [/\/waba-1\/subscribed_apps/, () => Response.json({ data: [{ whatsapp_business_api_data: { id: 'otra-app', name: 'Otra' } }] })],
          [/\/v27\.0\/pn-/, () => graphError(401, 190, 'Invalid OAuth access token')],
          [/api\.openai\.com/, () => Response.json({ error: { message: 'Incorrect API key provided' } }, { status: 401 })],
          [/kinde\.com/, () => new Response('nope', { status: 404 })],
          [/bot\.example\.com\/health$/, () => Response.json({ status: 'ok', queue: { pending: 3, failedLast24h: 2 } })],
          [/bot\.example\.com\/webhook/, () => new Response('Forbidden', { status: 403 })],
        ]).fetchFn,
        web: {
          ENCRYPTION_KEY: OTHER_KEY,
          KINDE_ISSUER_URL: 'https://otra.kinde.com',
          KINDE_SITE_URL: 'https://panel.example.com',
          KINDE_POST_LOGIN_REDIRECT_URL: 'https://otro-sitio.example.com/dashboard',
          KINDE_POST_LOGOUT_REDIRECT_URL: 'https://panel.example.com',
        },
        webUrl: null,
      },
      { LLM_MODE: 'live' },
    );
    // The owner connection is not the restricted role.
    expect(s.find('Aislamiento por clínica (DATABASE_APP_URL)')?.status).toBe('fail');
    expect(pick(s.find(`Número de ${s.clinicName}`))).toEqual({
      status: 'fail',
      detail: 'el token de acceso no es válido o ha caducado (código 190)',
    });
    expect(pick(s.find('Plantilla recordatorio_cita'))).toEqual({ status: 'fail', detail: 'Estado REJECTED: no se puede enviar' });
    // The waiting list is on in this clinic, so its template is required.
    expect(pick(s.find('Plantilla aviso_hueco_libre'))).toEqual({ status: 'fail', detail: 'No existe en el idioma es' });
    expect(s.find('Webhook suscrito')).toMatchObject({ status: 'fail', detail: 'La app app-1 no está suscrita (sí: Otra)' });
    expect(pick(s.find('Modelo gpt-4o-mini (principal)'))).toEqual({ status: 'fail', detail: 'OPENAI_API_KEY no es válida (HTTP 401)' });
    expect(s.find('ENCRYPTION_KEY')?.status).toBe('fail');
    expect(s.find('KINDE_POST_LOGIN_REDIRECT_URL')?.status).toBe('warn');
    expect(s.find('Kinde')?.status).toBe('fail');
    expect(s.find('Bot /health')).toMatchObject({ status: 'warn' });
    expect(s.find('Bot: cabeceras de seguridad')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/última versión/) });
    expect(s.find('Verificación del webhook')?.status).toBe('fail');
  });

  it('F30: an approved reminder template with the old text (no date) is reported', async () => {
    const body = (text: string) => [{ type: 'BODY', text }, { type: 'BUTTONS' }];
    const templates = (reminder: string) =>
      fakeFetch([
        [/\/v27\.0\/pn-/, () => graphError(404, 803, 'Unsupported get request')],
        [/\/waba-1\/subscribed_apps/, () => Response.json({ data: [] })],
        [
          /\/waba-1\/message_templates\?/,
          () => Response.json({ data: [{ name: 'recordatorio_cita', language: 'es', status: 'APPROVED', components: body(reminder) }] }),
        ],
      ]);
    const oldFake = templates('Hola {{1}}, te recordamos tu cita en {{2}} mañana a las {{3}}.');
    const old = await scenario({ botUrl: null, webUrl: null, web: null, fetchFn: oldFake.fetchFn }, { LLM_MODE: 'mock' });
    expect(old.find('Plantilla recordatorio_cita')).toMatchObject({ status: 'fail', detail: expect.stringMatching(/3 variables y el bot envía 4/) });
    const current = await scenario(
      { botUrl: null, webUrl: null, web: null, fetchFn: templates('Hola {{1}}, te recordamos tu cita en {{2}} el {{3}} a las {{4}}.').fetchFn },
      { LLM_MODE: 'mock' },
    );
    expect(current.find('Plantilla recordatorio_cita')).toMatchObject({ status: 'ok', detail: 'Aprobada' });
    // The request asks for the body of the templates.
    expect(oldFake.requests.find((r) => r.url.includes('/message_templates'))?.url).toContain('fields=name,language,status,components');
  });

  it('F25: warns when the panel policy only reports, and fails without it', async () => {
    const panel = (headers: Record<string, string>) =>
      fakeFetch([
        [/panel\.example\.com\/api\/health$/, () => Response.json({ status: 'ok' })],
        [/panel\.example\.com\/$/, () => new Response('<html></html>', { headers })],
      ]).fetchFn;
    const reportOnly = await scenario({
      botUrl: null,
      web: null,
      fetchFn: panel({ 'content-security-policy-report-only': "script-src 'self' 'nonce-YWJj' 'strict-dynamic'" }),
    }, { META_WABA_ID: '', LLM_MODE: 'mock' });
    expect(reportOnly.find('Panel: cabeceras de seguridad')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/CSP_REPORT_ONLY/) });
    const none = await scenario({ botUrl: null, web: null, fetchFn: panel({}) }, { META_WABA_ID: '', LLM_MODE: 'mock' });
    expect(none.find('Panel: cabeceras de seguridad')).toMatchObject({ status: 'fail', detail: expect.stringMatching(/Sin política de seguridad/) });
  });

  it('F34: refuses the test encryption key (every byte equal), in the bot or in the panel', async () => {
    const zeros = Buffer.alloc(32).toString('base64');
    const s = await scenario({ web: { ENCRYPTION_KEY: zeros, KINDE_ISSUER_URL: 'https://clinicai.kinde.com' }, botUrl: null, webUrl: null }, { ENCRYPTION_KEY: zeros });
    expect(s.find('ENCRYPTION_KEY')).toMatchObject({ status: 'fail', detail: expect.stringMatching(/clave de pruebas/) });
  });

  it('F32: warns when the panel does not check WhatsApp numbers or may run without DATABASE_APP_URL', async () => {
    const web = { ENCRYPTION_KEY: KEY, KINDE_ISSUER_URL: 'https://clinicai.kinde.com', WHATSAPP_MODE: 'mock', ALLOW_OWNER_CONNECTION: 'true' };
    const live = await scenario({ web, botUrl: null, webUrl: null }, { WHATSAPP_MODE: 'live', META_APP_SECRET: 's', VERIFY_TOKEN: 'v', META_JWT_TOKEN: 't' });
    expect(live.find('Comprobación de números de WhatsApp')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/WHATSAPP_MODE=mock/) });
    expect(live.find('ALLOW_OWNER_CONNECTION')).toMatchObject({ status: 'warn' });
    const clean = await scenario({ web: { ENCRYPTION_KEY: KEY, KINDE_ISSUER_URL: 'https://clinicai.kinde.com' }, botUrl: null, webUrl: null });
    expect(clean.find('Comprobación de números de WhatsApp')).toBeUndefined();
    expect(clean.find('ALLOW_OWNER_CONNECTION')).toBeUndefined();
  });

  it('F31: checks who can open the platform console and the prices of its estimate', async () => {
    const web = (extra: Record<string, string>) => ({ web: { ENCRYPTION_KEY: KEY, KINDE_ISSUER_URL: 'https://clinicai.kinde.com', ...extra }, botUrl: null, webUrl: null });
    expect(pick((await scenario(web({}))).find('Consola de la plataforma'))).toEqual({
      status: 'warn',
      detail: 'Sin PLATFORM_ADMIN_EMAILS: nadie puede abrir /plataforma',
    });
    expect(pick((await scenario(web({ PLATFORM_ADMIN_EMAILS: 'a@x.test, b@x.test', PLATFORM_PRICES: '{"whatsapp":{"template":0.03}}' }))).find('Consola de la plataforma'))).toEqual({
      status: 'ok',
      detail: '2 administradores, con precios propios',
    });
    expect((await scenario(web({ PLATFORM_ADMIN_EMAILS: 'a@x.test', PLATFORM_PRICES: '{"llm":5}' }))).find('Consola de la plataforma')).toMatchObject({
      status: 'fail',
      detail: expect.stringMatching(/^PLATFORM_PRICES no válido/),
    });
  });

  it('a clinic token encrypted with another key is reported, and checks without data are skipped', async () => {
    const db = getTestDb();
    const clinicName = `Clave ${randomUUID().slice(0, 6)}`;
    await createTenant(db, { clinicName, waPhoneNumberId: `pn-${randomUUID()}` }).then((t) =>
      db.tenantConfig.update({ where: { id: t.id }, data: { waAccessTokenEnc: encryptSecret('token-propio', OTHER_KEY) } }),
    );
    const s = await scenario({ web: null, botUrl: null, webUrl: null }, { META_WABA_ID: '' });
    expect(s.find(`Número de ${clinicName}`)).toMatchObject({ status: 'fail', detail: expect.stringMatching(/ENCRYPTION_KEY/) });
    expect(s.find('Plantillas y webhook')?.status).toBe('skip');
    expect(s.find('Variables del panel')?.status).toBe('skip');
    expect(s.find('Bot /health')).toBeUndefined();
  });
});
