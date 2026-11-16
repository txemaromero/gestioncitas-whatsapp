import { randomUUID } from 'node:crypto';
import { createTenant } from '@clinicai/db/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_SECRET,
  CRON_SECRET,
  VERIFY_TOKEN,
  createPipeline,
  createTestDeps,
  getTestDb,
  loadFixture,
  resetQueue,
  type TestDeps,
} from '../../test/helpers';
import type { IncomingMessage, MessageHandler } from '../engine/types';
import { signMetaPayload, verifyMetaSignature } from './meta';

function setup(deps: TestDeps = createTestDeps()) {
  const handled: IncomingMessage[] = [];
  const engine: MessageHandler = {
    handle: vi.fn(async (_tenant, message: IncomingMessage) => {
      handled.push(message);
    }),
  };
  const { app, flush } = createPipeline(deps, engine);
  apps.push(app);
  return { deps, app, engine, handled, flush };
}

type App = ReturnType<typeof setup>['app'];

async function postWebhook(app: App, body: string, signature?: string) {
  return app.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      ...(signature === undefined ? { 'x-hub-signature-256': signMetaPayload(body, APP_SECRET) } : signature ? { 'x-hub-signature-256': signature } : {}),
    },
    payload: body,
  });
}

/** Text message payload with a unique WhatsApp message id. */
function textPayload(phoneNumberId: string, text: string, from = '34622222222'): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550783881', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'Pablo' }, wa_id: from }],
              messages: [{ from, id: `wamid.${randomUUID()}`, timestamp: '1749416383', type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  });
}

let apps: { close: () => Promise<unknown> }[] = [];
beforeEach(async () => {
  await resetQueue();
});
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

