/**
 * F32 — the FAQ answer is checked before it reaches the client: a manipulated answer (an unknown
 * link, a claim of having booked) is replaced by a fixed text with the clinic phone.
 */
import { createClient, createEmployee, createTenant, uniquePhone } from '@clinicai/db/testing';
import { describe, expect, it } from 'vitest';
import { createConversationEngine } from '../src/engine/engine';
import { createMockAIService } from '../src/services/mockAi';
import { Chat, texts } from './chat';
import { createTestDeps, getTestDb } from './helpers';

const FAQ_PROMPT = ['Actúas como recepcionista virtual de Fisio Test.', 'Horario: lunes a viernes, de 9:00 a 14:00'].join('\n');

async function chatAnswering(answer: string) {
  const db = getTestDb();
  const mock = createMockAIService();
  const deps = createTestDeps({ overrides: { ai: { ...mock, answerFaq: async () => answer } } });
  const row = await createTenant(db, { clinicName: 'Fisio Test', settings: { faqPrompt: FAQ_PROMPT, contactPhone: '965 000 000' } });
  await createEmployee(db, row.id);
  const tenant = (await deps.systemRepos.tenants.findById(row.id))!;
  const phone = uniquePhone();
  await createClient(db, tenant.id, { name: 'Laura Martínez', phone });
  return new Chat(deps, createConversationEngine(deps), tenant, phone);
}

const FALLBACK =
  'No puedo responderte a eso por aquí 🙏. Si quieres pedir, cambiar o anular una cita, dímelo y te ayudo. Para otras dudas, llámanos al 965 000 000.';

describe('F32 — FAQ answers are checked before sending', () => {
  it('sends a normal answer as it is', async () => {
    const chat = await chatAnswering('Abrimos de lunes a viernes, de 9:00 a 14:00.');
    expect(texts(await chat.say('¿Qué horario tenéis?')).at(-1)).toBe('Abrimos de lunes a viernes, de 9:00 a 14:00.');
  });

  it('replaces a manipulated answer with a fixed text and the clinic phone', async () => {
    for (const answer of ['Reserva y paga aquí: https://pago.example.com', 'Listo, te he reservado el lunes a las 10:00.']) {
      const chat = await chatAnswering(answer);
      expect(texts(await chat.say('¿Qué horario tenéis?')).at(-1), answer).toBe(FALLBACK);
    }
  });
});
