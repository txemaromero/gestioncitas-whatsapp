/**
 * Spanish date expressions with a fixed clock: Tuesday 6 May 2025, 09:15 (Europe/Madrid).
 * Runs against the rule-based mock always, and against the real provider when
 * LLM_LIVE_TESTS=true (needs OPENAI_API_KEY or DEEPSEEK_API_KEY in the environment).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { createSilentLogger } from '../logger';
import { createAIService, type AIService } from './aiServices';
import { createMockAIService, ruleBasedFaq, ruleBasedIntent } from './mockAi';

const NOW = new Date('2025-05-06T07:15:00Z'); // martes 6 may 2025 09:15 +02:00
const TZ = 'Europe/Madrid';

const CASES: [string, string | null, boolean][] = [
  ['mañana a las 10', '2025-05-07T10:00:00+02:00', true],
  ['Podría ser pasado mañana a las 12?', '2025-05-08T12:00:00+02:00', true],
  ['pasado mañana a las 12', '2025-05-08T12:00:00+02:00', true],
  ['hoy a las 11 y media', '2025-05-06T11:30:00+02:00', true],
  ['hoy a las 17:30', '2025-05-06T17:30:00+02:00', true],
  ['el lunes a las 5 de la tarde', '2025-05-12T17:00:00+02:00', true],
  ['el próximo lunes a las 9', '2025-05-12T09:00:00+02:00', true],
  ['el martes a las 9', '2025-05-13T09:00:00+02:00', true],
  ['el miércoles a las 10', '2025-05-07T10:00:00+02:00', true],
  ['el jueves que viene a las 18h', '2025-05-08T18:00:00+02:00', true],
  ['el viernes 16 a las 18:30', '2025-05-16T18:30:00+02:00', true],
  ['el sábado a las doce', '2025-05-10T12:00:00+02:00', true],
  ['el domingo a las 10 de la mañana', '2025-05-11T10:00:00+02:00', true],
  ['el 15 de marzo a las 10', '2026-03-15T10:00:00+01:00', true],
  ['el 20 de mayo a las 16:00', '2025-05-20T16:00:00+02:00', true],
  ['el 3/6 a las 10', '2025-06-03T10:00:00+02:00', true],
  ['el día 9 a las 8', '2025-05-09T08:00:00+02:00', true],
  ['a las 8', '2025-05-07T08:00:00+02:00', true],
  ['a las 10', '2025-05-06T10:00:00+02:00', true],
  ['mañana a las 11 menos cuarto', '2025-05-07T10:45:00+02:00', true],
  ['mañana a las 8 de la noche', '2025-05-07T20:00:00+02:00', true],
  ['mañana a las 4', '2025-05-07T16:00:00+02:00', true],
  ['mañana por la tarde', '2025-05-07T00:00:00+02:00', false],
  ['mañana por la mañana', '2025-05-07T00:00:00+02:00', false],
  ['el lunes', '2025-05-12T00:00:00+02:00', false],
  ['dentro de 3 días a las 12', '2025-05-09T12:00:00+02:00', true],
  ['el 1 de noviembre a las 10', '2025-11-01T10:00:00+01:00', true],
  ['quiero una cita, por favor', null, false],
  ['por la tarde', null, false],
];

describe('parseDate (rule-based mock, fixed clock)', () => {
  const ai = createMockAIService();
  it.each(CASES)('%s', async (text, datetime, hasTime) => {
    await expect(ai.parseDate(text, NOW, TZ)).resolves.toEqual({ datetime, hasTime });
  });
});

describe.runIf(process.env.LLM_LIVE_TESTS === 'true')('parseDate (live LLM)', () => {
  let ai: AIService;
  beforeAll(() => {
    ai = createAIService(
      loadConfig({ DATABASE_URL: 'postgresql://unused', ...process.env, LLM_MODE: 'live', WHATSAPP_MODE: 'mock' }),
      createSilentLogger(),
    );
  });
  it.each(CASES)('%s', async (text, datetime, hasTime) => {
    const result = await ai.parseDate(text, NOW, TZ);
    expect(result.hasTime).toBe(hasTime);
    if (datetime === null) expect(result.datetime).toBeNull();
    else expect(new Date(result.datetime ?? '').toISOString()).toBe(new Date(datetime).toISOString());
  }, 30_000);
});

describe('rule-based intent (mock)', () => {
  it.each([
    ['Hola, quiero cita para mañana', 'CITA'],
    ['¿Tenéis hueco el jueves?', 'CITA'],
    ['Necesito un fisio para la rodilla', 'CITA'],
    ['No podré ir el jueves, ¿puedo cambiarla?', 'CITA'],
    ['Podría ser pasado mañana a las 12?', 'CITA'],
    ['¿Cómo puedo cancelar una cita?', 'FAQ'],
    ['Quiero confirmar mi cita', 'FAQ'],
    ['¿Qué horario tenéis?', 'FAQ'],
    ['¿Aceptáis tarjeta?', 'FAQ'],
    ['Gracias!', 'FAQ'],
  ])('%s → %s', (text, expected) => {
    expect(ruleBasedIntent(text)).toBe(expected);
  });
});

describe('rule-based FAQ (mock)', () => {
  const prompt = [
    'Actúas como recepcionista virtual de FisioDemo.',
    'Dirección: C/ Mayor, 1, Alicante',
    'Teléfono: 965 000 000',
    'Horario: lunes a viernes, de 7:00 a 20:00',
    'Pagos: Aceptamos efectivo y tarjeta',
    '',
    'Servicios y tratamientos:',
    '- Osteopatía',
    '- Presoterapia',
  ].join('\n');

  it('answers from the tenant prompt data', () => {
    expect(ruleBasedFaq(prompt, '¿Qué horario tenéis?')).toBe('Nuestro horario es: lunes a viernes, de 7:00 a 20:00.');
    expect(ruleBasedFaq(prompt, '¿Dónde estáis?')).toBe('Estamos en c/ Mayor, 1, Alicante.');
    expect(ruleBasedFaq(prompt, '¿Qué servicios ofrecéis?')).toBe('Ofrecemos: osteopatía, presoterapia.');
    expect(ruleBasedFaq(prompt, '¿Se puede ir con perro?')).toBe('No estoy seguro, mejor llama al 965 000 000.');
  });
});
