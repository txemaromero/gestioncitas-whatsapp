/**
 * F13 — the client manages their existing appointments from WhatsApp: see them, cancel one or
 * change its date. Everything here is deterministic (no LLM). Changing the date reuses the
 * booking flows (cita → employee → confirmation) carrying `rescheduleId`; `bookAppointment`
 * then moves the appointment in one transaction, so if the new slot is taken meanwhile the
 * original appointment stays untouched. Within `settings.minNoticeHours` of the appointment
 * nothing can be cancelled or changed here: the client is sent to the clinic's phone.
 * Every appointment id coming from a button is re-checked against the client's own upcoming
 * appointments (never trusted).
 */
import type { Client } from '@clinicai/db';
import { APPOINTMENT_STATUS_LABELS_ES, formatHumanDateTime, formatShortSlot, maskPhone, normalizeText } from '@clinicai/shared';
import { IDLE, getString, text, type FlowContext, type FlowResult } from '../engine/flow';
import { classifyYesNo, type ManageAction } from '../engine/matching';
import { contactPhoneOf, T } from '../engine/texts';
import type { IncomingMessage, OutgoingMessage } from '../engine/types';
import { recordWhatsApp } from '../engine/activity';

export const MANAGE_LIST_ID = 'MANAGE_LIST';
export const NEW_BOOKING_ID = 'NEW_BOOKING';
export const MANAGE_PICK = 'MANAGE_PICK:';
export const MANAGE_CHANGE = 'MANAGE_CHANGE:';
export const MANAGE_CANCEL = 'MANAGE_CANCEL:';
export const MANAGE_CANCEL_YES = 'MANAGE_CANCEL_YES:';
export const MANAGE_KEEP = 'MANAGE_KEEP';

type Upcoming = Awaited<ReturnType<FlowContext['deps']['repos']['appointments']['upcomingForClient']>>[number];

const ACTIONS: readonly ManageAction[] = ['list', 'cancel', 'change'];

/** Can an appointment starting at `date` still be cancelled or changed by WhatsApp? */
export function canModify(ctx: FlowContext, date: Date): boolean {
  return date.getTime() - ctx.now.getTime() >= ctx.tenant.settings.minNoticeHours * 3_600_000;
}

function upcoming(ctx: FlowContext, client: Client): Promise<Upcoming[]> {
  return ctx.deps.repos.appointments.upcomingForClient(ctx.tenant.id, client.id, ctx.now);
}

async function own(ctx: FlowContext, client: Client, id: string): Promise<Upcoming | null> {
  return (await upcoming(ctx, client)).find((a) => a.id === id) ?? null;
}

const when = (ctx: FlowContext, a: Upcoming) => formatHumanDateTime(a.date, ctx.tenant.timezone);
const describe = (ctx: FlowContext, a: Upcoming) =>
  T.appointmentLine(when(ctx, a), a.employee.name, APPOINTMENT_STATUS_LABELS_ES[a.status]);

function actionsMessage(body: string, id: string): OutgoingMessage {
  return {
    type: 'buttons',
    body,
    buttons: [
      { id: `${MANAGE_CHANGE}${id}`, title: T.changeDate },
      { id: `${MANAGE_CANCEL}${id}`, title: T.cancelAppointment },
      { id: MANAGE_KEEP, title: T.keepAppointment },
    ],
  };
}

function listMessage(ctx: FlowContext, appointments: Upcoming[], action: ManageAction): OutgoingMessage {
  return {
    type: 'list',
    body: T.chooseAppointment[action],
    buttonText: T.appointmentsListButton,
    sections: [
      {
        title: 'Próximas citas',
        rows: appointments.map((a) => ({
          id: `${MANAGE_PICK}${a.id}`,
          title: formatShortSlot(a.date, ctx.tenant.timezone),
          description: `con ${a.employee.name} · ${APPOINTMENT_STATUS_LABELS_ES[a.status]}`,
        })),
      },
    ],
  };
}

const kept = (): FlowResult => ({ replies: [text(T.keptAppointment)], next: IDLE });
const gone = (): FlowResult => ({ replies: [text(T.appointmentGone)], next: IDLE });

function tooLate(ctx: FlowContext): FlowResult {
  const { tenant } = ctx;
  return { replies: [text(T.tooLateToModify(tenant.settings.minNoticeHours, tenant.clinicName, contactPhoneOf(tenant)))], next: IDLE };
}

function askCancel(ctx: FlowContext, a: Upcoming): FlowResult {
  if (!canModify(ctx, a.date)) return tooLate(ctx);
  return {
    replies: [
      {
        type: 'buttons',
        body: T.confirmCancel(when(ctx, a), a.employee.name),
        buttons: [
          { id: `${MANAGE_CANCEL_YES}${a.id}`, title: T.confirmCancelYes },
          { id: MANAGE_KEEP, title: T.confirmCancelNo },
        ],
      },
    ],
    next: { flow: 'manage', step: 'confirmCancel', data: { appointmentId: a.id } },
  };
}

