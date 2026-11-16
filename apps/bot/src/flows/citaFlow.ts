/**
 * CU-C4 Pedir cita / CU-C5 Elegir fecha y hora (RF-W3).
 * The LLM only interprets the date; validation, slot rounding and availability are code.
 * F14: with two or more active services the client chooses one first (a date said before is
 * kept and used afterwards); its duration is used for availability and for the appointment.
 * With a single service it is used directly; with none, the clinic's default duration.
 */
import type { Service } from '@clinicai/db';
import { findNearbySlots, getAvailableEmployees, waitlistWindowFor } from '@clinicai/db';
import {
  beyondBookingHorizon,
  formatDuration,
  formatHumanDate,
  formatHumanDateTime,
  formatShortSlot,
  formatTime,
  getZonedParts,
  normalizeText,
  roundToSlot,
  serviceRefCode,
  startOfZonedDay,
  webBookingStart,
  type WebBookingRef,
} from '@clinicai/shared';
import { getNumber, getString, text, type FlowContext, type FlowName, type FlowResult } from '../engine/flow';
import { mentionsDay } from '../engine/matching';
import { T, contactPhoneOf } from '../engine/texts';
import type { IncomingMessage, OutgoingMessage } from '../engine/types';
import type { ParsedDate } from '../services/aiServices';
import { employeeFlow } from './employeeFlow';
import { waitlistButton } from './waitlistFlow';

export const SLOT_PREFIX = 'SLOT:';
export const SERVICE_PREFIX = 'SERVICE:';

const MONTHS_ES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

const BOOKING_FLOWS: readonly FlowName[] = ['cita', 'employee', 'confirmation'];

type ServiceContext = { serviceId: string; serviceName: string; durationMinutes: number } | Record<string, never>;

/** Duration of the booking: the chosen service's (or the appointment being moved), else the clinic default. */
export function bookingDuration(ctx: FlowContext): number {
  return getNumber(ctx.state?.data, 'durationMinutes') ?? ctx.tenant.settings.slotMinutes;
}

const serviceContext = (s: Service): ServiceContext => ({ serviceId: s.id, serviceName: s.name, durationMinutes: s.durationMinutes });

/** Context visible to the next steps of this message (the engine keeps it for later messages). */
function withContext(ctx: FlowContext, extra: ServiceContext): FlowContext {
  if (Object.keys(extra).length === 0) return ctx;
  return {
    ...ctx,
    state: {
      flow: 'cita',
      step: ctx.state?.step ?? 'askDate',
      data: { ...(ctx.state?.data ?? {}), ...extra },
      errorCount: ctx.state?.errorCount ?? 0,
    },
  };
}

/** Stores the service context in the next booking state (when coming from outside the booking flows). */
function carry(result: FlowResult, extra: ServiceContext): FlowResult {
  if (Object.keys(extra).length === 0 || result.next === 'end' || !BOOKING_FLOWS.includes(result.next.flow)) return result;
  return { ...result, next: { ...result.next, data: { ...extra, ...(result.next.data ?? {}) } } };
}

/** A service whose full name appears in the text (only when exactly one matches). */
function matchService(value: string, services: readonly Service[]): Service | null {
  const t = normalizeText(value);
  const found = services.filter((s) => normalizeText(s.name).length >= 3 && t.includes(normalizeText(s.name)));
  return found.length === 1 ? (found[0] ?? null) : null;
}

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function serviceList(ctx: FlowContext, services: readonly Service[]): OutgoingMessage {
  return {
    type: 'list',
    body: T.askService(ctx.tenant.clinicName),
    buttonText: T.servicesButton,
    sections: [
      {
        title: 'Servicios',
        rows: services.slice(0, 10).map((s) => ({
          id: `${SERVICE_PREFIX}${s.id}`,
          title: clip(s.name, 24),
          description: formatDuration(s.durationMinutes),
        })),
      },
    ],
  };
}

function askDate(ctx: FlowContext, extra: OutgoingMessage[] = []): FlowResult {
  return { replies: [...extra, text(T.askDate(ctx.tenant.clinicName))], next: { flow: 'cita', step: 'askDate' } };
}

