import { randomBytes } from 'node:crypto';
import { encryptSecret } from '@clinicai/shared/crypto';
import type { Tenant } from '@clinicai/db';
import { parseTenantSettings } from '@clinicai/shared';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { createSilentLogger } from '../logger';
import {
  MediaTooLargeError,
  buildPayload,
  createLiveWhatsAppClient,
  createMockWhatsAppClient,
  isMetaMediaUrl,
  mockMediaId,
  resolveWaAccount,
} from './whatsapp';

const account = { phoneNumberId: '1234567890', accessToken: 'token' };

describe('buildPayload', () => {
  it('builds a text message', () => {
    expect(buildPayload('+34611111111', { type: 'text', text: 'Hola' })).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '34611111111',
      type: 'text',
      text: { preview_url: false, body: 'Hola' },
    });
  });

  it('limits reply buttons to 3 and titles to 20 characters', () => {
    const payload = buildPayload('+34611111111', {
      type: 'buttons',
      body: '¿Deseas confirmar la cita, cambiar la fecha o salir?',
      buttons: [
        { id: 'A', title: 'Sí ✅' },
        { id: 'B', title: 'Un título demasiado largo para WhatsApp' },
        { id: 'C', title: 'Salir' },
        { id: 'D', title: 'Sobra' },
      ],
    }) as { interactive: { type: string; action: { buttons: { reply: { title: string } }[] } } };
    expect(payload.interactive.type).toBe('button');
    expect(payload.interactive.action.buttons).toHaveLength(3);
    for (const b of payload.interactive.action.buttons) expect(b.reply.title.length).toBeLessThanOrEqual(20);
  });

  it('limits list messages to 10 rows in total', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: `R${i}`, title: `Profesional número ${i} con nombre largo` }));
    const payload = buildPayload('+34611111111', {
      type: 'list',
      body: 'Elige',
      buttonText: 'Ver profesionales',
      sections: [{ title: 'Profesionales', rows }],
    }) as { interactive: { action: { button: string; sections: { rows: { title: string }[] }[] } } };
    const allRows = payload.interactive.action.sections.flatMap((s) => s.rows);
    expect(allRows).toHaveLength(10);
    for (const r of allRows) expect(r.title.length).toBeLessThanOrEqual(24);
  });

  it('builds a template with body params and quick-reply payloads', () => {
    const payload = buildPayload('+34611111111', {
      type: 'template',
      name: 'recordatorio_cita',
      language: 'es',
      bodyParams: ['Laura', 'FisioDemo', '10:00'],
      quickReplyPayloads: ['REMINDER_CONFIRM:1', 'REMINDER_CANCEL:1'],
      preview: '',
      previewButtons: [],
    });
    expect(payload).toMatchObject({
      type: 'template',
      template: {
        name: 'recordatorio_cita',
        language: { code: 'es' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Laura' },
              { type: 'text', text: 'FisioDemo' },
              { type: 'text', text: '10:00' },
            ],
          },
          { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'REMINDER_CONFIRM:1' }] },
          { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'REMINDER_CANCEL:1' }] },
        ],
      },
    });
  });
});

