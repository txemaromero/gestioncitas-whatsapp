/**
 * F17 — waiting list by WhatsApp: joining when there is no slot, the offer template when someone
 * cancels, booking or declining it (buttons or «sí» / «no»), and the job / route.
 */
import { createAppointment, createClient, createEmployee, createTenant, uniquePhone } from '@clinicai/db/testing';
import { zonedTimeToUtc, type ScheduleSlot } from '@clinicai/shared';
import { describe, expect, it } from 'vitest';
import { requestWaitlistCheck } from '@clinicai/db';
import { buildApp } from '../src/app';
import { createConversationEngine } from '../src/engine/engine';
import { T } from '../src/engine/texts';
import type { OutgoingMessage } from '../src/engine/types';
import { WAITLIST_BOOK, WAITLIST_JOIN, WAITLIST_SKIP } from '../src/flows/waitlistFlow';
import { registerJobRoutes } from '../src/jobs/routes';
import { processWaitlist } from '../src/jobs/waitlist';
import { createInboundEventHandler } from '../src/queue/handler';
import type { WhatsAppClient } from '../src/services/whatsapp';
import { Chat, joined } from './chat';
import { CRON_SECRET, createTestDeps, getTestDb, type TestDeps } from './helpers';

const TZ = 'Europe/Madrid';
// The test clock is Tuesday 2025-05-06 09:15 (Madrid); Monday 12 May has two slots, 9:00 and 10:00.
const monday = (h: number) => zonedTimeToUtc({ year: 2025, month: 5, day: 12, hour: h, minute: 0 }, TZ);
const MONDAY_9_11: ScheduleSlot[] = [{ day: 'monday', start: '09:00', end: '11:00' }];
const DAY = 'el lunes, 12 de mayo de 2025';

/** Ids of the buttons / rows of every interactive message of a turn. */
const ids = (messages: OutgoingMessage[]) =>
  messages.flatMap((m) => (m.type === 'buttons' ? m.buttons.map((b) => b.id) : m.type === 'list' ? m.sections.flatMap((s) => s.rows.map((r) => r.id)) : []));