/** Validates the requested instant and offers the available professionals (or nearby slots). */
async function checkSlot(ctx: FlowContext, requested: Date): Promise<FlowResult> {
  const { tenant, now, deps } = ctx;
  const tz = tenant.timezone;
  // The slot grid is the clinic's; the duration is the service's (F14).
  const slotMinutes = tenant.settings.slotMinutes;
  const durationMinutes = bookingDuration(ctx);
  const start = roundToSlot(requested, slotMinutes, tz);
  if (start.getTime() <= now.getTime()) {
    return { replies: [text(T.pastDate)], next: { flow: 'cita', step: 'askDate' } };
  }
  if (beyondBookingHorizon(start, now)) {
    return { replies: [text(T.tooFarDate(contactPhoneOf(tenant)))], next: { flow: 'cita', step: 'askDate' } };
  }

  const employees = await getAvailableEmployees(deps.db, tenant.id, start, durationMinutes, tz);
  const human = formatHumanDateTime(start, tz);
  if (employees.length === 0) {
    const suggestions = await findNearbySlots(deps.db, tenant.id, {
      from: start,
      durationMinutes,
      slotMinutes,
      timeZone: tz,
      limit: 3,
    });
    const replies: OutgoingMessage[] = [text(T.noAvailability(human))];
    if (suggestions.length > 0) {
      replies.push({
        type: 'buttons',
        body: T.suggestionsHint,
        buttons: suggestions.map((s) => ({ id: `${SLOT_PREFIX}${s.toISOString()}`, title: formatShortSlot(s, tz) })),
      });
    }
    // F17: registered clients booking a new appointment can wait for that day or that time.
    if (ctx.client && tenant.settings.waitlistEnabled && !getString(ctx.state?.data, 'rescheduleId')) {
      const window = await waitlistWindowFor(deps.db, tenant.id, { start, durationMinutes, slotMinutes, timeZone: tz, now });
      replies.push(waitlistButton(start, window.wholeDay, tz));
    }
    return { replies, next: { flow: 'cita', step: 'askDate' } };
  }

  const replies: OutgoingMessage[] = [text(T.available(human, tenant.clinicName))];
  if (start.getTime() !== requested.getTime()) {
    replies.push(text(T.adjustedTime(formatTime(start, tz))));
  }
  const next = employeeFlow.start(ctx, start, employees);
  return { ...next, replies: [...replies, ...next.replies] };
}

async function processParsed(ctx: FlowContext, parsed: ParsedDate): Promise<FlowResult> {
  const tz = ctx.tenant.timezone;
  if (!parsed.datetime) {
    return { replies: [text(T.dateNotUnderstood)], next: { flow: 'cita', step: 'askDate' }, error: true };
  }
  const date = new Date(parsed.datetime);
  if (!parsed.hasTime) {
    if (startOfZonedDay(date, tz).getTime() < startOfZonedDay(ctx.now, tz).getTime()) {
      return { replies: [text(T.pastDate)], next: { flow: 'cita', step: 'askDate' } };
    }
    if (beyondBookingHorizon(startOfZonedDay(date, tz), ctx.now)) {
      return { replies: [text(T.tooFarDate(contactPhoneOf(ctx.tenant)))], next: { flow: 'cita', step: 'askDate' } };
    }
    return {
      replies: [text(T.askTime(formatHumanDate(date, tz)))],
      next: { flow: 'cita', step: 'askTime', data: { date: date.toISOString() } },
    };
  }
  return checkSlot(ctx, date);
}

/** Date in a free text (if any) → availability; otherwise ask for the date. */
async function fromText(ctx: FlowContext, value: string | undefined, extra: OutgoingMessage[] = []): Promise<FlowResult> {
  if (value?.trim()) {
    const parsed = await ctx.deps.ai.parseDate(value, ctx.now, ctx.tenant.timezone);
    if (parsed.datetime) {
      const result = await processParsed(ctx, parsed);
      return { ...result, replies: [...extra, ...result.replies] };
    }
  }
  return askDate(ctx, extra);
}