describe('live client', () => {
  it('posts to the configured Graph version and returns the wamid', async () => {
    const fetchFn = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      Response.json({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.123' }] }),
    );
    const client = createLiveWhatsAppClient({
      graphVersion: 'v27.0',
      logger: createSilentLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(client.sendText(account, '+34611111111', 'Hola')).resolves.toBe('wamid.123');
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v27.0/1234567890/messages');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer token');
  });

  it('retries with backoff on 5xx/429 and throttling codes', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls++;
      if (calls === 1) return Response.json({ error: { code: 130429, message: 'Rate limit hit' } }, { status: 400 });
      if (calls === 2) return new Response('oops', { status: 502 });
      return Response.json({ messages: [{ id: 'wamid.ok' }] });
    });
    const client = createLiveWhatsAppClient({
      graphVersion: 'v27.0',
      logger: createSilentLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      baseDelayMs: 1,
    });
    await expect(client.sendText(account, '+34611111111', 'Hola')).resolves.toBe('wamid.ok');
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('does not retry permanent errors (e.g. outside the 24 h window)', async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ error: { code: 131047, message: 'Re-engagement message' } }, { status: 400 }),
    );
    const client = createLiveWhatsAppClient({
      graphVersion: 'v27.0',
      logger: createSilentLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      baseDelayMs: 1,
    });
    await expect(client.sendText(account, '+34611111111', 'Hola')).rejects.toMatchObject({ code: 131047, retryable: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('marks messages as read', async () => {
    const fetchFn = vi.fn(async (..._args: Parameters<typeof fetch>) => Response.json({ success: true }));
    const client = createLiveWhatsAppClient({ graphVersion: 'v27.0', logger: createSilentLogger(), fetchFn: fetchFn as unknown as typeof fetch });
    await client.markAsRead(account, 'wamid.in');
    expect(JSON.parse(String(fetchFn.mock.calls[0]![1]?.body))).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.in',
    });
  });
});