async function cancel(ctx: FlowContext, client: Client, id: string): Promise<FlowResult> {
  const a = await own(ctx, client, id);
  if (!a) return gone();
  if (!canModify(ctx, a.date)) return tooLate(ctx);
  await ctx.deps.repos.appointments.setStatus(ctx.tenant.id, a.id, 'cancelled');
  ctx.deps.logger.info(
    { tenantId: ctx.tenant.id, appointmentId: a.id, phone: maskPhone(ctx.phone) },
    'appointment cancelled via whatsapp',
  );
  await recordWhatsApp(ctx, 'whatsapp.appointment_cancelled', {
    entityType: 'appointment',
    entityId: a.id,
    details: { start: a.date, employeeId: a.employeeId },
  });
  return { replies: [text(T.appointmentCancelled(when(ctx, a)))], next: IDLE, slotFreed: true };
}

/** Hands over to the booking flows; the engine keeps `rescheduleId` while they run. */
function beginChange(ctx: FlowContext, a: Upcoming): FlowResult {
  if (!canModify(ctx, a.date)) return tooLate(ctx);
  return {
    replies: [text(T.rescheduleAskDate(when(ctx, a), a.employee.name))],
    // The new date keeps the service and duration of the appointment being moved (F14).
    next: {
      flow: 'cita',
      step: 'askDate',
      data: {
        rescheduleId: a.id,
        durationMinutes: a.durationMinutes,
        ...(a.service ? { serviceId: a.service.id, serviceName: a.service.name } : {}),
      },
    },
  };
}

function onAppointment(ctx: FlowContext, a: Upcoming, action: ManageAction, body: string): FlowResult {
  if (action === 'cancel') return askCancel(ctx, a);
  if (action === 'change') return beginChange(ctx, a);
  return { replies: [actionsMessage(body, a.id)], next: { flow: 'manage', step: 'action', data: { appointmentId: a.id } } };
}

/** What the client typed while choosing what to do with one appointment. */
function typedAction(value: string): 'change' | 'cancel' | 'keep' | null {
  const t = normalizeText(value);
  if (/\b(?:cambi\w*|mover|moverla|otra fecha|otro dia|otra hora|aplaz\w*|retras\w*|adelant\w*)\b/.test(t)) return 'change';
  if (/\b(?:cancel\w*|anul\w*)\b/.test(t)) return 'cancel';
  if (/\b(?:nada|dejala|mantener\w*|asi esta bien)\b/.test(t) || classifyYesNo(value) === 'no') return 'keep';
  return null;
}

export const manageFlow = {
  name: 'manage' as const,

  async start(ctx: FlowContext, action: ManageAction): Promise<FlowResult> {
    const client = ctx.client;
    if (!client) return { replies: [text(T.noUpcoming)], next: IDLE };
    const appointments = await upcoming(ctx, client);
    const [first] = appointments;
    if (!first) return { replies: [text(T.noUpcoming)], next: IDLE };
    if (appointments.length === 1) return onAppointment(ctx, first, action, T.oneAppointment(describe(ctx, first)));
    return { replies: [listMessage(ctx, appointments, action)], next: { flow: 'manage', step: 'pick', data: { action } } };
  },

  async handle(ctx: FlowContext, message: IncomingMessage): Promise<FlowResult> {
    const client = ctx.client;
    if (!client) return { replies: [text(T.noUpcoming)], next: IDLE };
    const data = ctx.state?.data ?? {};
    const step = ctx.state?.step ?? 'action';
    const storedAction = getString(data, 'action');
    const action: ManageAction = ACTIONS.find((a) => a === storedAction) ?? 'list';
    const payload = message.payloadId ?? '';
    const after = (prefix: string) => (payload.startsWith(prefix) ? payload.slice(prefix.length) : null);

    // Buttons carry the appointment id, so they work whatever the current step.
    if (payload === MANAGE_KEEP) return kept();
    const confirmedId = after(MANAGE_CANCEL_YES);
    if (confirmedId) return cancel(ctx, client, confirmedId);
    const targetId = after(MANAGE_PICK) ?? after(MANAGE_CHANGE) ?? after(MANAGE_CANCEL);
    if (targetId) {
      const a = await own(ctx, client, targetId);
      if (!a) return gone();
      if (payload.startsWith(MANAGE_CHANGE)) return beginChange(ctx, a);
      if (payload.startsWith(MANAGE_CANCEL)) return askCancel(ctx, a);
      return onAppointment(ctx, a, action, T.appointmentChosen(describe(ctx, a)));
    }

    // Typed answers.
    const appointmentId = getString(data, 'appointmentId');
    if (step === 'confirmCancel' && appointmentId) {
      const answer = classifyYesNo(message.text);
      if (answer === 'yes') return cancel(ctx, client, appointmentId);
      if (answer === 'no') return kept();
    }
    if (step === 'action' && appointmentId) {
      const typed = typedAction(message.text);
      if (typed === 'keep') return kept();
      if (typed) {
        const a = await own(ctx, client, appointmentId);
        if (!a) return gone();
        return typed === 'change' ? beginChange(ctx, a) : askCancel(ctx, a);
      }
    }
    if (step === 'pick') {
      const index = /^\s*(\d{1,2})\s*$/.exec(message.text)?.[1];
      const a = index ? (await upcoming(ctx, client))[Number(index) - 1] : undefined;
      if (a) return onAppointment(ctx, a, action, T.appointmentChosen(describe(ctx, a)));
    }

    // Not understood: ask again (counts towards the 3-failures limit).
    const again = await manageFlow.start(ctx, step === 'pick' ? action : 'list');
    return { ...again, replies: [text(T.pleaseChooseOption), ...again.replies], error: again.next !== IDLE };
  },
};
