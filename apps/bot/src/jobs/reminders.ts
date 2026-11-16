/**
 * RF-W4 / CU-C8: reminders via an approved Meta template (outside the 24 h window only templates
 * are allowed), safe with several instances (advisory lock + atomic claim):
 *  - First reminder, at most once per appointment (`reminder_sent_at`): pending appointments of the
 *    next `reminderDaysBefore` days (1 or 2), from the clinic's `reminderHour` on.
 *  - F30: optional second reminder the same day (`second_reminder_sent_at`), `secondReminderHours`
 *    before, for pending and confirmed appointments booked before that margin.
 * Nothing is sent outside the reminder window (08:00–21:00 local; a later reminder hour moves the
 * end). The cron runs every 15 minutes; the hour of each clinic and the marks avoid duplicates.
 */
import {
  claimDueReminders,
  claimSecondReminders,
  releaseReminderClaim,
  releaseSecondReminderClaim,
  runWithTenant,
  type Tenant,
} from '@clinicai/db';
import {
  formatTime,
  formatWeekdayDayMonth,
  getZonedMinutesOfDay,
  maskPhone,
  parseHHmm,
  REMINDER_WINDOW,
  zonedDayRange,
} from '@clinicai/shared';
import cron from 'node-cron';
import type { AppDeps } from '../deps';
import type { EngineObserver } from '../engine/engine';
import { T, firstName } from '../engine/texts';
import type { OutgoingMessage } from '../engine/types';
import { REMINDER_CANCEL, REMINDER_CONFIRM } from '../flows/reminderResponseFlow';
import { resolveWaAccount, type WaAccount } from '../services/whatsapp';

export interface ReminderRunResult {
  tenants: number;
  /** First reminders sent. */
  sent: number;
  /** F30: second reminders sent. */
  second: number;
  failed: number;
  /** Tenants skipped because it is not the time of any of their reminders. */
  skipped: number;
}

export interface ReminderOptions {
  /** Ignore the reminder hour and window (manual runs). */
  force?: boolean;
  tenantId?: string;
}

export function buildReminderTemplate(
  deps: Pick<AppDeps, 'config'>,
  tenant: Tenant,
  appointment: { id: string; date: Date; client: { name: string } },
): Extract<OutgoingMessage, { type: 'template' }> {
  const day = formatWeekdayDayMonth(appointment.date, tenant.timezone);
  const time = formatTime(appointment.date, tenant.timezone);
  const name = firstName(appointment.client.name);
  return {
    type: 'template',
    name: deps.config.WA_REMINDER_TEMPLATE,
    language: deps.config.WA_TEMPLATE_LANGUAGE,
    // "Hola {{1}}, te recordamos tu cita en {{2}} el {{3}} a las {{4}}."
    bodyParams: [name, tenant.clinicName, day, time],
    quickReplyPayloads: [`${REMINDER_CONFIRM}${appointment.id}`, `${REMINDER_CANCEL}${appointment.id}`],
    preview: T.reminderPreview(name, tenant.clinicName, day, time),
    previewButtons: [T.reminderButtonConfirm, T.reminderButtonCancel],
  };
}

type Reminded = { id: string; date: Date; client: { name: string; phone: string | null } };

/** Sends the claimed reminders; a failed one is released so a later run retries it. */
async function send(
  deps: AppDeps,
  tenant: Tenant,
  account: WaAccount,
  appointments: Reminded[],
  release: (appointmentId: string) => Promise<void>,
  observer: EngineObserver,
): Promise<{ sent: number; failed: number }> {
  const counts = { sent: 0, failed: 0 };
  for (const appointment of appointments) {
    const phone = appointment.client.phone;
    if (!phone) continue;
    const message = buildReminderTemplate(deps, tenant, appointment);
    try {
      await deps.whatsapp.send(account, phone, message);
      counts.sent += 1;
      observer.onOutgoing?.(tenant, phone, [message]);
    } catch (error) {
      counts.failed += 1;
      await release(appointment.id);
      deps.logger.error(
        {
          tenantId: tenant.id,
          appointmentId: appointment.id,
          phone: maskPhone(phone),
          err: error instanceof Error ? error.message : String(error),
        },
        'reminder not sent',
      );
    }
  }
  return counts;
}