async function setup(options: { waitlistEnabled?: boolean; whatsapp?: TestDeps['whatsapp'] } = {}) {
  const db = getTestDb();
  const deps = createTestDeps(options.whatsapp ? { overrides: { whatsapp: options.whatsapp } } : {});
  const tenantRow = await createTenant(db, {
    clinicName: 'Fisio Test',
    settings: { slotMinutes: 60, contactPhone: '965 000 000', waitlistEnabled: options.waitlistEnabled ?? true },
  });
  const ana = await createEmployee(db, tenantRow.id, { name: 'Ana', schedule: MONDAY_9_11 });
  const tenant = (await deps.systemRepos.tenants.findById(tenantRow.id))!;
  const engine = createConversationEngine(deps);
  const person = async (name: string) => {
    const phone = uniquePhone();
    const client = await createClient(db, tenant.id, { name, phone });
    return { client, chat: new Chat(deps, engine, tenant, phone) };
  };
  // Pablo has both Monday slots.
  const pablo = await person('Pablo Ruiz');
  const base = { tenantId: tenant.id, clientId: pablo.client.id, employeeId: ana.id };
  const at9 = await createAppointment(db, { ...base, date: monday(9) });
  const at10 = await createAppointment(db, { ...base, date: monday(10) });
  /** Messages sent to a phone since `from` (the offer template arrives outside the turn). */
  const inbox = (phone: string, from = 0) => deps.whatsapp.outbox.slice(from).filter((e) => e.to === phone).map((e) => e.message);
  return { db, deps, tenant, ana, person, pablo, at9, at10, inbox };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** A client asks for Monday at 9:00 and joins the waiting list from the button. */
async function waitFor(ctx: Ctx, name: string) {
  const who = await ctx.person(name);
  const replies = await who.chat.say('Quiero una cita el 12 de mayo a las 9');
  const join = ids(replies).find((id) => id.startsWith(WAITLIST_JOIN));
  if (!join) throw new Error(`no waiting list button: ${joined(replies)}`);
  const answer = joined(await who.chat.press(join, T.waitlistButton));
  return { ...who, answer };
}

function offerTo(ctx: Ctx, phone: string) {
  const offer = ctx.inbox(phone).find((m) => m.type === 'template');
  if (!offer || offer.type !== 'template') throw new Error('no offer received');
  return offer;
}

describe('F17 — joining the waiting list', () => {
  it('offers to wait for the whole day when it is full', async () => {
    const ctx = await setup();
    const laura = await ctx.person('Laura Martínez');
    const replies = await laura.chat.say('Quiero una cita el 12 de mayo a las 9');
    expect(joined(replies)).toContain('Lo siento');
    const button = replies.at(-1);
    expect(button).toEqual({
      type: 'buttons',
      body: T.waitlistAskDay,
      buttons: [{ id: `${WAITLIST_JOIN}${monday(9).toISOString()}`, title: '🔔 Avisarme' }],
    });
    expect(joined(await laura.chat.press(`${WAITLIST_JOIN}${monday(9).toISOString()}`, T.waitlistButton))).toBe(T.waitlistJoined(DAY));
    expect(joined(await laura.chat.press(`${WAITLIST_JOIN}${monday(9).toISOString()}`, T.waitlistButton))).toBe(T.waitlistAlready(DAY));
  });

  it('waits only for the requested time when other times that day are free', async () => {
    const ctx = await setup();
    await ctx.db.appointment.update({ where: { id: ctx.at10.id }, data: { status: 'cancelled' } });
    const laura = await ctx.person('Laura Martínez');
    const replies = await laura.chat.say('Quiero una cita el 12 de mayo a las 9');
    expect(replies.at(-1)).toMatchObject({ type: 'buttons', body: T.waitlistAskTime('09:00') });
    expect(joined(await laura.chat.press(`${WAITLIST_JOIN}${monday(9).toISOString()}`, T.waitlistButton))).toBe(
      T.waitlistJoined(`${DAY} a las 09:00`),
    );
  });

  it('is not offered when the clinic has it disabled', async () => {
    const ctx = await setup({ waitlistEnabled: false });
    const laura = await ctx.person('Laura Martínez');
    const replies = await laura.chat.say('Quiero una cita el 12 de mayo a las 9');
    expect(ids(replies).some((id) => id.startsWith(WAITLIST_JOIN))).toBe(false);
    expect(joined(await laura.chat.press(`${WAITLIST_JOIN}${monday(9).toISOString()}`, T.waitlistButton))).toBe(T.waitlistUnavailable);
  });
});

describe('F17 — offers when a slot frees up', () => {
  it('a cancellation by WhatsApp offers the slot to the first client, who books it', async () => {
    const ctx = await setup();
    const laura = await waitFor(ctx, 'Laura Martínez');
    const marta = await waitFor(ctx, 'Marta Gil');
    expect(laura.answer).toBe(T.waitlistJoined(DAY));

    // Pablo cancels his 10:00 from the reminder: the slot is offered at once, to Laura only.
    expect(joined(await ctx.pablo.chat.templateReply(`REMINDER_CANCEL:${ctx.at10.id}`, 'No puedo asistir'))).toBe(T.reminderCancelled);
    const offer = offerTo(ctx, laura.chat.phone);
    const entry = await ctx.db.waitlistEntry.findFirstOrThrow({ where: { clientId: laura.client.id } });
    expect(offer).toMatchObject({
      name: 'aviso_hueco_libre',
      language: 'es',
      bodyParams: ['Laura', 'Fisio Test', 'lunes, 12 de mayo de 2025, 10:00', '30'],
      quickReplyPayloads: [`${WAITLIST_BOOK}${entry.id}`, `${WAITLIST_SKIP}${entry.id}`],
      previewButtons: ['Reservar', 'No, gracias'],
    });
    expect(ctx.inbox(marta.chat.phone).some((m) => m.type === 'template')).toBe(false);

    expect(joined(await laura.chat.templateReply(`${WAITLIST_BOOK}${entry.id}`, 'Reservar'))).toBe(
      T.waitlistBooked('Fisio Test', 'lunes, 12 de mayo de 2025, 10:00', 'Ana'),
    );
    const booked = await ctx.db.appointment.findFirstOrThrow({ where: { clientId: laura.client.id } });
    expect(booked).toMatchObject({ date: monday(10), status: 'pending', source: 'whatsapp', employeeId: ctx.ana.id });
    // A second tap does not book twice.
    expect(joined(await laura.chat.templateReply(`${WAITLIST_BOOK}${entry.id}`, 'Reservar'))).toBe(T.waitlistClosed);
  });

  it('declining passes the slot to the next client straight away', async () => {
    const ctx = await setup();
    const laura = await waitFor(ctx, 'Laura Martínez');
    const marta = await waitFor(ctx, 'Marta Gil');
    await ctx.pablo.chat.templateReply(`REMINDER_CANCEL:${ctx.at9.id}`, 'No puedo asistir');
    const [, skip] = offerTo(ctx, laura.chat.phone).quickReplyPayloads;
    expect(joined(await laura.chat.templateReply(skip!, 'No, gracias'))).toBe(T.waitlistLeft(DAY));
    expect(offerTo(ctx, marta.chat.phone).bodyParams).toEqual(['Marta', 'Fisio Test', 'lunes, 12 de mayo de 2025, 09:00', '30']);
  });

  it('answers «sí» to an open offer even right after another conversation', async () => {
    const ctx = await setup();
    const laura = await waitFor(ctx, 'Laura Martínez');
    await ctx.db.appointment.update({ where: { id: ctx.at9.id }, data: { status: 'cancelled' } });
    // Freed from the panel: the periodic job finds it.
    expect(await processWaitlist(ctx.deps, { tenantId: ctx.tenant.id })).toEqual({ tenants: 1, offered: 1, failed: 0 });
    expect(joined(await laura.chat.say('Sí, me viene genial'))).toBe(T.waitlistBooked('Fisio Test', 'lunes, 12 de mayo de 2025, 09:00', 'Ana'));
  });

  it('ignores offer buttons of other clients and keeps the client waiting if the slot was taken', async () => {
    const ctx = await setup();
    const laura = await waitFor(ctx, 'Laura Martínez');
    await ctx.pablo.chat.templateReply(`REMINDER_CANCEL:${ctx.at9.id}`, 'No puedo asistir');
    const [book] = offerTo(ctx, laura.chat.phone).quickReplyPayloads;
    const intruder = await ctx.person('Intruso');
    expect(joined(await intruder.chat.templateReply(book!, 'Reservar'))).toBe(T.waitlistClosed);

    // The clinic gives that slot to someone else before Laura answers.
    await createAppointment(ctx.db, { tenantId: ctx.tenant.id, clientId: ctx.pablo.client.id, employeeId: ctx.ana.id, date: monday(9) });
    expect(joined(await laura.chat.templateReply(book!, 'Reservar'))).toBe(T.waitlistTaken);
    expect(await ctx.db.waitlistEntry.findFirstOrThrow({ where: { clientId: laura.client.id } })).toMatchObject({ status: 'waiting' });
  });

  it('releases the offer when the template cannot be sent', async () => {
    const base = createTestDeps().whatsapp;
    const failing: TestDeps['whatsapp'] = Object.assign(Object.create(base) as TestDeps['whatsapp'], {
      async send(account: Parameters<WhatsAppClient['send']>[0], to: string, message: OutgoingMessage) {
        if (message.type === 'template') throw new Error('template not approved');
        return base.send(account, to, message);
      },
    });
    const ctx = await setup({ whatsapp: failing });
    const laura = await waitFor(ctx, 'Laura Martínez');
    await ctx.db.appointment.update({ where: { id: ctx.at9.id }, data: { status: 'cancelled' } });
    expect(await processWaitlist(ctx.deps, { tenantId: ctx.tenant.id })).toEqual({ tenants: 1, offered: 0, failed: 1 });
    expect(await ctx.db.waitlistEntry.findFirstOrThrow({ where: { clientId: laura.client.id } })).toMatchObject({
      status: 'waiting',
      offerExpiresAt: null,
    });
  });
});

describe('POST /jobs/waitlist/run', () => {
  it('requires the x-cron-secret header and offers freed slots', async () => {
    const ctx = await setup();
    await waitFor(ctx, 'Laura Martínez');
    await ctx.db.appointment.update({ where: { id: ctx.at9.id }, data: { status: 'cancelled' } });
    const app = buildApp(ctx.deps, { register: (i) => registerJobRoutes(i, ctx.deps) });
    expect((await app.inject({ method: 'POST', url: '/jobs/waitlist/run' })).statusCode).toBe(401);
    const ok = await app.inject({
      method: 'POST',
      url: '/jobs/waitlist/run',
      headers: { 'x-cron-secret': CRON_SECRET, 'content-type': 'application/json' },
      payload: JSON.stringify({ tenantId: ctx.tenant.id }),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ tenants: 1, offered: 1, failed: 0 });
    await app.close();
  });
});

describe('F21 — slots freed in the panel', () => {
  it('the internal job left by the panel offers the slot at once', async () => {
    const ctx = await setup();
    const laura = await waitFor(ctx, 'Laura Martínez');
    // The panel cancels Pablo's 9:00 and leaves the job in the queue.
    await ctx.db.appointment.update({ where: { id: ctx.at9.id }, data: { status: 'cancelled' } });
    await requestWaitlistCheck(ctx.db, ctx.tenant.id, 'appointment changed');
    const job = await ctx.db.inboundEvent.findFirstOrThrow({ where: { tenantId: ctx.tenant.id, source: 'internal' } });
    const handler = createInboundEventHandler(ctx.deps, createConversationEngine(ctx.deps), null);
    await handler({ id: Number(job.id), source: 'internal', externalId: job.externalId, tenantId: ctx.tenant.id, phone: '', payload: job.payload, attempts: 1, receivedAt: job.receivedAt });
    expect(offerTo(ctx, laura.chat.phone).bodyParams).toEqual(['Laura', 'Fisio Test', 'lunes, 12 de mayo de 2025, 09:00', '30']);
  });
});
