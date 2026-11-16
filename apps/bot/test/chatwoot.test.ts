/**
 * RF-W5 / CU-A10…A14 with an in-memory fake of the Chatwoot Application API.
 * CU-A10 Consultar Chatwoot · CU-A11 Desactivar Bot · CU-A12 Activar Bot ·
 * CU-A13 Consultar Estado del Bot · CU-A14 Enviar Mensaje Manual al Cliente.
 */
import { eraseClient } from '@clinicai/db';
import { createClient, createEmployee, createTenant, uniquePhone } from '@clinicai/db/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { createConversationEngine } from '../src/engine/engine';
import { BOT_SOURCE_PREFIX, chatwootObserver, createChatwootService } from '../src/services/chatwoot';
import type { WhatsAppClient } from '../src/services/whatsapp';
import { WhatsAppApiError } from '../src/services/whatsapp';
import { createSilentLogger } from '../src/logger';
import { BOT_COMMAND_HELP, registerChatwootRoutes, signChatwootPayload } from '../src/webhook/chatwoot';
import { Chat, joined } from './chat';
import { createPipeline, createTestDeps, getTestDb, resetQueue, testConfig } from './helpers';

const CW_SECRET = 'cw-secret';
const CW_CONFIG = {
  CHATWOOT_URL: 'https://chatwoot.test',
  CHATWOOT_ACCOUNT_ID: '7',
  CHATWOOT_TOKEN: 'cw-token',
  CHATWOOT_INBOX_NAME: 'WhatsApp ClinicAI',
  CHATWOOT_WEBHOOK_SECRET: CW_SECRET,
};

interface FakeMessage {
  conversationId: number;
  content: string;
  message_type: string;
  private: boolean;
  source_id?: string;
  content_attributes?: Record<string, unknown>;
}

// Global id sequence: like a real Chatwoot install, ids never repeat across tests.
let seq = 100;

/** Minimal in-memory Chatwoot: inboxes, contacts, conversations, messages. */
function fakeChatwoot(options: { failAll?: boolean; onlineDeletes?: number } = {}) {
  let onlineDeletes = options.onlineDeletes ?? 0;
  const contacts: { id: number; identifier: string; name: string; phone_number: string }[] = [];
  const conversations: { id: number; contactId: number; custom_attributes: Record<string, unknown> }[] = [];
  const messages: FakeMessage[] = [];
  const requests: { method: string; path: string; headers: Record<string, string> }[] = [];

  const fetchFn = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    requests.push({ method, path: url.pathname, headers: init.headers as Record<string, string> });
    if (options.failAll) return new Response('down', { status: 503 });
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const path = url.pathname.replace('/api/v1/accounts/7', '');
    if (method === 'GET' && path === '/inboxes') {
      return Response.json({ payload: [{ id: 3, name: 'Otro' }, { id: 5, name: 'WhatsApp ClinicAI' }] });
    }
    const del = /^\/contacts\/(\d+)$/.exec(path);
    if (method === 'DELETE' && del) {
      // Real Chatwoot refuses (422) while the contact is online; conversations go with it.
      if (onlineDeletes > 0) {
        onlineDeletes -= 1;
        return Response.json({ message: 'Contact is online' }, { status: 422 });
      }
      const index = contacts.findIndex((c) => c.id === Number(del[1]));
      if (index === -1) return Response.json({ error: 'Contact not found' }, { status: 404 });
      contacts.splice(index, 1);
      for (let i = conversations.length - 1; i >= 0; i--) {
        if (conversations[i]!.contactId === Number(del[1])) conversations.splice(i, 1);
      }
      return new Response(null, { status: 200 });
    }
    if (method === 'GET' && path === '/contacts/search') {
      const q = url.searchParams.get('q') ?? '';
      return Response.json({ payload: contacts.filter((c) => c.identifier.includes(q)) });
    }
    if (method === 'POST' && path === '/contacts') {
      const contact = { id: ++seq, identifier: String(body.identifier), name: String(body.name), phone_number: String(body.phone_number) };
      contacts.push(contact);
      return Response.json({ payload: { contact, contact_inbox: { source_id: `src-${contact.id}` } } });
    }
    if (method === 'POST' && path === '/conversations') {
      const conversation = { id: ++seq, contactId: Number(body.contact_id), custom_attributes: body.custom_attributes as Record<string, unknown> };
      conversations.push(conversation);
      return Response.json({ id: conversation.id });
    }
    const m = /^\/conversations\/(\d+)\/messages$/.exec(path);
    if (method === 'POST' && m) {
      messages.push({
        conversationId: Number(m[1]),
        content: String(body.content),
        message_type: String(body.message_type),
        private: Boolean(body.private),
        source_id: body.source_id as string,
        content_attributes: body.content_attributes as Record<string, unknown>,
      });
      return Response.json({ id: ++seq });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchFn, contacts, conversations, messages, requests };
}

