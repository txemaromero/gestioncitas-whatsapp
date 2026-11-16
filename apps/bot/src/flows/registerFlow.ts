/**
 * CU-C2 Registro (RF-W1): unknown phone for this tenant → privacy notice and acceptance (F12),
 * full name and email, then create the client bound to the webhook phone with the acceptance.
 * Clients created from the web panel without acceptance go through `startConsent` the first
 * time they write: nothing else is processed (nor sent to the LLM) until they accept.
 * F27: a first message from the public booking page carries a slot reference (service, date and
 * time, no personal data). Only that code is kept in the state while registering; once done, the
 * booking goes on with that slot without asking again.
 */
import type { Client } from '@clinicai/db';
import { isUniqueViolation } from '@clinicai/db';
import { cleanName, isValidEmail, isValidFullName, maskPhone, PRIVACY_NOTICE_VERSION, readWebBookingRef } from '@clinicai/shared';
import { IDLE, getString, text, type FlowContext, type FlowResult } from '../engine/flow';
import { classifyYesNo } from '../engine/matching';
import { contactPhoneOf, T } from '../engine/texts';
import type { IncomingMessage, OutgoingMessage } from '../engine/types';
import { recordWhatsApp } from '../engine/activity';
import { citaFlow } from './citaFlow';

export const REGISTER_YES = 'REGISTER_YES';
export const REGISTER_NO = 'REGISTER_NO';

const acceptButtons = (body: string): OutgoingMessage => ({
  type: 'buttons',
  body,
  buttons: [
    { id: REGISTER_YES, title: T.registerYes },
    { id: REGISTER_NO, title: T.registerNo },
  ],
});

function answerOf(message: IncomingMessage): 'yes' | 'no' | 'unknown' {
  if (message.payloadId === REGISTER_YES) return 'yes';
  if (message.payloadId === REGISTER_NO) return 'no';
  return classifyYesNo(message.text);
}

const notice = (ctx: FlowContext) => text(T.privacyNotice(ctx.tenant.clinicName, ctx.tenant.settings.privacyPolicyUrl));

/** The slot reference of the booking page (F27) in a message, if any. */
export function webRefOf(message: IncomingMessage): string | null {
  return message.type === 'text' ? (readWebBookingRef(message.text)?.code ?? null) : null;
}

/** After registering or accepting: go on with the slot chosen on the booking page. */
async function continueWithSlot(ctx: FlowContext, client: Client, code: string, before: OutgoingMessage[]): Promise<FlowResult> {
  const ref = readWebBookingRef(code);
  if (!ref) return { replies: before, next: IDLE };
  const result = await citaFlow.startAt({ ...ctx, client, state: null }, ref);
  return { ...result, replies: [...before, ...result.replies] };
}

