/**
 * CU-C1 Iniciar chat. Entry point of a new conversation (no active state).
 * Registered client → greeting (+ AI Act notice) and, if the first message already contains a
 * request, it goes straight to intentionFlow. New client → registerFlow. Client without an
 * accepted privacy notice (created from the panel) → acceptance first (F12).
 */
import { IDLE, text, type Flow, type FlowContext, type FlowResult } from '../engine/flow';
import { isGreetingOnly } from '../engine/matching';
import { T } from '../engine/texts';
import type { IncomingMessage } from '../engine/types';
import { intentionFlow } from './intentionFlow';
import { MANAGE_LIST_ID, NEW_BOOKING_ID } from './manageFlow';
import { registerFlow, webRefOf } from './registerFlow';

export const mainFlow: Flow = {
  name: 'main',

  async handle(ctx: FlowContext, message: IncomingMessage): Promise<FlowResult> {
    const { client, tenant } = ctx;
    // F27: a first message from the booking page keeps its slot through the registration.
    if (!client) {
      return registerFlow.start(ctx, webRefOf(message));
    }
    if (!client.consentAt) {
      return registerFlow.startConsent(ctx, client, webRefOf(message));
    }
    // Greeting buttons pressed after the conversation expired: act on them directly.
    if (message.payloadId === MANAGE_LIST_ID || message.payloadId === NEW_BOOKING_ID) {
      return intentionFlow.handle({ ...ctx, state: null }, message);
    }
    const greeting = text(`${T.welcomeBack(client.name, tenant.clinicName)}\n${T.aiNotice(tenant.clinicName)}`);
    if (message.type !== 'text' || isGreetingOnly(message.text)) {
      // F13: clients with upcoming appointments get shortcuts to see them or book another one.
      const upcoming = await ctx.deps.repos.appointments.upcomingForClient(tenant.id, client.id, ctx.now);
      if (upcoming.length === 0) return { replies: [greeting, text(T.howCanIHelp)], next: IDLE };
      return {
        replies: [
          greeting,
          {
            type: 'buttons',
            body: T.howCanIHelpWithAppointments(upcoming.length),
            buttons: [
              { id: MANAGE_LIST_ID, title: T.myAppointments },
              { id: NEW_BOOKING_ID, title: T.newAppointment },
            ],
          },
        ],
        next: IDLE,
      };
    }
    // The first message already contains a request: do not ask the client to repeat it.
    const result = await intentionFlow.handle({ ...ctx, state: null }, message);
    return { ...result, replies: [greeting, ...result.replies] };
  },
};