async function setup(options: { failAll?: boolean; onlineDeletes?: number; whatsapp?: WhatsAppClient } = {}) {
  const db = getTestDb();
  const fake = fakeChatwoot(options);
  const base = createTestDeps({ config: CW_CONFIG });
  const chatwoot = createChatwootService({
    config: testConfig(CW_CONFIG),
    logger: createSilentLogger(),
    repos: base.repos,
    background: base.background,
    fetchFn: fake.fetchFn,
  });
  const deps = { ...base, chatwoot, ...(options.whatsapp ? { whatsapp: options.whatsapp } : {}) } as typeof base;
  const tenantRow = await createTenant(db, { clinicName: 'Fisio Humana' });
  await createEmployee(db, tenantRow.id);
  const phone = uniquePhone();
  await createClient(db, tenantRow.id, { name: 'Laura Martínez', phone });
  const tenant = (await deps.systemRepos.tenants.findById(tenantRow.id))!;
  const engine = createConversationEngine(deps, chatwootObserver(chatwoot));
  const chat = new Chat(deps, engine, tenant, phone);
  const { app, flush } = createPipeline(deps, engine, { chatwoot, register: (i) => registerChatwootRoutes(i, deps) });
  return { db, deps, fake, chatwoot, tenant, phone, chat, app, flush };
}

beforeEach(async () => {
  await resetQueue();
});

async function postWebhook(ctx: Awaited<ReturnType<typeof setup>>, body: Record<string, unknown>, auth: 'token' | 'hmac' | 'none' | 'bad' = 'token') {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth === 'hmac') {
    headers['x-chatwoot-timestamp'] = ts;
    headers['x-chatwoot-signature'] = signChatwootPayload(CW_SECRET, ts, raw);
  }
  if (auth === 'bad') {
    headers['x-chatwoot-timestamp'] = ts;
    headers['x-chatwoot-signature'] = 'sha256=00';
  }
  const res = await ctx.app.inject({
    method: 'POST',
    url: auth === 'token' ? `/chatwoot/webhook?token=${CW_SECRET}` : '/chatwoot/webhook',
    headers,
    payload: raw,
  });
  await ctx.flush();
  return res;
}

function agentMessage(conversationId: number, content: string, extra: Record<string, unknown> = {}) {
  return {
    event: 'message_created',
    id: ++seq,
    content,
    message_type: 'outgoing',
    private: false,
    source_id: null,
    content_attributes: {},
    sender: { id: 1, name: 'Óscar' },
    account: { id: 7 },
    conversation: { id: conversationId },
    ...extra,
  };
}

