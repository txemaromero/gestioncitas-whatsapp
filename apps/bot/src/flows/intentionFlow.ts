/**
 * RF-W2: the LLM classifies each free message as CITA or FAQ (validated against the enum;
 * anything else is FAQ). CITA → citaFlow, FAQ → faqFlow.
 * F13: before that, requests about the client's existing appointments ("mis citas", "cancelar
 * mi cita", "cambiar la cita") and the greeting buttons are routed with rules, not the LLM.
 * F26: so are questions about the sessions left of their packs.
 * F27: a slot chosen on the public booking page goes straight to that slot.
 */
import { readWebBookingRef } from '@clinicai/shared';
import type { Flow, FlowContext, FlowResult } from '../engine/flow';
import { detectManageRequest, detectPackRequest, type ManageAction } from '../engine/matching';
import type { IncomingMessage } from '../engine/types';
import { citaFlow } from './citaFlow';
import { faqFlow } from './faqFlow';
import { MANAGE_LIST_ID, manageFlow, NEW_BOOKING_ID } from './manageFlow';
import { packsReply } from './packsFlow';

export const intentionFlow: Flow = {
  name: 'intention',

  async handle(ctx: FlowContext, message: IncomingMessage): Promise<FlowResult> {
    if (message.payloadId === NEW_BOOKING_ID) return citaFlow.start({ ...ctx, state: null });
    const webRef = message.type === 'text' ? readWebBookingRef(message.text) : null;
    if (webRef && ctx.client) return citaFlow.startAt({ ...ctx, state: null }, webRef);
    if (ctx.client) {
      const manage: ManageAction | null =
        message.payloadId === MANAGE_LIST_ID ? 'list' : message.type === 'text' ? detectManageRequest(message.text) : null;
      if (manage) return manageFlow.start({ ...ctx, state: null }, manage);
      if (message.type === 'text' && detectPackRequest(message.text)) return packsReply(ctx);
    }
    const intent = await ctx.deps.ai.detectIntent(message.text, ctx.tenant.settings.sector);
    ctx.deps.logger.debug({ tenantId: ctx.tenant.id, intent }, 'intent detected');
    if (intent === 'CITA') {
      return citaFlow.start({ ...ctx, state: null }, message);
    }
    return faqFlow.handle({ ...ctx, state: null }, message);
  },
};
