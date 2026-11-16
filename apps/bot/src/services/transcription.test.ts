import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { createSilentLogger } from '../logger';
import {
  TRANSCRIPTION_PROMPT,
  TranscriptionError,
  createOpenAITranscriber,
  createTranscriber,
  transcribableExtension,
} from './transcription';

const env = { DATABASE_URL: 'postgresql://x', WHATSAPP_MODE: 'mock', META_APP_SECRET: 's', VERIFY_TOKEN: 'v' };
const audio = Buffer.from([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]);

function openAI(model: string, response: () => Response) {
  const fetchFn = vi.fn(async (..._args: Parameters<typeof fetch>) => response());
  const transcriber = createOpenAITranscriber({
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1/',
    model,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { fetchFn, transcriber };
}

describe('OpenAI transcriber', () => {
  it('sends the audio as multipart with the model and a Spanish context prompt', async () => {
    const { fetchFn, transcriber } = openAI('gpt-transcribe', () => Response.json({ text: '  Quiero una cita el lunes. ' }));
    await expect(transcriber.transcribe(audio, 'audio/ogg; codecs=opus')).resolves.toBe('Quiero una cita el lunes.');
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ authorization: 'Bearer sk-test' });
    const form = init?.body as FormData;
    expect(form.get('model')).toBe('gpt-transcribe');
    expect(form.get('prompt')).toBe(TRANSCRIPTION_PROMPT);
    // gpt-transcribe rejects `language` (it uses `languages`): nothing is sent, it detects Spanish.
    expect(form.has('language')).toBe(false);
    const file = form.get('file') as File;
    expect(file.name).toBe('nota-de-voz.ogg');
    expect(file.type).toBe('audio/ogg');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(audio);
  });

  it('tells older models the language', async () => {
    const { fetchFn, transcriber } = openAI('gpt-4o-mini-transcribe', () => Response.json({ text: 'Hola' }));
    await transcriber.transcribe(audio, 'audio/mpeg');
    const form = fetchFn.mock.calls[0]![1]?.body as FormData;
    expect(form.get('language')).toBe('es');
    expect((form.get('file') as File).name).toBe('nota-de-voz.mp3');
  });

  it('fails on API errors, invalid answers and unsupported formats', async () => {
    await expect(openAI('gpt-transcribe', () => new Response('quota', { status: 429 })).transcriber.transcribe(audio, 'audio/ogg')).rejects.toMatchObject({
      name: 'TranscriptionError',
      status: 429,
    });
    await expect(openAI('gpt-transcribe', () => Response.json({ foo: 1 })).transcriber.transcribe(audio, 'audio/ogg')).rejects.toBeInstanceOf(
      TranscriptionError,
    );
    const amr = openAI('gpt-transcribe', () => Response.json({ text: 'x' }));
    await expect(amr.transcriber.transcribe(audio, 'audio/amr')).rejects.toThrow('Unsupported audio type');
    expect(amr.fetchFn).not.toHaveBeenCalled();
  });

  it('maps WhatsApp audio types to the formats OpenAI accepts', () => {
    expect(transcribableExtension('audio/ogg; codecs=opus')).toBe('ogg');
    expect(transcribableExtension('audio/mp4')).toBe('m4a');
    expect(transcribableExtension('audio/aac')).toBeNull();
    expect(transcribableExtension('audio/amr')).toBeNull();
  });
});

describe('createTranscriber', () => {
  const logger = createSilentLogger();

  it('uses the mock transcriber with LLM_MODE=mock', async () => {
    const transcriber = createTranscriber(loadConfig({ ...env, LLM_MODE: 'mock' }), logger);
    expect(transcriber?.mode).toBe('mock');
    await expect(transcriber!.transcribe(Buffer.from(' Hola ', 'utf8'), 'audio/ogg')).resolves.toBe('Hola');
  });

  it('uses OpenAI in live mode when there is a key', () => {
    expect(createTranscriber(loadConfig({ ...env, LLM_MODE: 'live', OPENAI_API_KEY: 'sk-test' }), logger)?.mode).toBe('live');
  });

  it('is disabled by configuration or without an OpenAI key (DeepSeek does not transcribe)', () => {
    expect(createTranscriber(loadConfig({ ...env, LLM_MODE: 'mock', VOICE_NOTES: 'false' }), logger)).toBeNull();
    const deepseekOnly = loadConfig({ ...env, LLM_MODE: 'live', AI_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'dk' });
    expect(createTranscriber(deepseekOnly, logger)).toBeNull();
  });
});