describe('mirror — full history in Chatwoot (CU-A10 Consultar Chatwoot)', () => {
  it('copies client messages and bot replies to one Chatwoot conversation', async () => {
    const ctx = await setup();
    await ctx.chat.say('Hola');
    await ctx.chat.say('¿Qué horario tenéis?');
    await ctx.chatwoot.idle();
    expect(ctx.fake.contacts).toHaveLength(1);
    expect(ctx.fake.contacts[0]).toMatchObject({ identifier: `${ctx.tenant.id}:${ctx.phone}`, name: 'Laura Martínez', phone_number: ctx.phone });
    expect(ctx.fake.conversations).toHaveLength(1);
    const conv = ctx.fake.conversations[0]!;
    expect(conv.custom_attributes).toEqual({ tenant_id: ctx.tenant.id, phone: ctx.phone });
    const msgs = ctx.fake.messages.filter((m) => m.conversationId === conv.id);
    expect(msgs.map((m) => m.message_type)).toEqual(['incoming', 'outgoing', 'outgoing', 'incoming', 'outgoing']);
    expect(msgs[0]?.content).toBe('Hola');
    expect(msgs.every((m) => m.source_id?.startsWith(BOT_SOURCE_PREFIX) && m.content_attributes?.clinicai_bot === true)).toBe(true);
    expect(ctx.fake.requests.every((r) => r.headers.api_access_token === 'cw-token')).toBe(true);
    const link = await ctx.deps.systemRepos.chatwootLinks.get(ctx.tenant.id, ctx.phone);
    expect(link).toMatchObject({ accountId: 7, inboxId: 5, conversationId: conv.id });
  });

  it('never blocks the bot when Chatwoot is down', async () => {
    const ctx = await setup({ failAll: true });
    expect(joined(await ctx.chat.say('Hola'))).toContain('Bienvenido/a de nuevo a Fisio Humana');
    await ctx.chatwoot.idle();
  });
});

