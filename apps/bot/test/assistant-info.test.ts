/**
 * F29 — the assistant answers with the information the clinic filled in Settings (mock LLM, which
 * answers from the fields of the prompt); a text of its own uploaded as .txt takes priority.
 */
import { createClient, createTenant, uniquePhone } from '@clinicai/db/testing';
import { assistantInfoSchema } from '@clinicai/shared';
import { describe, expect, it } from 'vitest';
import { createConversationEngine } from '../src/engine/engine';
import { Chat, joined } from './chat';
import { createTestDeps, getTestDb } from './helpers';

describe('F29 — information for the assistant', () => {
  it('answers with the address and payments of the form, or with the uploaded text', async () => {
    const db = getTestDb();
    const deps = createTestDeps();
    const info = assistantInfoSchema.parse({ address: 'C/ Luna, 5, Elche', city: 'Elche', payments: 'Efectivo y Bizum' });
    const tenantRow = await createTenant(db, { clinicName: 'Fisio Luna', settings: { assistantInfo: info } });
    const phone = uniquePhone();
    await createClient(db, tenantRow.id, { phone });
    const tenant = (await deps.systemRepos.tenants.findById(tenantRow.id))!;
    const chat = new Chat(deps, createConversationEngine(deps), tenant, phone);

    expect(joined(await chat.say('¿Dónde estáis?'))).toContain('Estamos en c/ Luna, 5, Elche.');
    expect(joined(await chat.say('¿Puedo pagar con tarjeta?'))).toContain('Formas de pago: efectivo y Bizum.');

    // A text of its own replaces the form.
    await deps.systemRepos.tenants.update(tenant.id, { settings: { faqPrompt: 'Dirección: Plaza Mayor, 3\nTeléfono: 965 000 000' } });
    const custom = (await deps.systemRepos.tenants.findById(tenant.id))!;
    const other = new Chat(deps, createConversationEngine(deps), custom, phone);
    expect(joined(await other.say('¿Dónde estáis?'))).toContain('Estamos en plaza Mayor, 3.');
  });
});