export async function checkAndSendReminders(
  deps: AppDeps,
  options: ReminderOptions = {},
  observer: EngineObserver = {},
): Promise<ReminderRunResult> {
  const now = deps.clock.now();
  const result: ReminderRunResult = { tenants: 0, sent: 0, second: 0, failed: 0, skipped: 0 };
  const tenants = options.tenantId
    ? [await deps.systemRepos.tenants.findById(options.tenantId)].filter((t): t is Tenant => t !== null)
    : await deps.systemRepos.tenants.listAll();

  for (const tenant of tenants) {
    const { reminderHour, reminderDaysBefore, secondReminderHours } = tenant.settings;
    const minutes = getZonedMinutesOfDay(now, tenant.timezone);
    const hour = parseHHmm(reminderHour);
    const windowStart = parseHHmm(REMINDER_WINDOW.from);
    const windowEnd = parseHHmm(REMINDER_WINDOW.to);
    const firstDue = options.force || (minutes >= hour && minutes < Math.max(windowEnd, hour + 60));
    const secondDue = secondReminderHours !== null && (options.force || (minutes >= windowStart && minutes < windowEnd));
    if (!firstDue && !secondDue) {
      result.skipped += 1;
      continue;
    }
    const account = resolveWaAccount(tenant, deps.config);
    if (!account) {
      deps.logger.warn({ tenantId: tenant.id }, 'tenant without WhatsApp credentials: reminders skipped');
      continue;
    }
    result.tenants += 1;
    // F19: each clinic's reminders run in its own context.
    await runWithTenant(tenant.id, async () => {
      if (firstDue) {
        // From tomorrow to the last day of the margin: an appointment booked after the reminder of
        // its day had gone out still gets one.
        const range = { start: zonedDayRange(now, 1, tenant.timezone).start, end: zonedDayRange(now, reminderDaysBefore, tenant.timezone).end };
        const due = await claimDueReminders(deps.db, tenant.id, range, now);
        const counts = await send(deps, tenant, account, due, (id) => releaseReminderClaim(deps.db, tenant.id, id), observer);
        result.sent += counts.sent;
        result.failed += counts.failed;
      }
      if (secondDue && secondReminderHours !== null) {
        const due = await claimSecondReminders(deps.db, tenant.id, { now, hours: secondReminderHours });
        const counts = await send(deps, tenant, account, due, (id) => releaseSecondReminderClaim(deps.db, tenant.id, id), observer);
        result.second += counts.sent;
        result.failed += counts.failed;
      }
    });
  }
  deps.logger.info({ ...result }, 'reminders run finished');
  return result;
}

/** Schedules the job (REMINDER_CRON in REMINDER_CRON_TZ, default every 15 minutes in Madrid). */
export function startReminderCron(deps: AppDeps, observer: EngineObserver = {}): { stop: () => void } {
  const { REMINDER_CRON, REMINDER_CRON_TZ } = deps.config;
  if (!cron.validate(REMINDER_CRON)) {
    throw new Error(`REMINDER_CRON inválido: ${REMINDER_CRON}`);
  }
  const task = cron.schedule(
    REMINDER_CRON,
    async () => {
      try {
        await checkAndSendReminders(deps, {}, observer);
      } catch (error) {
        deps.logger.error({ err: error instanceof Error ? error.message : String(error) }, 'reminders run failed');
      }
    },
    { timezone: REMINDER_CRON_TZ, name: 'reminders', noOverlap: true },
  );
  deps.logger.info({ cron: REMINDER_CRON, timezone: REMINDER_CRON_TZ }, 'reminder cron scheduled');
  return { stop: () => void task.stop() };
}
