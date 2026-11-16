/**
 * F34 — by WhatsApp a client books at most BOOKING_HORIZON_DAYS ahead: the date comes from the AI,
 * which could return any date. Clock: Tuesday 6 May 2025, 09:15 Madrid.
 */
import { createClient, createEmployee, createTenant, uniquePhone } from '@clinicai/db/testing';
import { describe, expect, it } from 'vitest';
import { createConversationEngine } from '../src/engine/engine';
import type { ParsedDate } from '../src/services/aiServices';
import { createMockAIService } from '../src/services/mockAi';
import { Chat, texts } from './chat';
import { createTestDeps, getTestDb } from './helpers';

async function chatParsing(parsed: ParsedDate) {
  const db = getTestDb();
  const deps = createTestDeps({ overrides: { ai: { ...createMockAIService(), parseDate: async () => parsed } } });
  const row = await createTenant(db, { clinicName: 'Fisio Lejos', settings: { contactPhone: '965 000 000' } });
  await createEmployee(db, row.id);
  const tenant = (await deps.systemRepos.tenants.findById(row.id))!;
  const phone = uniquePhone();
  await createClient(db, tenant.id, { name: 'Laura Martínez', phone });
  return new Chat(deps, createConversationEngine(deps), tenant, phone);
}

const TOO_FAR = 'Por WhatsApp puedo reservar hasta 6 meses vista. Dime una fecha más cercana o llámanos al 965 000 000 para algo más adelante.';

describe('F34 — booking horizon by WhatsApp', () => {
  it('refuses a date more than 6 months ahead, with or without time', async () => {
    for (const parsed of [
      { datetime: '2026-03-02T09:00:00.000Z', hasTime: true },
      { datetime: '2026-03-02T00:00:00.000Z', hasTime: false },
    ]) {
      const chat = await chatParsing(parsed);
      expect(texts(await chat.say('Quiero una cita el 2 de marzo de 2026')).at(-1), JSON.stringify(parsed)).toBe(TOO_FAR);
    }
  });

  it('accepts a date within 6 months', async () => {
    const chat = await chatParsing({ datetime: '2025-10-06T08:00:00.000Z', hasTime: true });
    expect(texts(await chat.say('Quiero una cita el 6 de octubre a las 10')).join('\n')).toMatch(/está disponible/);
  });
});