export const citaFlow = {
  name: 'cita' as const,

  /**
   * Starts the booking. With several services, asks for one first (keeping the message so a
   * date it contains is used afterwards). If the message already has a date, use it directly.
   */
  async start(ctx: FlowContext, message?: IncomingMessage): Promise<FlowResult> {
    const messageText = message?.type === 'text' ? message.text : undefined;
    let extra: ServiceContext = {};
    // A service (or the duration of the appointment being moved) may already be known.
    if (getNumber(ctx.state?.data, 'durationMinutes') === undefined) {
      const services = await ctx.deps.repos.services.list(ctx.tenant.id, { activeOnly: true });
      const [only] = services;
      const chosen = services.length === 1 ? only : messageText ? matchService(messageText, services) : null;
      if (chosen) extra = serviceContext(chosen);
      else if (services.length > 1) {
        return {
          replies: [serviceList(ctx, services)],
          next: { flow: 'cita', step: 'askService', data: messageText?.trim() ? { pendingText: messageText } : {} },
        };
      }
    }
    return carry(await fromText(withContext(ctx, extra), messageText), extra);
  },

  /**
   * F27: a slot chosen on the public booking page. The service and the local date and time come in
   * the message reference, read with rules (no LLM); the slot is checked like any other (if it was
   * taken meanwhile, the nearest ones are offered). Without that service any more, book as usual.
   */
  async startAt(ctx: FlowContext, ref: WebBookingRef): Promise<FlowResult> {
    const fresh: FlowContext = { ...ctx, state: null };
    const services = await ctx.deps.repos.services.list(ctx.tenant.id, { activeOnly: true });
    const code = ref.serviceCode;
    const matching = code ? services.filter((s) => serviceRefCode(s.id) === code) : [];
    // Exactly one service with that code (two with the same one would be ambiguous: ask instead).
    const service = code ? (matching.length === 1 ? matching[0] : undefined) : services.length === 1 ? services[0] : undefined;
    if ((code && !service) || (!service && services.length > 1)) return citaFlow.start(fresh);
    const extra = service ? serviceContext(service) : {};
    return carry(await checkSlot(withContext(fresh, extra), webBookingStart(ref, ctx.tenant.timezone)), extra);
  },

  askDate,

  async handle(ctx: FlowContext, message: IncomingMessage): Promise<FlowResult> {
    const step = ctx.state?.step ?? 'askDate';
    const { ai } = ctx.deps;
    const tz = ctx.tenant.timezone;

    if (step === 'askService') {
      const data = ctx.state?.data ?? {};
      const services = await ctx.deps.repos.services.list(ctx.tenant.id, { activeOnly: true });
      const byPayload = message.payloadId?.startsWith(SERVICE_PREFIX)
        ? services.find((s) => s.id === message.payloadId?.slice(SERVICE_PREFIX.length))
        : undefined;
      const index = /^\s*(\d{1,2})\s*$/.exec(message.text)?.[1];
      const chosen = byPayload ?? matchService(message.text, services) ?? (index ? services[Number(index) - 1] : undefined);
      if (!chosen) {
        if (services.length === 0) return askDate(ctx);
        return {
          replies: [text(T.pleaseChooseOption), serviceList(ctx, services)],
          next: { flow: 'cita', step: 'askService', data },
          error: true,
        };
      }
      const extra = serviceContext(chosen);
      const ack = [text(T.serviceChosen(chosen.name, formatDuration(chosen.durationMinutes)))];
      return carry(await fromText(withContext(ctx, extra), getString(data, 'pendingText'), ack), extra);
    }

    if (message.payloadId?.startsWith(SLOT_PREFIX)) {
      const suggested = new Date(message.payloadId.slice(SLOT_PREFIX.length));
      if (!Number.isNaN(suggested.getTime())) return checkSlot(ctx, suggested);
    }

    if (step === 'askTime') {
      const dayIso = getString(ctx.state?.data, 'date');
      if (!dayIso || mentionsDay(message.text)) {
        return processParsed(ctx, await ai.parseDate(message.text, ctx.now, tz));
      }
      const p = getZonedParts(new Date(dayIso), tz);
      const combined = `el ${p.day} de ${MONTHS_ES[p.month - 1]} de ${p.year} ${message.text}`;
      const parsed = await ai.parseDate(combined, ctx.now, tz);
      if (!parsed.datetime || !parsed.hasTime) {
        return {
          replies: [text(T.askTime(formatHumanDate(new Date(dayIso), tz)))],
          next: { flow: 'cita', step: 'askTime', data: { date: dayIso } },
          error: true,
        };
      }
      return processParsed(ctx, parsed);
    }

    return processParsed(ctx, await ai.parseDate(message.text, ctx.now, tz));
  },
};
