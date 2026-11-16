/**
 * F17: waiting list in the conversation.
 *  - `WAITLIST_JOIN:<start>`: button shown when the requested time is not available. The window is
 *    computed again when pressed: the whole day if it is full, otherwise only that time.
 *  - `WAITLIST_BOOK:<entry>` / `WAITLIST_SKIP:<entry>`: quick replies of the offer template (sent
 *    by jobs/waitlist.ts). A plain «sí» / «no» answers an offer that is still open.
 * Nothing here runs for people who have not accepted the privacy notice.
 */
import {
  acceptWaitlistOffer,
  findOpenWaitlistOffer,
  findWaitlistEntry,
  joinWaitlist,
  leaveWaitlist,
  waitlistWindowFor,
  type WaitlistEntry,
} from '@clinicai/db';
import { formatHumanDate, formatHumanDateTime, formatTime, maskPhone } from '@clinicai/shared';
import { IDLE, getNumber, getString, text, type FlowContext, type FlowResult, type FlowState } from '../engine/flow';
import { classifyYesNo } from '../engine/matching';
import { T } from '../engine/texts';
import type { IncomingMessage, OutgoingMessage } from '../engine/types';
import { recordWhatsApp } from '../engine/activity';

export const WAITLIST_JOIN = 'WAITLIST_JOIN:';
export const WAITLIST_BOOK = 'WAITLIST_BOOK:';
export const WAITLIST_SKIP = 'WAITLIST_SKIP:';

/** "el lunes, 16 de noviembre de 2026" (whole day) or "… a las 10:00" (one time). */
export function waitlistWhen(entry: Pick<WaitlistEntry, 'windowStart' | 'wholeDay'>, timeZone: string): string {
  const day = `el ${formatHumanDate(entry.windowStart, timeZone)}`;
  return entry.wholeDay ? day : `${day} a las ${formatTime(entry.windowStart, timeZone)}`;
}

/** Button offered after "no availability" (only for registered clients, outside a reschedule). */
export function waitlistButton(start: Date, wholeDay: boolean, timeZone: string): OutgoingMessage {
  return {
    type: 'buttons',
    body: wholeDay ? T.waitlistAskDay : T.waitlistAskTime(formatTime(start, timeZone)),
    buttons: [{ id: `${WAITLIST_JOIN}${start.toISOString()}`, title: T.waitlistButton }],
  };
}

async function join(ctx: FlowContext, startIso: string, previous: FlowState | null): Promise<FlowResult> {
  const { tenant, client, now, deps } = ctx;
  const start = new Date(startIso);
  if (!client || !tenant.settings.waitlistEnabled || Number.isNaN(start.getTime()) || start.getTime() <= now.getTime()) {
    return { replies: [text(T.waitlistUnavailable)], next: IDLE };
  }
  // The service (and its duration) chosen in the booking that led here, if still known.
  const durationMinutes = getNumber(previous?.data, 'durationMinutes') ?? tenant.settings.slotMinutes;
  const serviceId = getString(previous?.data, 'serviceId') ?? null;
  const window = await waitlistWindowFor(deps.db, tenant.id, {
    start,
    durationMinutes,
    slotMinutes: tenant.settings.slotMinutes,
    timeZone: tenant.timezone,
    now,
  });
  const result = await joinWaitlist(deps.db, tenant.id, { clientId: client.id, serviceId, durationMinutes, window, now });
  if (result.status === 'limit') return { replies: [text(T.waitlistLimit(result.max))], next: IDLE };
  const when = waitlistWhen(result.entry, tenant.timezone);
  if (result.status === 'already') return { replies: [text(T.waitlistAlready(when))], next: IDLE };
  deps.logger.info(
    { tenantId: tenant.id, entryId: result.entry.id, wholeDay: window.wholeDay, phone: maskPhone(ctx.phone) },
    'client joined the waiting list',
  );
  await recordWhatsApp(ctx, 'whatsapp.waitlist_joined', {
    entityType: 'waitlist',
    entityId: result.entry.id,
    details: { start: window.preferred, onlyThatTime: !window.wholeDay },
  });
  return { replies: [text(T.waitlistJoined(when))], next: IDLE };
}

async function accept(ctx: FlowContext, entryId: string): Promise<FlowResult> {
  const { tenant, client, now, deps } = ctx;
  if (!client) return { replies: [text(T.waitlistClosed)], next: IDLE };
  const result = await acceptWaitlistOffer(deps.db, tenant.id, { entryId, clientId: client.id, now });
  if (result.status === 'booked') {
    deps.logger.info(
      { tenantId: tenant.id, entryId, appointmentId: result.appointment.id, phone: maskPhone(ctx.phone) },
      'waiting list offer accepted: appointment booked',
    );
    await recordWhatsApp(ctx, 'whatsapp.waitlist_booked', {
      entityType: 'appointment',
      entityId: result.appointment.id,
      details: { start: result.appointment.date, employeeId: result.appointment.employeeId },
    });
    const when = formatHumanDateTime(result.appointment.date, tenant.timezone);
    return { replies: [text(T.waitlistBooked(tenant.clinicName, when, result.appointment.employee.name))], next: IDLE };
  }
  if (result.status === 'taken') return { replies: [text(T.waitlistTaken)], next: IDLE };
  return { replies: [text(T.waitlistClosed)], next: IDLE };
}

async function skip(ctx: FlowContext, entryId: string): Promise<FlowResult> {
  const { tenant, client, now, deps } = ctx;
  const entry = client ? await findWaitlistEntry(deps.db, tenant.id, entryId, client.id) : null;
  if (!client || !entry || !(await leaveWaitlist(deps.db, tenant.id, entry.id, { clientId: client.id, now }))) {
    return { replies: [text(T.waitlistClosed)], next: IDLE };
  }
  await recordWhatsApp(ctx, 'whatsapp.waitlist_left', { entityType: 'waitlist', entityId: entry.id });
  // The slot that was held for this client can go to the next one straight away.
  return { replies: [text(T.waitlistLeft(waitlistWhen(entry, tenant.timezone)))], next: IDLE, slotFreed: true };
}

export const waitlistFlow = {
  /** Waiting list buttons; null when the payload is not one (or the sender cannot use it). */
  async handlePayload(ctx: FlowContext, payloadId: string, previous: FlowState | null): Promise<FlowResult | null> {
    if (!ctx.client?.consentAt) return null;
    if (payloadId.startsWith(WAITLIST_JOIN)) return join(ctx, payloadId.slice(WAITLIST_JOIN.length), previous);
    if (payloadId.startsWith(WAITLIST_BOOK)) return accept(ctx, payloadId.slice(WAITLIST_BOOK.length));
    if (payloadId.startsWith(WAITLIST_SKIP)) return skip(ctx, payloadId.slice(WAITLIST_SKIP.length));
    return null;
  },

  /** «Sí» / «no» written while an offer is open. Null when the message is about something else. */
  async handleTextReply(ctx: FlowContext, message: IncomingMessage): Promise<FlowResult | null> {
    if (!ctx.client?.consentAt || message.type !== 'text') return null;
    const offer = await findOpenWaitlistOffer(ctx.deps.db, ctx.tenant.id, ctx.client.id, ctx.now);
    if (!offer) return null;
    const answer = classifyYesNo(message.text);
    if (answer === 'yes') return accept(ctx, offer.id);
    if (answer === 'no') return skip(ctx, offer.id);
    return null;
  },
};