describe('POST /chatwoot/webhook', () => {
  async function linked() {
    const ctx = await setup();
    await ctx.chat.say('Hola');
    await ctx.chatwoot.idle();
    const conversationId = ctx.fake.conversations[0]!.id;
    ctx.deps.whatsapp.clear();
    return { ...ctx, conversationId };
  }

  it('rejects requests without a valid token or signature', async () => {
    const ctx = await linked();
    expect((await postWebhook(ctx, agentMessage(ctx.conversationId, 'x'), 'none')).statusCode).toBe(401);
    expect((await postWebhook(ctx, agentMessage(ctx.conversationId, 'x'), 'bad')).statusCode).toBe(401);
    expect(ctx.deps.whatsapp.outbox).toHaveLength(0);
  });

  it('sends a human agent reply to the client via WhatsApp (CU-A14), HMAC auth', async () => {
    const ctx = await linked();
    const res = await postWebhook(ctx, agentMessage(ctx.conversationId, 'Hola Laura, soy Óscar. Te llamo en 5 minutos.'), 'hmac');
    expect(res.statusCode).toBe(200);
    expect(ctx.deps.whatsapp.outbox).toHaveLength(1);
    expect(ctx.deps.whatsapp.outbox[0]).toMatchObject({
      to: ctx.phone,
      message: { type: 'text', text: 'Hola Laura, soy Óscar. Te llamo en 5 minutos.' },
    });
  });

  it('ignores conversations the bot did not create, whatever their attributes say (F32)', async () => {
    const ctx = await linked();
    const other = ctx.conversationId + 1000;
    const forged = agentMessage(other, 'Mensaje desde una conversación ajena', {
      conversation: { id: other, custom_attributes: { tenant_id: ctx.tenant.id, phone: ctx.phone }, meta: { sender: { phone_number: ctx.phone } } },
    });
    expect((await postWebhook(ctx, forged, 'hmac')).statusCode).toBe(200);
    // The same conversation id in another Chatwoot account is not the clinic's either.
    await postWebhook(ctx, agentMessage(ctx.conversationId, 'Desde otra cuenta', { account: { id: 99 } }), 'hmac');
    expect(ctx.deps.whatsapp.outbox).toHaveLength(0);
  });

  it('refuses a signed webhook older than 5 minutes, so it cannot be replayed (F34)', async () => {
    const ctx = await linked();
    const send = async (secondsAgo: number) => {
      const raw = JSON.stringify(agentMessage(ctx.conversationId, `Hace ${secondsAgo} s`));
      const ts = String(Math.floor(Date.now() / 1000) - secondsAgo);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/chatwoot/webhook',
        headers: { 'content-type': 'application/json', 'x-chatwoot-timestamp': ts, 'x-chatwoot-signature': signChatwootPayload(CW_SECRET, ts, raw) },
        payload: raw,
      });
      await ctx.flush();
      return res.statusCode;
    };
    expect(await send(10 * 60)).toBe(401);
    expect(await send(-10 * 60)).toBe(401);
    expect(ctx.deps.whatsapp.outbox).toHaveLength(0);
    expect(await send(30)).toBe(200);
    expect(ctx.deps.whatsapp.outbox).toHaveLength(1);
  });

  it('stores the agent action before answering and delivers it once if Chatwoot repeats the webhook', async () => {
    const ctx = await linked();
    const message = agentMessage(ctx.conversationId, 'Te esperamos mañana');
    const first = await ctx.app.inject({
      method: 'POST',
      url: `/chatwoot/webhook?token=${CW_SECRET}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(message),
    });
    expect(first.json()).toEqual({ status: 'queued' });
    expect(ctx.deps.whatsapp.outbox).toHaveLength(0);
    expect(await ctx.db.inboundEvent.findFirst({ where: { tenantId: ctx.tenant.id, source: 'chatwoot' } })).toMatchObject({
      status: 'pending',
      phone: ctx.phone,
      externalId: `7:${message.id}`,
    });
    const repeated = await postWebhook(ctx, message);
    expect(repeated.json()).toEqual({ status: 'duplicate' });
    expect(ctx.deps.whatsapp.outbox.map((e) => e.message)).toEqual([{ type: 'text', text: 'Te esperamos mañana' }]);
  });

  it('discards its own mirrored messages and incoming ones (no loops)', async () => {
    const ctx = await linked();
    await postWebhook(ctx, agentMessage(ctx.conversationId, 'eco', { source_id: `${BOT_SOURCE_PREFIX}abc` }));
    await postWebhook(ctx, agentMessage(ctx.conversationId, 'eco', { content_attributes: { clinicai_bot: true } }));
    await postWebhook(ctx, agentMessage(ctx.conversationId, 'Hola', { message_type: 'incoming' }));
    await postWebhook(ctx, agentMessage(ctx.conversationId, 'Hola', { message_type: 0 }));
    await postWebhook(ctx, { ...agentMessage(ctx.conversationId, 'x'), event: 'conversation_updated' });
    expect(ctx.deps.whatsapp.outbox).toHaveLength(0);
  });

  it('/bot off pauses the bot (CU-A11) and the client gets no automatic reply', async () => {
    const ctx = await linked();
    const before = ctx.fake.messages.length;
    await postWebhook(ctx, agentMessage(ctx.conversationId, '/bot off', { private: true }));
    expect(await ctx.deps.systemRepos.blacklist.isBlocked(ctx.tenant.id, ctx.phone)).toBe(true);
    const note = ctx.fake.messages.slice(before).find((m) => m.private);
    expect(note?.content).toBe('🤖 Bot desactivado para este contacto');

    expect(await ctx.chat.say('¿Hola? Quiero cita')).toEqual([]);
    await ctx.chatwoot.idle();
    // …but the message is still mirrored so the agent sees it.
    expect(ctx.fake.messages.at(-1)).toMatchObject({ content: '¿Hola? Quiero cita', message_type: 'incoming' });

    await postWebhook(ctx, agentMessage(ctx.conversationId, '/bot off', { private: true }));
    expect(ctx.fake.messages.at(-1)?.content).toBe('🤖 El bot ya estaba desactivado para este contacto');
    await postWebhook(ctx, agentMessage(ctx.conversationId, '/bot status', { private: true }));
    expect(ctx.fake.messages.at(-1)?.content).toBe('🤖 Estado del bot: pausado');
  });

  it('/bot on resumes the bot (CU-A12), /bot status (CU-A13) and help for malformed commands', async () => {
    const ctx = await linked();
    await ctx.deps.systemRepos.blacklist.add(ctx.tenant.id, ctx.phone, 'test');
    await postWebhook(ctx, agentMessage(ctx.conversationId, '/bot on', { private: true }));
    expect(await ctx.deps.systemRepos.blacklist.isBlocked(ctx.tenant.id, ctx.phone)).toBe(false);
    expect(ctx.fake.messages.at(-1)).toMatchObject({ content: '🤖 Bot activado', private: true });
    await postWebhook(ctx, agentMessage(ctx.conversationId, '/bot on', { private: true }));
    expect(ctx.fake.messages.at(-1)?.content).toBe('🤖 El bot ya estaba activo para este contacto');
    await postWebhook(ctx, agentMessage(ctx.conversationId, '/bot status', { private: true }));
    expect(ctx.fake.messages.at(-1)?.content).toBe('🤖 Estado del bot: activo');
    await postWebhook(ctx, agentMessage(ctx.conversationId, '/bot apagar', { private: true }));
    expect(ctx.fake.messages.at(-1)?.content).toBe(BOT_COMMAND_HELP);
    // The bot answers again (the conversation was already open, so "Hola" is a FAQ greeting).
    expect(joined(await ctx.chat.say('Hola'))).toBe('¡Hola! ¿En qué puedo ayudarte?');
  });

  it('ignores ordinary private notes', async () => {
    const ctx = await linked();
    const before = ctx.fake.messages.length;
    await postWebhook(ctx, agentMessage(ctx.conversationId, 'Nota interna: cliente VIP', { private: true }));
    expect(ctx.fake.messages.length).toBe(before);
    expect(ctx.deps.whatsapp.outbox).toHaveLength(0);
  });

  it('adds a private note when WhatsApp rejects the message (24 h window closed)', async () => {
    const ctx = await linked();
    const failing: WhatsAppClient = {
      ...ctx.deps.whatsapp,
      sendText: async () => {
        throw new WhatsAppApiError('Re-engagement message', 400, 131047, false);
      },
    };
    const deps = { ...ctx.deps, whatsapp: failing };
    const pipeline = createPipeline(deps, createConversationEngine(deps), {
      chatwoot: ctx.chatwoot,
      register: (i) => registerChatwootRoutes(i, deps),
    });
    await postWebhook({ ...ctx, ...pipeline }, agentMessage(ctx.conversationId, 'Hola de nuevo'));
    expect(ctx.fake.messages.at(-1)?.content).toContain('han pasado más de 24 h');
    expect(ctx.fake.messages.at(-1)?.private).toBe(true);
  });
});

describe('GDPR erasure (F12)', () => {
  async function erased(options: { onlineDeletes?: number } = {}) {
    const ctx = await setup(options);
    await ctx.chat.say('Hola');
    await ctx.chatwoot.idle();
    const contact = ctx.fake.contacts[0]!;
    const client = (await ctx.deps.systemRepos.clients.findByPhone(ctx.tenant.id, ctx.phone))!;
    await eraseClient(ctx.db, ctx.tenant.id, client.id);
    await ctx.flush();
    const job = await ctx.db.inboundEvent.findFirstOrThrow({ where: { tenantId: ctx.tenant.id, source: 'internal' } });
    const deletes = ctx.fake.requests.filter((r) => r.method === 'DELETE').map((r) => r.path);
    return { ctx, contact, job, deletes };
  }

  it('deletes the Chatwoot contact and its conversations through the queue', async () => {
    const { ctx, contact, job, deletes } = await erased();
    expect(deletes).toEqual([`/api/v1/accounts/7/contacts/${contact.id}`]);
    expect(ctx.fake.contacts).toHaveLength(0);
    expect(ctx.fake.conversations).toHaveLength(0);
    expect(job).toMatchObject({ status: 'done', attempts: 1, payload: {} });
  });

  it('retries while Chatwoot answers 422 (contact online) and accepts 404 (already deleted)', async () => {
    const online = await erased({ onlineDeletes: 2 });
    expect(online.deletes).toHaveLength(3);
    expect(online.job).toMatchObject({ status: 'done', attempts: 3 });

    const ctx = await setup();
    await ctx.chat.say('Hola');
    await ctx.chatwoot.idle();
    ctx.fake.contacts.length = 0; // deleted by hand in Chatwoot
    const client = (await ctx.deps.systemRepos.clients.findByPhone(ctx.tenant.id, ctx.phone))!;
    await eraseClient(ctx.db, ctx.tenant.id, client.id);
    await ctx.flush();
    expect(await ctx.db.inboundEvent.findFirstOrThrow({ where: { tenantId: ctx.tenant.id, source: 'internal' } })).toMatchObject({
      status: 'done',
    });
  });
});
