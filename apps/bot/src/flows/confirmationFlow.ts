/**
 * CU-C7 Confirmar datos. "Sí" revalidates availability inside a transaction (no double
 * booking) and creates the appointment as pending / whatsapp.
 * F13: with `rescheduleId` in the state, the same confirmation moves that appointment instead
 * (same id, status back to pending, new reminder); if the slot was taken, it stays as it was.
 */
import { bookAppointment, SlotUnavailableError } from '@clinicai/db';
import { formatDuration, formatHumanDate, formatHumanDateTime, formatTime, maskPhone, normalizeText } from '@clinicai/shared';
import { IDLE, getString, text, type FlowContext, type FlowResult } from '../engine/flow';
import { classifyYesNo } from '../engine/matching';
import { contactPhoneOf, T } from '../engine/texts';
import type { IncomingMessage, OutgoingMessage } from '../engine/types';
import { recordWhatsApp } from '../engine/activity';
import { bookingDuration, citaFlow } from './citaFlow';
import { canModify } from './manageFlow';

export const CONFIRM_YES = 'CONFIRM_YES';
export const CONFIRM_OTHER = 'CONFIRM_OTHER';
export const CONFIRM_EXIT = 'CONFIRM_EXIT';

const questionFor = (rescheduling: boolean): OutgoingMessage => ({
  type: 'buttons',
  body: rescheduling ? T.rescheduleQuestion : T.confirmQuestion,
  buttons: [
    { id: CONFIRM_YES, title: T.confirmYes },
    { id: CONFIRM_OTHER, title: T.confirmOther },
    { id: CONFIRM_EXIT, title: T.confirmExit },
  ],
});

/** F13: moves the client's appointment `rescheduleId` to the confirmed slot. */
async function reschedule(
  ctx: FlowContext,
  client: { id: string },
  rescheduleId: string,
  employeeId: string,
  start: Date,
): Promise<FlowResult> {
  const { tenant, deps } = ctx;
  const current = await deps.repos.appointments.findById(tenant.id, rescheduleId);
  if (!current || current.clientId !== client.id || current.status === 'cancelled' || current.date.getTime() <= ctx.now.getTime()) {
    return { replies: [text(T.appointmentGone)], next: IDLE };
  }
  if (!canModify(ctx, current.date)) {
    return {
      replies: [text(T.tooLateToModify(tenant.settings.minNoticeHours, tenant.clinicName, contactPhoneOf(tenant)))],
      next: IDLE,
    };
  }
  try {
    await bookAppointment(deps.db, tenant.id, {
      appointmentId: current.id,
      clientId: client.id,
      employeeId,
      start,
      // Same duration (and service, untouched) as the appointment being moved.
      durationMinutes: bookingDuration(ctx),
      status: 'pending',
      source: current.source,
      notes: current.notes,
    });
  } catch (error) {
    if (error instanceof SlotUnavailableError) {
      // The original appointment was not touched; ask for another date (rescheduleId is kept).
      return {
        replies: [text(T.rescheduleSlotTaken(formatHumanDateTime(current.date, tenant.timezone)))],
        next: { flow: 'cita', step: 'askDate' },
      };
    }
    throw error;
  }
  deps.logger.info(
    { tenantId: tenant.id, appointmentId: current.id, phone: maskPhone(ctx.phone) },
    'appointment rescheduled via whatsapp',
  );
  await recordWhatsApp(ctx, 'whatsapp.appointment_rescheduled', {
    entityType: 'appointment',
    entityId: current.id,
    details: { start, employeeId },
  });
  // The old time is free now (F17: waiting list).
  return {
    replies: [text(T.rescheduled(tenant.clinicName, formatHumanDateTime(start, tenant.timezone)))],
    next: IDLE,
    slotFreed: true,
  };
}

type Choice = 'yes' | 'other' | 'exit' | 'unknown';

function classify(message: IncomingMessage): Choice {
  if (message.payloadId === CONFIRM_YES) return 'yes';
  if (message.payloadId === CONFIRM_OTHER) return 'other';
  if (message.payloadId === CONFIRM_EXIT) return 'exit';
  const t = normalizeText(message.text);
  if (/\b(?:otra fecha|otro dia|otra hora|cambiar|cambia)\b/.test(t)) return 'other';
  if (/^(?:salir)\b/.test(t)) return 'exit';
  const yn = classifyYesNo(message.text);
  return yn === 'yes' ? 'yes' : yn === 'no' ? 'exit' : 'unknown';
}

export const confirmationFlow = {
  name: 'confirmation' as const,

  start(ctx: FlowContext, start: Date, employee: { id: string; name: string }): FlowResult {
    const tz = ctx.tenant.timezone;
    const rescheduling = Boolean(getString(ctx.state?.data, 'rescheduleId'));
    const serviceName = getString(ctx.state?.data, 'serviceName');
    const serviceLine = serviceName ? T.serviceLine(serviceName, formatDuration(bookingDuration(ctx))) : '';
    const summary = `${rescheduling ? `${T.rescheduleSummaryTitle}\n\n` : ''}${T.selectedEmployee(employee.name, ctx.tenant.clinicName)}\n\n${T.summary(
      formatHumanDate(start, tz),
      formatTime(start, tz),
      employee.name,
    )}${serviceLine}`;
    return {
      replies: [text(summary), questionFor(rescheduling)],
      next: {
        flow: 'confirmation',
        step: 'await',
        data: { start: start.toISOString(), employeeId: employee.id, employeeName: employee.name },
      },
    };
  },

  async handle(ctx: FlowContext, message: IncomingMessage): Promise<FlowResult> {
    const data = ctx.state?.data ?? {};
    const startIso = getString(data, 'start');
    const employeeId = getString(data, 'employeeId');
    const rescheduleId = getString(data, 'rescheduleId');
    const choice = classify(message);

    if (choice === 'exit') return { replies: [text(rescheduleId ? T.rescheduleAborted : T.bookingCancelled)], next: 'end' };
    if (choice === 'other' || !startIso || !employeeId) return citaFlow.askDate(ctx);
    if (choice === 'unknown') {
      return {
        replies: [text(T.pleaseChooseOption), questionFor(Boolean(rescheduleId))],
        next: { flow: 'confirmation', step: 'await', data },
        error: true,
      };
    }

    const client = ctx.client;
    if (!client) return citaFlow.askDate(ctx);
    const start = new Date(startIso);
    if (rescheduleId) return reschedule(ctx, client, rescheduleId, employeeId, start);
    try {
      const appointment = await bookAppointment(ctx.deps.db, ctx.tenant.id, {
        clientId: client.id,
        employeeId,
        start,
        durationMinutes: bookingDuration(ctx),
        serviceId: getString(data, 'serviceId') ?? null,
        status: 'pending',
        source: 'whatsapp',
      });
      ctx.deps.logger.info(
        { tenantId: ctx.tenant.id, appointmentId: appointment.id, phone: maskPhone(ctx.phone) },
        'appointment booked via whatsapp',
      );
      await recordWhatsApp(ctx, 'whatsapp.appointment_booked', {
        entityType: 'appointment',
        entityId: appointment.id,
        details: { start, employeeId, serviceId: appointment.serviceId },
      });
      return {
        replies: [text(T.booked(ctx.tenant.clinicName, formatHumanDateTime(start, ctx.tenant.timezone)))],
        next: IDLE,
      };
    } catch (error) {
      if (error instanceof SlotUnavailableError) {
        return { replies: [text(T.slotTaken)], next: { flow: 'cita', step: 'askDate' } };
      }
      throw error;
    }
  },
};
