/**
 * F31 — usage counters written by the bot: messages received and sent (templates apart), seconds of
 * voice transcribed and AI tokens per model. Only numbers, per clinic and UTC day.
 */
import { randomUUID } from 'node:crypto';
import { runWithTenant } from '@clinicai/db';
import { createAppointment, createClient, createEmployee, createTenant, uniquePhone } from '@clinicai/db/testing';
import { zonedTimeToUtc } from '@clinicai/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConversationEngine } from '../src/engine/engine';
import { checkAndSendReminders } from '../src/jobs/reminders';
import { signMetaPayload } from '../src/webhook/meta';
import { Chat } from './chat';
import { APP_SECRET, createPipeline, createTestDeps, getTestDb, resetQueue, type TestDeps } from './helpers';
import { createMockTranscriber } from '../src/services/transcription';
import { llmUsageEntries } from '../src/services/usage';

/** Counters of a clinic as `metric/model → amount`. */
async function counters(tenantId: string): Promise<Record<string, number>> {
  const rows = await getTestDb().usageDaily.findMany({ where: { tenantId } });
  return Object.fromEntries(rows.map((r) => [r.model ? `${r.metric}/${r.model}` : r.metric, Number(r.amount)]));
}

function textPayload(phoneNumberId: string, text: string, from: string): string {
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

let closers: (() => Promise<unknown>)[] = [];
beforeEach(async () => {
  await resetQueue();
});
afterEach(async () => {
  await Promise.all(closers.map((c) => c()));
  closers = [];
});

describe('usage counters (F31)', () => {
  it('count the messages received and the replies sent through the queue', async () => {
    const deps = createTestDeps();
    const tenant = await createTenant(getTestDb());
    const { app, flush } = createPipeline(deps, createConversationEngine(deps));
    closers.push(() => app.close());
    const from = uniquePhone().slice(1);
    for (const text of ['Hola', 'Quiero una cita']) {
      const body = textPayload(tenant.waPhoneNumberId!, text, from);
      const res = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMetaPayload(body, APP_SECRET) },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
    }
    await flush();
    const sent = deps.whatsapp.outbox.filter((e) => e.message.type !== 'template').length;
    expect(sent).toBeGreaterThan(0);
    expect(await counters(tenant.id)).toEqual({ 'whatsapp.inbound': 2, 'whatsapp.outbound': sent });
  });

  it('count reminders as templates', async () => {
    const db = getTestDb();
    const deps = createTestDeps();
    const tenant = await createTenant(db);
    const employee = await createEmployee(db, tenant.id);
    const client = await createClient(db, tenant.id);
    await createAppointment(db, {
      tenantId: tenant.id,
      clientId: client.id,
      employeeId: employee.id,
      date: zonedTimeToUtc({ year: 2025, month: 5, day: 7, hour: 10 }, 'Europe/Madrid'),
    });
    expect(await checkAndSendReminders(deps, { tenantId: tenant.id })).toMatchObject({ sent: 1 });
    await deps.background.idle();
    expect(await counters(tenant.id)).toEqual({ 'whatsapp.template': 1 });
  });

  it('count the seconds of voice transcribed', async () => {
    const db = getTestDb();
    const deps = createTestDeps({ overrides: { transcriber: createMockTranscriber() } });
    const tenantRow = await createTenant(db);
    const tenant = (await deps.systemRepos.tenants.findById(tenantRow.id))!;
    const phone = uniquePhone();
    await createClient(db, tenant.id, { phone });
    await new Chat(deps, createConversationEngine(deps), tenant, phone).voice('¿Qué horario tenéis?');
    await deps.background.idle();
    const c = await counters(tenant.id);
    expect(c['transcription.seconds/mock']).toBeGreaterThanOrEqual(1);
  });

  it('count AI requests and tokens per model, for the clinic of the context only', async () => {
    const deps: TestDeps = createTestDeps();
    const tenant = await createTenant(getTestDb());
    const usage = { provider: 'openai', model: 'gpt-4o-mini', promptTokens: 120, completionTokens: 2 };
    deps.usage.record(llmUsageEntries(usage)); // no clinic: not counted
    await runWithTenant(tenant.id, async () => {
      deps.usage.record(llmUsageEntries(usage));
      deps.usage.record(llmUsageEntries(usage));
    });
    await deps.background.idle();
    expect(await counters(tenant.id)).toEqual({
      'llm.requests/gpt-4o-mini': 2,
      'llm.prompt_tokens/gpt-4o-mini': 240,
      'llm.completion_tokens/gpt-4o-mini': 4,
    });
  });
});
