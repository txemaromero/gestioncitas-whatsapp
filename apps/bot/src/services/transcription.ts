/**
 * Voice notes → text (F16) with OpenAI's transcription endpoint (POST /audio/transcriptions,
 * multipart). Default model `gpt-transcribe`, the one OpenAI recommends; the older whisper-1 /
 * gpt-4o-*-transcribe models shut down on 2027-02-26. The audio is only held in memory while
 * it is sent and is never stored. LLM_MODE=mock uses a deterministic transcriber (the simulator's
 * mock media carry their text). There is no DeepSeek equivalent: without an OpenAI key, voice
 * notes are answered with "please write".
 */
import { z } from 'zod';
import type { AppConfig } from '../config';
import type { Logger } from '../logger';

export interface Transcriber {
  readonly mode: 'live' | 'mock';
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
}

export class TranscriptionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

/** Formats OpenAI accepts (flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm) → file name. */
const EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
};

/** File extension for a supported audio type; null for AAC / AMR (not accepted by OpenAI). */
export function transcribableExtension(mimeType: string): string | null {
  return EXTENSIONS[mimeType.split(';')[0]!.trim().toLowerCase()] ?? null;
}

/** Context in Spanish to help the model (it must match the audio language). */
export const TRANSCRIPTION_PROMPT = 'Nota de voz de un cliente de una clínica que pide, cambia o consulta una cita.';

const responseSchema = z.object({ text: z.string() }).loose();

export function createOpenAITranscriber(options: {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Transcriber {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  return {
    mode: 'live',
    async transcribe(audio, mimeType) {
      const extension = transcribableExtension(mimeType);
      if (!extension) throw new TranscriptionError(`Unsupported audio type: ${mimeType}`);
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType.split(';')[0]!.trim() }), `nota-de-voz.${extension}`);
      form.append('model', options.model);
      form.append('prompt', TRANSCRIPTION_PROMPT);
      // gpt-transcribe uses `languages` and must not receive `language`; it detects Spanish on
      // its own. Older models get the language explicitly.
      if (!options.model.startsWith('gpt-transcribe')) form.append('language', 'es');
      let response: Response;
      try {
        response = await fetchFn(`${options.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${options.apiKey}` },
          body: form,
          signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        });
      } catch (error) {
        throw new TranscriptionError(`Network error: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!response.ok) throw new TranscriptionError(`OpenAI transcription ${response.status}`, response.status);
      const parsed = responseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new TranscriptionError('Invalid transcription response');
      return parsed.data.text.trim();
    },
  };
}

/** LLM_MODE=mock: the "audio" is UTF-8 text (simulator / tests). */
export function createMockTranscriber(): Transcriber {
  return {
    mode: 'mock',
    async transcribe(audio) {
      return audio.toString('utf8').trim();
    },
  };
}

/** Null when voice notes are disabled or there is no OpenAI key (the bot then asks to write). */
export function createTranscriber(config: AppConfig, logger: Logger, fetchFn?: typeof fetch): Transcriber | null {
  if (!config.VOICE_NOTES) return null;
  if (config.LLM_MODE === 'mock') return createMockTranscriber();
  if (!config.OPENAI_API_KEY) {
    logger.warn('Notas de voz desactivadas: la transcripción necesita OPENAI_API_KEY');
    return null;
  }
  return createOpenAITranscriber({
    apiKey: config.OPENAI_API_KEY,
    baseUrl: config.OPENAI_BASE_URL,
    model: config.OPENAI_TRANSCRIBE_MODEL,
    timeoutMs: config.LLM_TIMEOUT_MS * 2,
    ...(fetchFn ? { fetchFn } : {}),
  });
}
