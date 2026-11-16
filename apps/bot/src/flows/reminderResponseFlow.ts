/**
 * CU-C9: answers to the 24 h reminder. Template quick-reply payloads
 * `REMINDER_CONFIRM:<id>` / `REMINDER_CANCEL:<id>`, or free text within 24 h of the reminder
 * (simple yes/no rules; ambiguous short answers get the buttons again).
 */
import type { AppointmentWithPeople } from '@clinicai/db';
import { formatHumanDate, formatTime, toZonedDateKey, addZonedDays } from '@clinicai/shared';
import { IDLE, getString, text, type FlowContext, type FlowResult } from '../engine/flow';
import { classifyYesNo } from '../engine/matching';
import { T } from '../engine/texts';
import type { IncomingMessage, OutgoingMessage } from '../engine/types';
import { recordWhatsApp } from '../engine/activity';

export const REMINDER_CONFIRM = 'REMINDER_CONFIRM:';
export const REMINDER_CANCEL = 'REMINDER_CANCEL:';
const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

export function parseReminderPayload(payloadId: string | null): { action: 'confirm' | 'cancel'; appointmentId: string } | null {
  if (!payloadId) return null;
  if (payloadId.startsWith(REMINDER_CONFIRM)) return { action: 'confirm', appointmentId: payloadId.slice(REMINDER_CONFIRM.length) };
  if (payloadId.startsWith(REMINDER_CANCEL)) return { action: 'cancel', appointmentId: payloadId.slice(REMINDER_CANCEL.length) };
  return null;
}

/** "mañana" when the appointment is tomorrow (tenant zone), otherwise "el jueves, 8 de mayo…". */
function when(ctx: FlowContext, date: Date): string {
  const tz = ctx.tenant.timezone;
  const tomorrow = toZonedDateKey(addZonedDays(ctx.now, 1, tz), tz);
  if (toZonedDateKey(date, tz) === tomorrow) return 'mañana';
  if (toZonedDateKey(date, tz) === toZonedDateKey(ctx.now, tz)) return 'hoy';
  return `el ${formatHumanDate(date, tz)}`;
}

function reminderButtons(ctx: FlowContext, appointment: AppointmentWithPeople): OutgoingMessage {
  return {
    type: 'buttons',
    body: T.reminderAsk(ctx.tenant.clinicName, when(ctx, appointment.date), formatTime(appointment.date, ctx.tenant.timezone)),
    buttons: [
      { id: `${REMINDER_CONFIRM}${appointment.id}`, title: T.reminderButtonConfirm },
      { id: `${REMINDER_CANCEL}${appointment.id}`, title: T.reminderButtonCancel },
    ],
  };
}

async function apply(ctx: FlowContext, action: 'confirm' | 'cancel', appointmentId: string): Promise<FlowResult> {
  const { repos } = ctx.deps;
  const appointment = await repos.appointments.findById(ctx.tenant.id, appointmentId);
  // The appointment must belong to this tenant (repo filter) and to this phone.
  if (!appointment || appointment.client.phone !== ctx.phone) {
    return { replies: [text(T.reminderNotFound)], next: 'end' };
  }
  if (appointment.status === 'cancelled') {
    return { replies: [text(T.reminderAlreadyCancelled)], next: 'end' };
  }
  // F32: the buttons of an old reminder do nothing once the appointment has started.
  if (appointment.date.getTime() <= ctx.now.getTime()) {
    return { replies: [text(T.reminderPast)], next: 'end' };
  }
  if (action === 'confirm') {
    if (appointment.status === 'confirmed') {
      return { replies: [text(T.reminderAlreadyConfirmed(when(ctx, appointment.date)))], next: IDLE };
    }
    // Only a pending appointment: one cancelled meanwhile (panel, another message) stays cancelled.
    if (!(await repos.appointments.setStatus(ctx.tenant.id, appointment.id, 'confirmed', { from: ['pending'] }))) {
      return { replies: [text(T.reminderAlreadyCancelled)], next: 'end' };
    }
    await recordWhatsApp(ctx, 'whatsapp.appointment_confirmed', {
      entityType: 'appointment',
      entityId: appointment.id,
      clientId: appointment.clientId,
      details: { start: appointment.date, employeeId: appointment.employeeId },
    });
    return { replies: [text(T.reminderConfirmed(ctx.tenant.clinicName, when(ctx, appointment.date)))], next: IDLE };
  }
  if (!(await repos.appointments.setStatus(ctx.tenant.id, appointment.id, 'cancelled', { from: ['pending', 'confirmed'] }))) {
    return { replies: [text(T.reminderAlreadyCancelled)], next: 'end' };
  }
  await recordWhatsApp(ctx, 'whatsapp.appointment_cancelled', {
    entityType: 'appointment',
    entityId: appointment.id,
    clientId: appointment.clientId,
    details: { start: appointment.date, employeeId: appointment.employeeId },
  });
  return { replies: [text(T.reminderCancelled)], next: IDLE, slotFreed: true };
}

export const reminderResponseFlow = {
  name: 'reminderResponse' as const,

  /** Quick-reply button of the template (or of the re-sent buttons). */
  async handlePayload(ctx: FlowContext, payloadId: string): Promise<FlowResult | null> {
    const parsed = parseReminderPayload(payloadId);
    return parsed ? apply(ctx, parsed.action, parsed.appointmentId) : null;
  },

  /**
   * Free text with no active state: if a reminder was sent to this client in the last 24 h,
   * interpret yes/no. Returns null when the message is not about the reminder.
   */
  async handleTextReply(ctx: FlowContext, message: IncomingMessage): Promise<FlowResult | null> {
    if (!ctx.client || message.type !== 'text') return null;
    const since = new Date(ctx.now.getTime() - REMINDER_WINDOW_MS);
    const [latest] = await ctx.deps.repos.appointments.findRecentlyReminded(ctx.tenant.id, ctx.client.id, since);
    if (!latest) return null;
    const answer = classifyYesNo(message.text);
    if (answer !== 'unknown') return apply(ctx, answer === 'yes' ? 'confirm' : 'cancel', latest.id);
    // Short ambiguous answer ("vale?", "hola") → ask again with the buttons. Longer messages are
    // probably a new request and follow the normal routing.
    if (message.text.trim().split(/\s+/).length > 5) return null;
    return {
      replies: [reminderButtons(ctx, latest)],
      next: { flow: 'reminderResponse', step: 'await', data: { appointmentId: latest.id } },
    };
  },

  /** Active state after re-sending the buttons. Returns null to hand over to normal routing. */
  async handle(ctx: FlowContext, message: IncomingMessage): Promise<FlowResult | null> {
    const appointmentId = getString(ctx.state?.data, 'appointmentId');
    const answer = classifyYesNo(message.text);
    if (!appointmentId || answer === 'unknown') return null;
    return apply(ctx, answer === 'yes' ? 'confirm' : 'cancel', appointmentId);
  },
};
