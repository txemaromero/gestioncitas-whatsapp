/**
 * Conversation engine. Router order:
 *  1. phone in bot_blacklist → no automatic answer (only mirrored to Chatwoot)
 *  2. reminder quick-reply payload → reminderResponseFlow
 *  3. active, non-expired state → that flow and step (escape words first)
 *  4. otherwise → mainFlow (text replies to a reminder sent < 24 h ago are checked first)
 * State lives in the DB, so any instance can continue any conversation. Messages arrive through
 * the durable inbound queue (F11), which also guarantees one message at a time per conversation.
 * Voice notes (F16) are transcribed first and then follow the same route as a written message.
 * Waiting list buttons and answers to an open offer (F17) are handled before the active state.
 */
import { runWithTenant, type Tenant } from '@clinicai/db';
import { maskPhone, readWebBookingRef } from '@clinicai/shared';
import type { AppDeps } from '../deps';
import { citaFlow } from '../flows/citaFlow';
import { confirmationFlow } from '../flows/confirmationFlow';
import { employeeFlow } from '../flows/employeeFlow';
import { faqFlow } from '../flows/faqFlow';
import { intentionFlow } from '../flows/intentionFlow';
import { mainFlow } from '../flows/mainFlow';
import { manageFlow } from '../flows/manageFlow';
import { registerFlow } from '../flows/registerFlow';
import { reminderResponseFlow } from '../flows/reminderResponseFlow';
import { waitlistFlow } from '../flows/waitlistFlow';
import { processWaitlist } from '../jobs/waitlist';
import { AIUnavailableError } from '../services/aiServices';
import { transcribableExtension } from '../services/transcription';
import { MediaTooLargeError, resolveWaAccount } from '../services/whatsapp';
import { isOgg, oggDurationSeconds } from '../utils/ogg';
import { IDLE, getString, text, type FlowContext, type FlowName, type FlowNext, type FlowResult, type FlowState } from './flow';
import { detectEscape } from './matching';
import { T, contactPhoneOf } from './texts';
import type { IncomingMessage, MessageHandler, OutgoingMessage } from './types';
import { CANCEL_ID } from '../flows/employeeFlow';
import { NonRetryableError } from '../queue/worker';

export const MAX_ERRORS = 3;
const BOOKING_FLOWS: readonly FlowName[] = ['cita', 'employee', 'confirmation'];
/**
 * State keys that live for a whole booking (cita → employee → confirmation) even though each
 * step replaces the data bag: `rescheduleId` = the appointment being moved (F13).
 */
const BOOKING_CONTEXT_KEYS = ['rescheduleId', 'serviceId', 'serviceName', 'durationMinutes'] as const;

function withBookingContext(previous: FlowState | null, next: FlowNext): FlowNext {
  if (next === 'end' || !previous || !BOOKING_FLOWS.includes(previous.flow) || !BOOKING_FLOWS.includes(next.flow)) return next;
  const carried: Record<string, unknown> = {};
  for (const key of BOOKING_CONTEXT_KEYS) {
    if (previous.data[key] !== undefined && next.data?.[key] === undefined) carried[key] = previous.data[key];
  }
  return Object.keys(carried).length === 0 ? next : { ...next, data: { ...(next.data ?? {}), ...carried } };
}

/** Bytes allowed per second of voice note (≈256 kbps): caps the formats whose duration is not read. */
export const VOICE_BYTES_PER_SECOND = 32_000;
/** Longest transcript echoed back to the client. */
const VOICE_ECHO_MAX = 300;

function echoOf(transcript: string): string {
  return transcript.length <= VOICE_ECHO_MAX ? transcript : `${transcript.slice(0, VOICE_ECHO_MAX - 1).trimEnd()}…`;
}

/** Answer to a message the bot cannot read: images, stickers or voice notes not transcribed. */
function nonTextReply(message: IncomingMessage, maxSeconds: number): string {
  switch (message.voiceIssue) {
    case 'too_long':
      return T.voiceTooLong(Math.max(1, Math.floor(maxSeconds / 60)));
    case 'empty':
      return T.voiceEmpty;
    case 'no_consent':
      return T.voiceNeedsConsent;
    case 'unavailable':
      return T.voiceUnavailable;
    case undefined:
      return T.onlyText;
  }
}

