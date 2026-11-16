import { requestWaitlistCheck, type Db, type Repos } from '@clinicai/db';

/**
 * F21: after a change in the panel that may free a slot (cancellation, move, deletion, absence
 * removed, schedule widened), asks the bot to offer it to the waiting list now. Never fails the
 * change itself: if the job cannot be stored, the bot's periodic run finds the slot anyway.
 */
export async function notifyWaitlist(ctx: { db: Db; repos: Repos; tenantId: string }, reason: string): Promise<void> {
  try {
    const tenant = await ctx.repos.tenants.findById(ctx.tenantId);
    if (tenant?.settings.waitlistEnabled) await requestWaitlistCheck(ctx.db, ctx.tenantId, reason);
  } catch (error) {
    console.warn('waiting list check not queued', error instanceof Error ? error.message : error);
  }
}
