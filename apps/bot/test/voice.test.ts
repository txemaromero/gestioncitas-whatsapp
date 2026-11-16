/**
 * F16 — voice notes: transcribed (never stored), echoed back and handled like written messages;
 * nothing is processed before the privacy notice is accepted.
 */
import { createClient, createEmployee, createTenant, uniquePhone } from '@clinicai/db/testing';
import type { ScheduleSlot } from '@clinicai/shared';
import { describe, expect, it, vi } from 'vitest';
import { createConversationEngine, type EngineObserver } from '../src/engine/engine';
import { T } from '../src/engine/texts';
import type { IncomingMessage } from '../src/engine/types';
import { createMockTranscriber, type Transcriber } from '../src/services/transcription';
import { Chat, joined, texts } from './chat';
import { createTestDeps, getTestDb } from './helpers';
import { fakeOgg } from './ogg';

const WEEKDAYS_9_14: ScheduleSlot[] = (['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const).map((day) => ({
  day,
  start: '09:00',
  end: '14:00',
}));
const FAQ_PROMPT = ['Actúas como recepcionista virtual de Fisio Test.', 'Horario: lunes a viernes, de 9:00 a 14:00'].join('\n');

function spyTranscriber(impl?: Transcriber['transcribe']) {
  const mock = createMockTranscriber();
  return { mode: 'mock' as const, transcribe: vi.fn(impl ?? mock.transcribe) };
}

async function setup(
  options: { transcriber?: Transcriber | null; config?: Record<string, string>; observer?: EngineObserver } = {},
) {
  const db = getTestDb();
  const transcriber = options.transcriber === undefined ? spyTranscriber() : options.transcriber;
  const deps = createTestDeps({ ...(options.config ? { config: options.config } : {}), overrides: { transcriber } });
  const tenantRow = await createTenant(db, { clinicName: 'Fisio Test', settings: { faqPrompt: FAQ_PROMPT, slotMinutes: 60 } });
  await createEmployee(db, tenantRow.id, { name: 'Ana', schedule: WEEKDAYS_9_14 });
  const tenant = (await deps.systemRepos.tenants.findById(tenantRow.id))!;
  const engine = createConversationEngine(deps, options.observer);
  const registered = async () => {
    const phone = uniquePhone();
    await createClient(db, tenant.id, { name: 'Laura Martínez', phone });
    return new Chat(deps, engine, tenant, phone);
  };
  return { db, deps, tenant, transcriber, registered, newChat: () => new Chat(deps, engine, tenant, uniquePhone()) };
}

describe('F16 — voice notes', () => {
  it('transcribes a voice note, echoes what it understood and answers it like a written message', async () => {
    const ctx = await setup();
    const chat = await ctx.registered();
    const replies = texts(await chat.voice('¿Qué horario tenéis?'));
    expect(replies[0]).toBe('🎤 He entendido: «¿Qué horario tenéis?»');
    expect(replies.join('\n')).toContain('Nuestro horario es: lunes a viernes, de 9:00 a 14:00.');
  });

  it('follows the conversation in progress (escape words included)', async () => {
    const ctx = await setup();
    const chat = await ctx.registered();
    expect(joined(await chat.say('Quiero pedir una cita'))).toContain('Por favor, indícame la fecha para tu cita en Fisio Test');
    expect(joined(await chat.voice('Cancelar'))).toBe(`🎤 He entendido: «Cancelar»\n${T.bookingCancelled}`);
    expect(await ctx.deps.systemRepos.conversations.get(ctx.tenant.id, chat.phone, ctx.deps.clock.now())).toBeNull();
  });

  it('shortens very long transcripts in the echo', async () => {
    const ctx = await setup();
    const chat = await ctx.registered();
    const [echo] = texts(await chat.voice(`Hola, ${'quería comentaros una cosa '.repeat(20)}`));
    expect(echo!.length).toBeLessThanOrEqual('🎤 He entendido: «»'.length + 300);
    expect(echo).toMatch(/…»$/);
  });

  it('does not listen to anything before the privacy notice is accepted (GDPR)', async () => {
    const ctx = await setup();
    const chat = ctx.newChat();
    expect(joined(await chat.voice('Hola, soy Laura'))).toBe(T.voiceNeedsConsent);
    expect(ctx.transcriber!.transcribe).not.toHaveBeenCalled();
    expect(await ctx.deps.systemRepos.clients.findByPhone(ctx.tenant.id, chat.phone)).toBeNull();

    const pending = ctx.newChat();
    await createClient(ctx.db, ctx.tenant.id, { phone: pending.phone, consent: false });
    expect(joined(await pending.voice('Hola'))).toBe(T.voiceNeedsConsent);
    expect(ctx.transcriber!.transcribe).not.toHaveBeenCalled();
  });

  it('asks for a shorter note when it is too long (Ogg duration or file size)', async () => {
    const ctx = await setup();
    const chat = await ctx.registered();
    expect(joined(await chat.voice(fakeOgg(150)))).toBe(
      'Tu nota de voz es un poco larga 🙏. ¿Puedes enviarla de 2 minutos como máximo, o escribirme lo que necesitas?',
    );
    expect(ctx.transcriber!.transcribe).not.toHaveBeenCalled();

    const short = await setup({ config: { VOICE_MAX_SECONDS: '10' }, transcriber: spyTranscriber(async () => 'Hola') });
    const other = await short.registered();
    expect(joined(await other.voice(Buffer.alloc(400_000, 1), 'audio/mpeg'))).toBe(T.voiceTooLong(1));
    expect(joined(await other.voice(fakeOgg(9.5)))).toContain('🎤 He entendido:');
  });

  it('asks to write when the note cannot be transcribed, keeping the conversation state', async () => {
    const ctx = await setup({
      transcriber: spyTranscriber(async () => {
        throw new Error('OpenAI transcription 503');
      }),
    });
    const chat = await ctx.registered();
    await chat.say('Quiero pedir una cita');
    expect(joined(await chat.voice('El lunes a las 10'))).toBe(T.voiceUnavailable);
    expect(await ctx.deps.systemRepos.conversations.get(ctx.tenant.id, chat.phone, ctx.deps.clock.now())).toMatchObject({ flow: 'cita' });
  });

  it('answers unsupported formats, silent notes and disabled transcription', async () => {
    const ctx = await setup();
    const chat = await ctx.registered();
    expect(joined(await chat.voice('Hola', 'audio/amr'))).toBe(T.voiceUnavailable);
    expect(joined(await chat.voice('   '))).toBe(T.voiceEmpty);

    const disabled = await setup({ transcriber: null });
    expect(joined(await (await disabled.registered()).voice('Hola'))).toBe(T.voiceUnavailable);
  });

  it('logs the length of the transcript but never its content', async () => {
    const ctx = await setup();
    const chat = await ctx.registered();
    const info = vi.spyOn(ctx.deps.logger, 'info');
    await chat.voice('Me llamo Laura y mi DNI es 12345678Z');
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain('voice note transcribed');
    expect(logged).not.toContain('12345678Z');
  });

  it('paused contacts get no answer, but the Chatwoot mirror receives the transcript', async () => {
    const seen: IncomingMessage[] = [];
    const ctx = await setup({ observer: { onIncoming: (_tenant, message) => seen.push(message) } });
    const chat = await ctx.registered();
    await ctx.deps.systemRepos.blacklist.add(ctx.tenant.id, chat.phone, 'agent');
    expect(await chat.voice('Necesito hablar con alguien')).toEqual([]);
    expect(seen[0]).toMatchObject({ type: 'text', text: 'Necesito hablar con alguien', transcribed: true });
  });
});