export const registerFlow = {
  name: 'register' as const,

  start(ctx: FlowContext, webRef: string | null = null): FlowResult {
    return {
      replies: [text(T.registerIntro(ctx.tenant.clinicName)), notice(ctx), acceptButtons(T.registerQuestion)],
      next: { flow: 'register', step: 'askConsent', ...(webRef ? { data: { webRef } } : {}) },
    };
  },

  /** Existing client without accepted notice (created from the panel). */
  startConsent(ctx: FlowContext, client: Client, webRef: string | null = null): FlowResult {
    return {
      replies: [text(T.consentRequired(client.name, ctx.tenant.clinicName)), notice(ctx), acceptButtons(T.consentQuestion)],
      next: { flow: 'register', step: 'askConsentExisting', ...(webRef ? { data: { webRef } } : {}) },
    };
  },

  async handle(ctx: FlowContext, message: IncomingMessage): Promise<FlowResult> {
    const step = ctx.state?.step ?? 'askConsent';
    const data = ctx.state?.data ?? {};
    const { repos, logger } = ctx.deps;
    const consent = (at: Date) => ({ at, channel: 'whatsapp' as const, version: PRIVACY_NOTICE_VERSION });
    // F27: the slot reference of the booking page travels through every step.
    const webRef = getString(data, 'webRef');
    const keep = (values: Record<string, unknown>) => (webRef ? { ...values, webRef } : values);

    if (step === 'askConsentExisting') {
      const client = ctx.client;
      if (!client) return registerFlow.start(ctx);
      const answer = answerOf(message);
      if (answer === 'yes') {
        await repos.clients.recordConsent(ctx.tenant.id, client.id, consent(ctx.now));
        logger.info({ tenantId: ctx.tenant.id, phone: maskPhone(ctx.phone) }, 'privacy notice accepted via whatsapp');
        await recordWhatsApp(ctx, 'whatsapp.consent_accepted', { entityType: 'client', entityId: client.id, clientId: client.id });
        if (webRef) return continueWithSlot(ctx, { ...client, consentAt: ctx.now }, webRef, [text(T.consentThanksSlot)]);
        return { replies: [text(T.consentThanks)], next: IDLE };
      }
      if (answer === 'no') {
        return { replies: [text(T.consentDeclined(ctx.tenant.clinicName, contactPhoneOf(ctx.tenant)))], next: 'end' };
      }
      return { replies: [text(T.pleaseChooseOption), acceptButtons(T.consentQuestion)], next: { flow: 'register', step, data }, error: true };
    }

    if (step === 'askConsent') {
      const answer = answerOf(message);
      if (answer === 'yes') {
        return {
          replies: [text(T.registerStart), text(T.askFullName)],
          next: { flow: 'register', step: 'askName', data: keep({ consentAt: ctx.now.toISOString() }) },
        };
      }
      if (answer === 'no') {
        return { replies: [text(T.registerDeclined)], next: 'end' };
      }
      return { replies: [text(T.pleaseChooseOption), acceptButtons(T.registerQuestion)], next: { flow: 'register', step, data }, error: true };
    }

    const consentAt = getString(data, 'consentAt');
    if (!consentAt) {
      // State from before the notice existed: ask for the acceptance first.
      return registerFlow.start(ctx);
    }

    if (step === 'askName') {
      if (message.type !== 'text' || !isValidFullName(message.text)) {
        return { replies: [text(T.invalidName)], next: { flow: 'register', step, data }, error: true };
      }
      return {
        replies: [text(T.askEmail)],
        next: { flow: 'register', step: 'askEmail', data: { ...data, name: cleanName(message.text) } },
      };
    }

    // askEmail
    const email = message.text.trim().toLowerCase();
    const name = getString(data, 'name');
    if (!name) {
      return { replies: [text(T.askFullName)], next: { flow: 'register', step: 'askName', data: keep({ consentAt }) } };
    }
    if (!isValidEmail(email)) {
      return { replies: [text(T.invalidEmail)], next: { flow: 'register', step, data }, error: true };
    }
    const accepted = consent(new Date(consentAt));
    let clientId: string | null = null;
    try {
      clientId = (await repos.clients.create(ctx.tenant.id, { name, phone: ctx.phone, email, consent: accepted })).id;
    } catch (error) {
      // Registered meanwhile (e.g. from the web panel): complete the details and the acceptance.
      if (!isUniqueViolation(error)) throw error;
      const existing = await repos.clients.findByPhone(ctx.tenant.id, ctx.phone);
      if (existing) {
        await repos.clients.update(ctx.tenant.id, existing.id, { email: existing.email ?? email, consent: accepted });
        clientId = existing.id;
      }
    }
    logger.info({ tenantId: ctx.tenant.id, phone: maskPhone(ctx.phone) }, 'client registered via whatsapp');
    await recordWhatsApp(ctx, 'whatsapp.client_registered', { entityType: 'client', entityId: clientId, clientId });
    if (webRef && clientId) {
      const client = await repos.clients.findById(ctx.tenant.id, clientId);
      if (client) return continueWithSlot(ctx, client, webRef, [text(T.registeredSlot(ctx.tenant.clinicName, name))]);
    }
    return { replies: [text(T.registered(ctx.tenant.clinicName, name))], next: IDLE };
  },
};