/** Hooks so other modules (Chatwoot mirror) can observe the conversation. */
export interface EngineObserver {
  onIncoming?(tenant: Tenant, message: IncomingMessage): void;
  onOutgoing?(tenant: Tenant, phone: string, messages: OutgoingMessage[]): void;
}

/**
 * The replies could not be delivered after the conversation state was saved: retrying the whole
 * message would run the flow twice, so the queue must not retry it (the WhatsApp client already
 * retried temporary errors).
 */
export class ReplyDeliveryError extends NonRetryableError {
  constructor(cause: unknown) {
    super(`reply delivery failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'ReplyDeliveryError';
  }
}

async function runActiveFlow(ctx: FlowContext, state: FlowState, message: IncomingMessage): Promise<FlowResult> {
  const flowCtx = { ...ctx, state };
  switch (state.flow) {
    case 'register':
      return registerFlow.handle(flowCtx, message);
    case 'cita':
      return citaFlow.handle(flowCtx, message);
    case 'employee':
      return employeeFlow.handle(flowCtx, message);
    case 'confirmation':
      return confirmationFlow.handle(flowCtx, message);
    case 'faq':
      return faqFlow.handle(flowCtx, message);
    case 'manage':
      return ctx.client ? manageFlow.handle(flowCtx, message) : mainFlow.handle({ ...ctx, state: null }, message);
    case 'reminderResponse': {
      const result = await reminderResponseFlow.handle(flowCtx, message);
      if (result) return result;
      return ctx.client ? intentionFlow.handle({ ...ctx, state: null }, message) : mainFlow.handle({ ...ctx, state: null }, message);
    }
    case 'main':
      return mainFlow.handle(flowCtx, message);
    case 'intention':
      return ctx.client ? intentionFlow.handle(flowCtx, message) : mainFlow.handle({ ...ctx, state: null }, message);
  }
}

export function createConversationEngine(deps: AppDeps, observer: EngineObserver = {}): MessageHandler {
  const flowDeps = { db: deps.db, repos: deps.repos, ai: deps.ai, clock: deps.clock, logger: deps.logger };

  async function route(tenant: Tenant, message: IncomingMessage): Promise<{ result: FlowResult; previous: FlowState | null }> {
    const now = deps.clock.now();
    const [client, stored] = await Promise.all([
      deps.repos.clients.findByPhone(tenant.id, message.phone),
      deps.repos.conversations.get(tenant.id, message.phone, now),
    ]);
    const previous: FlowState | null = stored
      ? { flow: stored.flow as FlowName, step: stored.step, data: stored.data, errorCount: stored.errorCount }
      : null;
    const ctx: FlowContext = { tenant, phone: message.phone, client, state: null, deps: flowDeps, now };

    // Non-text messages (images, voice notes that could not be transcribed…): kindly ask for
    // text, keep the current state.
    if (message.type === 'other') {
      return {
        result: {
          replies: [text(nonTextReply(message, deps.config.VOICE_MAX_SECONDS))],
          next: previous ? { flow: previous.flow, step: previous.step, data: previous.data } : 'end',
        },
        previous,
      };
    }

    // 2. Reminder quick replies.
    const reminderResult = message.payloadId ? await reminderResponseFlow.handlePayload(ctx, message.payloadId) : null;
    if (reminderResult) return { result: reminderResult, previous };

    // F17: waiting list buttons (join the list, book or decline an offer).
    const waitlistResult = message.payloadId ? await waitlistFlow.handlePayload(ctx, message.payloadId, previous) : null;
    if (waitlistResult) return { result: waitlistResult, previous };

    // Global escape words (and the "Cancelar" button/row).
    const escape = message.payloadId === CANCEL_ID ? 'cancel' : message.type === 'text' ? detectEscape(message.text) : null;
    if (escape === 'cancel') {
      const inBooking = previous !== null && BOOKING_FLOWS.includes(previous.flow);
      const rescheduling = inBooking && Boolean(getString(previous.data, 'rescheduleId'));
      const reply = rescheduling ? T.rescheduleAborted : inBooking ? T.bookingCancelled : T.escapeGoodbye;
      return { result: { replies: [text(reply)], next: 'end' }, previous };
    }
    if (escape === 'menu') {
      if (!client) return { result: await mainFlow.handle(ctx, message), previous: null };
      return { result: { replies: [text(T.menuHelp(tenant.clinicName))], next: IDLE }, previous };
    }

    // F17: «sí» / «no» to an open waiting list offer (offers arrive at any moment, often while
    // the conversation is idle after a previous request).
    if (!previous || previous.flow === 'intention') {
      const waitlistText = await waitlistFlow.handleTextReply(ctx, message);
      if (waitlistText) return { result: waitlistText, previous };
    }

    // F27: a slot chosen on the booking page starts a new booking, whatever was going on (except
    // a registration, which keeps it until it is done). Without the previous booking context.
    if (previous && previous.flow !== 'register' && client?.consentAt && message.type === 'text') {
      const webRef = readWebBookingRef(message.text);
      if (webRef) return { result: await citaFlow.startAt(ctx, webRef), previous: null };
    }

    // 3. Active state.
    if (previous) return { result: await runActiveFlow(ctx, previous, message), previous };

    // Text answer to a reminder sent in the last 24 h.
    const reminderText = await reminderResponseFlow.handleTextReply(ctx, message);
    if (reminderText) return { result: reminderText, previous };

    // 4. New conversation.
    return { result: await mainFlow.handle(ctx, message), previous: null };
  }

  async function processMessage(tenant: Tenant, message: IncomingMessage): Promise<void> {
    const now = deps.clock.now();
    const phone = message.phone;
    const masked = maskPhone(phone);

    let result: FlowResult;
    let previous: FlowState | null = null;
    try {
      ({ result, previous } = await route(tenant, message));
    } catch (error) {
      if (!(error instanceof AIUnavailableError)) throw error;
      deps.logger.error({ tenantId: tenant.id, phone: masked }, 'llm unavailable');
      const stored = await deps.repos.conversations.get(tenant.id, phone, now);
      previous = stored
        ? { flow: stored.flow as FlowName, step: stored.step, data: stored.data, errorCount: stored.errorCount }
        : null;
      result = {
        replies: [text(T.aiUnavailable)],
        next: previous ? { flow: previous.flow, step: previous.step, data: previous.data } : IDLE,
        error: true,
      };
    }

    // Keep the booking context (e.g. the appointment being rescheduled) across the booking steps.
    result = { ...result, next: withBookingContext(previous, result.next) };

    // Error counter per flow: 3 failures → suggest calling the business and reset.
    let replies = result.replies;
    if (result.next === 'end') {
      await deps.repos.conversations.clear(tenant.id, phone);
    } else {
      const sameFlow = previous?.flow === result.next.flow;
      const errorCount = (sameFlow ? (previous?.errorCount ?? 0) : 0) + (result.error ? 1 : 0);
      if (errorCount >= MAX_ERRORS) {
        replies = [text(T.tooManyErrors(tenant.clinicName, contactPhoneOf(tenant)))];
        await deps.repos.conversations.clear(tenant.id, phone);
        deps.logger.info({ tenantId: tenant.id, phone: masked, flow: result.next.flow }, 'too many errors: flow reset');
      } else {
        await deps.repos.conversations.save(
          tenant.id,
          phone,
          { flow: result.next.flow, step: result.next.step, data: result.next.data ?? {}, errorCount },
          now,
        );
      }
    }

    // F16: tell the client what was understood from the voice note before answering it.
    if (message.transcribed) replies = [text(T.voiceUnderstood(echoOf(message.text))), ...replies];

    try {
      await send(tenant, phone, replies);
    } catch (error) {
      throw new ReplyDeliveryError(error);
    }

    // F17: a cancellation or change freed a slot: offer it to the waiting list right away.
    if (result.slotFreed && tenant.settings.waitlistEnabled) {
      deps.background.run('waitlist-after-cancellation', () => processWaitlist(deps, { tenantId: tenant.id }, observer));
    }
  }

  async function send(tenant: Tenant, phone: string, replies: OutgoingMessage[]): Promise<void> {
    if (replies.length === 0) return;
    const account = resolveWaAccount(tenant, deps.config);
    if (!account) {
      deps.logger.error({ tenantId: tenant.id }, 'tenant without WhatsApp credentials: replies not sent');
      return;
    }
    for (const reply of replies) {
      await deps.whatsapp.send(account, phone, reply);
    }
    observer.onOutgoing?.(tenant, phone, replies);
  }

  /**
   * F16: turns a voice note into a text message (download → transcribe → discard the audio; only
   * the text is kept). Only for clients who accepted the privacy notice (nothing is processed
   * before). Any problem becomes a `voiceIssue` answered with "please write", without retrying, so
   * the client gets an answer straight away.
   */
  async function prepareVoice(tenant: Tenant, message: IncomingMessage): Promise<IncomingMessage> {
    const media = message.media;
    if (!media) return message;
    const withIssue = (voiceIssue: NonNullable<IncomingMessage['voiceIssue']>): IncomingMessage => ({ ...message, voiceIssue });
    const client = await deps.repos.clients.findByPhone(tenant.id, message.phone);
    if (!client?.consentAt) return withIssue('no_consent');
    const account = resolveWaAccount(tenant, deps.config);
    if (!deps.transcriber || !account) return withIssue('unavailable');
    if (media.mimeType && !transcribableExtension(media.mimeType)) return withIssue('unavailable');

    const log = { tenantId: tenant.id, phone: maskPhone(message.phone) };
    const maxSeconds = deps.config.VOICE_MAX_SECONDS;
    try {
      const audio = await deps.whatsapp.downloadMedia(account, media.id, maxSeconds * VOICE_BYTES_PER_SECOND);
      // WhatsApp voice notes are Ogg/Opus: their real length is read from the file.
      const seconds = isOgg(audio.mimeType) ? oggDurationSeconds(audio.data) : null;
      if (seconds !== null && seconds > maxSeconds + 1) {
        deps.logger.info({ ...log, seconds: Math.round(seconds) }, 'voice note too long');
        return withIssue('too_long');
      }
      const transcript = (await deps.transcriber.transcribe(audio.data, audio.mimeType)).replace(/\s+/g, ' ').trim();
      // F31: seconds transcribed (estimated from the size when the length is unknown).
      deps.usage.record([
        {
          metric: 'transcription.seconds',
          model: deps.transcriber.mode === 'live' ? deps.config.OPENAI_TRANSCRIBE_MODEL : 'mock',
          amount: Math.max(1, Math.ceil(seconds ?? audio.data.length / VOICE_BYTES_PER_SECOND)),
        },
      ]);
      // Only the length of the transcript is logged, never its content.
      deps.logger.info(
        { ...log, seconds: seconds === null ? null : Math.round(seconds), chars: transcript.length },
        'voice note transcribed',
      );
      if (!transcript) return withIssue('empty');
      return { ...message, type: 'text', text: transcript, transcribed: true };
    } catch (error) {
      if (error instanceof MediaTooLargeError) {
        deps.logger.info({ ...log, bytes: error.size }, 'voice note too large');
        return withIssue('too_long');
      }
      deps.logger.warn({ ...log, err: error instanceof Error ? error.message : String(error) }, 'voice note not transcribed');
      return withIssue('unavailable');
    }
  }

  return {
    // F19: a message is always work of its clinic (also when called directly: simulator, tests).
    handle: (tenant, incoming) => runWithTenant(tenant.id, () => handleMessage(tenant, incoming)),
  };

  async function handleMessage(tenant: Tenant, incoming: IncomingMessage): Promise<void> {
    {
      // Transcribed before mirroring, so a Chatwoot agent can read a voice note too.
      const message = await prepareVoice(tenant, incoming);
      observer.onIncoming?.(tenant, message);
      if (await deps.repos.blacklist.isBlocked(tenant.id, message.phone)) {
        deps.logger.info({ tenantId: tenant.id, phone: maskPhone(message.phone) }, 'bot paused for this contact');
        return;
      }
      const account = resolveWaAccount(tenant, deps.config);
      if (account) {
        deps.background.run('mark-as-read', () => deps.whatsapp.markAsRead(account, message.waMessageId));
      }
      await processMessage(tenant, message);
    }
  }
}
