/**
 * CU-C3 Preguntar duda: answers with the tenant FAQ prompt (uploaded .txt) or the default
 * template filled with public tenant data and, F29, the information filled in Settings. The
 * conversation stays open (next message is classified again).
 */
import { buildDefaultFaqPrompt } from '@clinicai/shared';
import { IDLE, text, type Flow, type FlowContext, type FlowResult } from '../engine/flow';
import { T, contactPhoneOf } from '../engine/texts';
import type { IncomingMessage } from '../engine/types';
import { reviewFaqAnswer } from '../services/faqAnswer';
import { loadPrompt } from '../services/prompts';

export async function resolveFaqPrompt(ctx: FlowContext): Promise<string> {
  const { tenant } = ctx;
  if (tenant.settings.faqPrompt?.trim()) return tenant.settings.faqPrompt;
  const [employees, services] = await Promise.all([
    ctx.deps.repos.employees.list(tenant.id),
    ctx.deps.repos.services.list(tenant.id, { activeOnly: true }),
  ]);
  return buildDefaultFaqPrompt({
    clinicName: tenant.clinicName,
    phone: contactPhoneOf(tenant),
    sector: tenant.settings.sector,
    employees,
    info: tenant.settings.assistantInfo,
    services,
  });
}

export const faqFlow: Flow = {
  name: 'faq',

  async handle(ctx: FlowContext, message: IncomingMessage): Promise<FlowResult> {
    const faqPrompt = await resolveFaqPrompt(ctx);
    const answer = await ctx.deps.ai.answerFaq({ faqPrompt }, message.text);
    // F32: the answer speaks for the clinic: checked before sending (only the reason is logged).
    const problem = reviewFaqAnswer(answer, { faqPrompt, guard: loadPrompt('faq-guard') });
    if (problem) {
      ctx.deps.logger.warn({ tenantId: ctx.tenant.id, problem, chars: answer.length }, 'faq answer replaced');
      return { replies: [text(T.faqFallback(contactPhoneOf(ctx.tenant)))], next: IDLE };
    }
    return { replies: [text(answer)], next: IDLE };
  },
};