describe('GET /webhook (verification)', () => {
  it('returns 200 with the exact challenge as plain text', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'GET',
      url: `/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('1158201444');
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
  });

  it('returns 403 with a wrong token or mode (never 500)', async () => {
    const { app } = setup();
    const wrongToken = await app.inject({
      method: 'GET',
      url: '/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1',
    });
    expect(wrongToken.statusCode).toBe(403);
    const wrongMode = await app.inject({
      method: 'GET',
      url: `/webhook?hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`,
    });
    expect(wrongMode.statusCode).toBe(403);
    const empty = await app.inject({ method: 'GET', url: '/webhook' });
    expect(empty.statusCode).toBe(403);
  });
});

describe('POST /webhook', () => {
  it('rejects an invalid or missing signature with 401 and does not process', async () => {
    const { app, engine, flush } = setup();
    const body = loadFixture('text-message', { PHONE_NUMBER_ID: 'x' });
    expect((await postWebhook(app, body, 'sha256=deadbeef')).statusCode).toBe(401);
    expect((await postWebhook(app, body, '')).statusCode).toBe(401);
    await flush();
    expect(engine.handle).not.toHaveBeenCalled();
  });

  it('stores the message before answering 200 and processes it in the queue worker', async () => {
    const { app, handled, flush } = setup();
    const tenant = await createTenant(getTestDb());
    const body = loadFixture('text-message', { PHONE_NUMBER_ID: tenant.waPhoneNumberId! });
    const res = await postWebhook(app, body);
    expect(res.statusCode).toBe(200);
    // Durable before the 200: the event is in the database even though nothing processed it yet.
    expect(handled).toHaveLength(0);
    const stored = await getTestDb().inboundEvent.findMany({ where: { tenantId: tenant.id } });
    expect(stored).toMatchObject([{ source: 'whatsapp', phone: '+34611111111', status: 'pending' }]);

    expect(await flush()).toBe(1);
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({
      tenantId: tenant.id,
      phone: '+34611111111',
      type: 'text',
      text: 'Hola, ¿qué horario tenéis?',
      payloadId: null,
      waMessageId: 'wamid.HBgLMzQ2MTExMTExMTEVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=',
      profileName: 'Laura',
    });
    expect(await getTestDb().inboundEvent.findFirst({ where: { tenantId: tenant.id } })).toMatchObject({ status: 'done', payload: {} });
  });

  it('is idempotent: a duplicated delivery is processed once', async () => {
    const { app, handled, flush } = setup();
    const tenant = await createTenant(getTestDb());
    const body = loadFixture('button-reply', { PHONE_NUMBER_ID: tenant.waPhoneNumberId! });
    await postWebhook(app, body);
    await flush();
    // Meta retries after the message was already processed.
    expect((await postWebhook(app, body)).statusCode).toBe(200);
    await flush();
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({ type: 'button', payloadId: 'CONFIRM_YES', text: 'Sí ✅' });
  });

  it('answers 500 when the message cannot be stored, so Meta retries and nothing is lost', async () => {
    const deps = createTestDeps();
    const enqueue = deps.systemRepos.inboundEvents.enqueue;
    // The queue is stored with the owner connection (F19).
    deps.systemRepos = {
      ...deps.systemRepos,
      inboundEvents: {
        ...deps.systemRepos.inboundEvents,
        enqueue: async () => {
          throw new Error('connection terminated');
        },
      },
    };
    const { app, handled, flush } = setup(deps);
    const tenant = await createTenant(getTestDb());
    const body = textPayload(tenant.waPhoneNumberId!, 'Hola');

    expect((await postWebhook(app, body)).statusCode).toBe(500);
    await flush();
    expect(handled).toHaveLength(0);

    // Database back: Meta's retry of the same delivery is stored and processed.
    deps.systemRepos.inboundEvents.enqueue = enqueue;
    expect((await postWebhook(app, body)).statusCode).toBe(200);
    await flush();
    expect(handled.map((m) => m.text)).toEqual(['Hola']);
  });

  it('rate-limits floods per phone across instances (counted in the database)', async () => {
    const config = { RATE_LIMIT_PER_MINUTE: '2' };
    const instanceA = setup(createTestDeps({ config }));
    const instanceB = setup(createTestDeps({ config }));
    const tenant = await createTenant(getTestDb());
    const pnid = tenant.waPhoneNumberId!;
    await postWebhook(instanceA.app, textPayload(pnid, 'uno'));
    await postWebhook(instanceB.app, textPayload(pnid, 'dos'));
    expect((await postWebhook(instanceA.app, textPayload(pnid, 'tres'))).statusCode).toBe(200);
    // Another phone is not affected.
    await postWebhook(instanceB.app, textPayload(pnid, 'otro', '34633333333'));
    await instanceA.flush();
    await instanceB.flush();
    expect([...instanceA.handled, ...instanceB.handled].map((m) => m.text).sort()).toEqual(['dos', 'otro', 'uno']);
  });

  it('discards messages for an unknown phone_number_id', async () => {
    const { app, engine, flush } = setup();
    await postWebhook(app, loadFixture('text-message', { PHONE_NUMBER_ID: 'unknown-number' }));
    expect(await flush()).toBe(0);
    expect(engine.handle).not.toHaveBeenCalled();
  });

  it('discards messages older than 7 days: after that they can only be a replay (F34)', async () => {
    const { app, deps, engine, flush } = setup();
    const tenant = await createTenant(getTestDb());
    const now = deps.clock.now().getTime() / 1000;
    const at = (secondsAgo: number) =>
      textPayload(tenant.waPhoneNumberId!, `Hace ${secondsAgo} s`).replace('"timestamp":"1749416383"', `"timestamp":"${Math.floor(now - secondsAgo)}"`);
    await postWebhook(app, at(8 * 24 * 60 * 60));
    expect(await flush()).toBe(0);
    await postWebhook(app, at(6 * 24 * 60 * 60));
    expect(await flush()).toBe(1);
    expect(engine.handle).toHaveBeenCalledTimes(1);
  });

  it('ignores status events', async () => {
    const { app, engine, flush } = setup();
    const tenant = await createTenant(getTestDb());
    const res = await postWebhook(app, loadFixture('status-update', { PHONE_NUMBER_ID: tenant.waPhoneNumberId! }));
    expect(res.statusCode).toBe(200);
    expect(await flush()).toBe(0);
    expect(engine.handle).not.toHaveBeenCalled();
  });

  it('normalizes list replies, template quick replies and non-text messages, in order', async () => {
    const { app, handled, flush } = setup();
    const tenant = await createTenant(getTestDb());
    const vars = { PHONE_NUMBER_ID: tenant.waPhoneNumberId!, APPOINTMENT_ID: 'appt-1' };
    await postWebhook(app, loadFixture('list-reply', vars));
    await postWebhook(app, loadFixture('template-quick-reply', vars));
    await postWebhook(app, loadFixture('audio-message', vars));
    await flush();
    expect(handled.map((m) => [m.type, m.payloadId, m.text, m.rawType])).toEqual([
      ['list', 'EMP:abc', 'Marcos', 'interactive'],
      ['button', 'REMINDER_CONFIRM:appt-1', 'Sí, confirmo', 'button'],
      ['other', null, '', 'audio'],
    ]);
    // F16: the voice note keeps its media id for the engine to download and transcribe it.
    expect(handled[2]?.media).toEqual({ id: 'media-1', mimeType: 'audio/ogg; codecs=opus', voice: true });
  });

  it('returns 400 on malformed JSON', async () => {
    const { app } = setup();
    const res = await postWebhook(app, '{not json');
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /health', () => {
  it('reports ok with the database up and the queue state', async () => {
    const { app } = setup();
    const tenant = await createTenant(getTestDb());
    await postWebhook(app, textPayload(tenant.waPhoneNumberId!, 'Hola'));
    // F34: without the cron secret, only whether it is alive.
    const open = await app.inject({ method: 'GET', url: '/health' });
    expect(open.statusCode).toBe(200);
    expect(open.json()).toEqual({ status: 'ok', db: 'up' });
    const wrong = await app.inject({ method: 'GET', url: '/health', headers: { 'x-cron-secret': 'otro' } });
    expect(wrong.json()).toEqual({ status: 'ok', db: 'up' });
    const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-cron-secret': CRON_SECRET } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: 'up', whatsapp: 'mock', queue: { pending: 1, processing: 0 } });
    expect(res.json().queue.lagSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('verifyMetaSignature', () => {
  it('validates sha256 HMAC over the raw body in constant time', () => {
    const body = Buffer.from('{"a":1}');
    const sig = signMetaPayload(body, 'secret');
    expect(verifyMetaSignature(body, sig, 'secret')).toBe(true);
    expect(verifyMetaSignature(Buffer.from('{"a": 1}'), sig, 'secret')).toBe(false);
    expect(verifyMetaSignature(body, sig, 'other')).toBe(false);
    expect(verifyMetaSignature(body, 'sha1=abc', 'secret')).toBe(false);
    expect(verifyMetaSignature(body, undefined, 'secret')).toBe(false);
  });
});