describe('downloadMedia (F16)', () => {
  const MEDIA_URL = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1';
  const lookup = (fileSize = '5') =>
    Response.json({ messaging_product: 'whatsapp', url: MEDIA_URL, mime_type: 'audio/ogg', sha256: 'abc', file_size: fileSize, id: 'media-1' });
  const live = (responses: (() => Response)[]) => {
    const fetchFn = vi.fn(async (..._args: Parameters<typeof fetch>) => {
      const next = responses.shift();
      if (!next) throw new Error('unexpected request');
      return next();
    });
    const client = createLiveWhatsAppClient({ graphVersion: 'v27.0', logger: createSilentLogger(), fetchFn: fetchFn as unknown as typeof fetch });
    return { client, fetchFn };
  };

  it('gets the temporary URL and downloads the file, both with the access token', async () => {
    const { client, fetchFn } = live([() => lookup(), () => new Response(new Uint8Array([1, 2, 3, 4, 5]))]);
    const media = await client.downloadMedia(account, 'media-1', 1000);
    expect(media.mimeType).toBe('audio/ogg');
    expect([...media.data]).toEqual([1, 2, 3, 4, 5]);
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual(['https://graph.facebook.com/v27.0/media-1', MEDIA_URL]);
    for (const [, init] of fetchFn.mock.calls) expect(init?.headers).toEqual({ authorization: 'Bearer token' });
  });

  it('refuses files above the limit before downloading them', async () => {
    const { client, fetchFn } = live([() => lookup('2000')]);
    await expect(client.downloadMedia(account, 'media-1', 1000)).rejects.toBeInstanceOf(MediaTooLargeError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('asks for a new URL once when the download returns 404', async () => {
    const { client, fetchFn } = live([
      () => lookup(),
      () => new Response('gone', { status: 404 }),
      () => lookup(),
      () => new Response(new Uint8Array([9])),
    ]);
    await expect(client.downloadMedia(account, 'media-1', 1000)).resolves.toMatchObject({ mimeType: 'audio/ogg' });
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('only downloads from Meta, following redirects within Meta without the token (F34)', async () => {
    const outside = live([() => Response.json({ url: 'https://evil.example.com/a.ogg', mime_type: 'audio/ogg' })]);
    await expect(outside.client.downloadMedia(account, 'media-1', 1000)).rejects.toMatchObject({ name: 'WhatsAppApiError', retryable: false });
    expect(outside.fetchFn).toHaveBeenCalledTimes(1);
    expect(isMetaMediaUrl('http://lookaside.fbsbx.com/x')).toBe(false);
    expect(isMetaMediaUrl('https://fbsbx.com.evil.example/x')).toBe(false);

    const CDN = 'https://scontent.xx.fbcdn.net/v/audio.ogg?sig=1';
    const redirected = live([
      () => lookup(),
      () => new Response(null, { status: 302, headers: { location: CDN } }),
      () => new Response(new Uint8Array([7, 7])),
    ]);
    await expect(redirected.client.downloadMedia(account, 'media-1', 1000)).resolves.toMatchObject({ mimeType: 'audio/ogg' });
    expect(redirected.fetchFn.mock.calls.map(([url, init]) => [url, init?.headers])).toEqual([
      ['https://graph.facebook.com/v27.0/media-1', { authorization: 'Bearer token' }],
      [MEDIA_URL, { authorization: 'Bearer token' }],
      [CDN, {}],
    ]);

    const away = live([() => lookup(), () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } })]);
    await expect(away.client.downloadMedia(account, 'media-1', 1000)).rejects.toMatchObject({ retryable: false });
  });

  it('stops reading a download above the limit when Meta does not say the size (F34)', async () => {
    const noSize = () => Response.json({ url: MEDIA_URL, mime_type: 'audio/ogg', id: 'media-1' });
    const { client } = live([noSize, () => new Response(new Uint8Array(2000))]);
    await expect(client.downloadMedia(account, 'media-1', 1000)).rejects.toBeInstanceOf(MediaTooLargeError);
  });

  it('fails without retrying when the media id is unknown or expired', async () => {
    const { client } = live([() => Response.json({ error: { message: 'Unsupported get request' } }, { status: 400 })]);
    await expect(client.downloadMedia(account, 'media-1', 1000)).rejects.toMatchObject({ name: 'WhatsAppApiError', retryable: false });
  });
});

describe('mock client', () => {
  it('stores messages in memory', async () => {
    const echo = vi.fn();
    const client = createMockWhatsAppClient({ echo });
    await client.sendButtons(account, '+34611111111', '¿Seguro?', [{ id: 'Y', title: 'Sí' }]);
    expect(client.outbox).toHaveLength(1);
    expect(client.outbox[0]?.message.type).toBe('buttons');
    expect(echo).toHaveBeenCalled();
  });

  it('serves mock media carrying their content', async () => {
    const client = createMockWhatsAppClient();
    const media = await client.downloadMedia(account, mockMediaId('Quiero una cita'), 1000);
    expect(media.data.toString('utf8')).toBe('Quiero una cita');
    await expect(client.downloadMedia(account, mockMediaId('Quiero una cita'), 5)).rejects.toBeInstanceOf(MediaTooLargeError);
    await expect(client.downloadMedia(account, 'media-1', 1000)).rejects.toMatchObject({ status: 404 });
  });
});

describe('resolveWaAccount', () => {
  const tenant = (overrides: Partial<Tenant>): Tenant => ({
    id: 't',
    clinicName: 'C',
    phoneNormalized: null,
    waPhoneNumberId: 'pnid-1',
    waAccessTokenEnc: null,
    timezone: 'Europe/Madrid',
    publicSlug: null,
    settings: parseTenantSettings({}),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  const key = randomBytes(32).toString('base64');
  const config = loadConfig({
    DATABASE_URL: 'postgresql://x',
    WHATSAPP_MODE: 'live',
    LLM_MODE: 'mock',
    META_APP_SECRET: 's',
    VERIFY_TOKEN: 'v',
    META_JWT_TOKEN: 'global-token',
    ENCRYPTION_KEY: key,
  });

  it('uses the global token when the tenant has none', () => {
    expect(resolveWaAccount(tenant({}), config)).toEqual({ phoneNumberId: 'pnid-1', accessToken: 'global-token' });
  });

  it('decrypts the tenant token when present', () => {
    const enc = encryptSecret('tenant-token', key);
    expect(resolveWaAccount(tenant({ waAccessTokenEnc: enc }), config)?.accessToken).toBe('tenant-token');
  });
});
