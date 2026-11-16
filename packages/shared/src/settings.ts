import { z } from 'zod';
import { privacyPolicyUrlSchema, RETENTION_MONTHS_MAX, RETENTION_MONTHS_MIN } from './privacy';

export const DEFAULT_SECTOR = 'clínica de fisioterapia';
export const FAQ_PROMPT_MAX_BYTES = 20 * 1024;
export const MIN_NOTICE_HOURS_MAX = 168;
/** F30: the first reminder goes this many days before (at `reminderHour`). */
export const REMINDER_DAYS_BEFORE_OPTIONS = [1, 2] as const;
/** F30: hours before the appointment of the optional second reminder (same day). */
export const SECOND_REMINDER_HOUR_OPTIONS = [2, 3, 4] as const;
/** F30: reminders are only sent between these local times (a reminder hour after the end moves it). */
export const REMINDER_WINDOW = { from: '08:00', to: '21:00' } as const;
/** Options offered in the panel for `minNoticeHours` (0 = no limit). */
export const MIN_NOTICE_HOUR_OPTIONS = [0, 2, 6, 12, 24, 48, 72] as const;

export const chatwootTenantSettingsSchema = z.object({
  accountId: z.number().int().positive(),
  inboxId: z.number().int().positive(),
  baseUrl: z.url(),
});

/**
 * F29: what the assistant knows about the clinic, filled in Settings instead of uploading a .txt.
 * Empty fields become «Consultar por teléfono» in the prompt (see `buildDefaultFaqPrompt`).
 */
export const assistantInfoSchema = z.object({
  address: z.string().trim().max(200).default(''),
  city: z.string().trim().max(80).default(''),
  /** Empty: computed from the professionals' schedules. */
  hours: z.string().trim().max(300).default(''),
  payments: z.string().trim().max(300).default(''),
  insurers: z.string().trim().max(500).default(''),
  parking: z.string().trim().max(300).default(''),
  /** One line per service or treatment (with its price, if wanted). Empty: the panel's services. */
  services: z.array(z.string().trim().min(1).max(200)).max(40).default([]),
  /** «Información importante», one line each. */
  notes: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
});
export type AssistantInfo = z.infer<typeof assistantInfoSchema>;

/** `tenant_config.settings` JSON, validated with zod and filled with defaults. */
export const tenantSettingsSchema = z.object({
  faqPrompt: z.string().max(FAQ_PROMPT_MAX_BYTES).nullable().default(null),
  slotMinutes: z.number().int().min(10).max(480).default(60),
  reminderHour: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('08:00'),
  /** F30: days before the appointment of the first reminder. */
  reminderDaysBefore: z.number().int().min(1).max(2).default(1),
  /** F30: hours before of a second reminder the same day; null = no second reminder. */
  secondReminderHours: z
    .number()
    .int()
    .refine((v) => (SECOND_REMINDER_HOUR_OPTIONS as readonly number[]).includes(v))
    .nullable()
    .default(null),
  contactPhone: z.string().default(''),
  sector: z.string().min(2).max(80).default(DEFAULT_SECTOR),
  chatwoot: chatwootTenantSettingsSchema.optional(),
  /** Linked from the privacy notice the bot shows before registering anyone (F12). */
  privacyPolicyUrl: privacyPolicyUrlSchema.nullable().default(null),
  /** Clients can cancel or change an appointment by WhatsApp up to this many hours before it (F13). */
  minNoticeHours: z.number().int().min(0).max(MIN_NOTICE_HOURS_MAX).default(24),
  /** Anonymise clients without appointments for this many months; null = disabled (F12). */
  retentionMonths: z.number().int().min(RETENTION_MONTHS_MIN).max(RETENTION_MONTHS_MAX).nullable().default(null),
  /**
   * Waiting list (F17): the bot offers to notify clients when a slot frees up. Off by default:
   * it needs its own WhatsApp template approved by Meta.
   */
  waitlistEnabled: z.boolean().default(false),
  /** Packs (F26): a no-show also spends a session (by default only attended appointments do). */
  packNoShowSpends: z.boolean().default(false),
  /** Public booking page (F27, `tenant_config.public_slug`): off until the clinic publishes it. */
  bookingPageEnabled: z.boolean().default(false),
  /** F29: information for the FAQ answers; null until filled in Settings. */
  assistantInfo: assistantInfoSchema.nullable().default(null),
});
export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

/** Parses DB JSON into settings; invalid keys fall back to defaults instead of throwing. */
export function parseTenantSettings(value: unknown): TenantSettings {
  const base: Record<string, unknown> =
    typeof value === 'object' && value !== null ? { ...(value as Record<string, unknown>) } : {};
  const parsed = tenantSettingsSchema.safeParse(base);
  if (parsed.success) return parsed.data;
  // Drop the offending keys and retry, so one bad field never breaks the bot.
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string') delete base[key];
  }
  return tenantSettingsSchema.parse(base);
}
