import { ACTIVITY_RETENTION_MONTHS, anonymizeInactiveClients, purgeActivity, purgeUsage, purgeWaitlist } from '@clinicai/db';
import { USAGE_RETENTION_MONTHS } from '@clinicai/shared';
import type { AppDeps } from '../deps';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Done events double as idempotency records (Meta retries for days): keep them 7 days. */
const DONE_EVENTS_RETENTION_MS = 7 * DAY_MS;
/** Failed events keep their payload for inspection: 30 days. */
const FAILED_EVENTS_RETENTION_MS = 30 * DAY_MS;
/** Finished waiting list entries (F17) are kept 30 days, then deleted. */
const WAITLIST_RETENTION_MS = 30 * DAY_MS;

/** Maintenance spans every clinic (F19: owner connection). */
type MaintenanceDeps = Pick<AppDeps, 'systemDb' | 'systemRepos' | 'clock' | 'logger'>;

/**
 * Purges finished inbound events (wall clock) and expired conversation states, and applies the
 * retention policy of each clinic (F12: anonymise clients without appointments for N months).
 * F17: deletes waiting list entries finished (or whose day passed) more than 30 days ago.
 * F24: deletes activity log entries older than ACTIVITY_RETENTION_MONTHS (2 years).
 * F31: deletes usage counters older than USAGE_RETENTION_MONTHS (2 years).
 */
export async function runMaintenance(
  deps: MaintenanceDeps,
): Promise<{ events: number; states: number; anonymized: number; waitlist: number; activity: number; usage: number }> {
  const wallNow = Date.now();
  const events = await deps.systemRepos.inboundEvents.purge(
    new Date(wallNow - DONE_EVENTS_RETENTION_MS),
    new Date(wallNow - FAILED_EVENTS_RETENTION_MS),
  );
  const states = await deps.systemRepos.conversations.purgeExpired(deps.clock.now());
  const { clients: anonymized } = await anonymizeInactiveClients(deps.systemDb, deps.clock.now());
  const waitlist = await purgeWaitlist(deps.systemDb, new Date(deps.clock.now().getTime() - WAITLIST_RETENTION_MS));
  const activityCutoff = new Date(deps.clock.now());
  activityCutoff.setUTCMonth(activityCutoff.getUTCMonth() - ACTIVITY_RETENTION_MONTHS);
  const activity = await purgeActivity(deps.systemDb, activityCutoff);
  const usageCutoff = new Date(deps.clock.now());
  usageCutoff.setUTCMonth(usageCutoff.getUTCMonth() - USAGE_RETENTION_MONTHS);
  const usage = await purgeUsage(deps.systemDb, usageCutoff);
  deps.logger.info({ events, states, anonymized, waitlist, activity, usage }, 'maintenance done');
  return { events, states, anonymized, waitlist, activity, usage };
}

/** Runs maintenance now and every `intervalMs` (default 6 h). Returns a stop function. */
export function scheduleMaintenance(deps: MaintenanceDeps, intervalMs = 6 * 60 * 60 * 1000): () => void {
  const run = () => {
    runMaintenance(deps).catch((error: unknown) => {
      deps.logger.error({ err: error instanceof Error ? error.message : String(error) }, 'maintenance failed');
    });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
