/**
 * Data protection (F12, GDPR) constants shared by the bot, the web panel and the database layer.
 */
import { z } from 'zod';

/**
 * Version of the privacy notice shown by the bot. Stored with each acceptance
 * (`clients.consent_version`); bump it when the notice text changes materially.
 */
export const PRIVACY_NOTICE_VERSION = '2026-11-12';

/** Retention options offered in the panel (months without appointments before anonymising). */
export const RETENTION_MONTH_OPTIONS = [12, 24, 36, 60] as const;
export const RETENTION_MONTHS_MIN = 6;
export const RETENTION_MONTHS_MAX = 120;

/** Name given to a client whose personal data were removed by the retention policy. */
export const ANONYMIZED_CLIENT_NAME = 'Cliente anonimizado';

/** Public privacy policy URL of a clinic: only http(s), so it can be shown as a link anywhere. */
export const privacyPolicyUrlSchema = z.url({ protocol: /^https?$/, error: 'Debe ser una URL http(s) válida' }).max(500);
