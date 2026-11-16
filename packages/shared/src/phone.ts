import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Normalizes a phone number to E.164 (`+34600123456`). Accepts WhatsApp `wa_id`
 * values without `+` (`34600123456`) and national numbers (default country ES).
 * Returns null when the number is not valid.
 */
export function normalizePhone(input: string, defaultCountry: CountryCode = 'ES'): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const compact = raw.replace(/[\s().-]/g, '');
  const candidates: string[] = [];
  if (compact.startsWith('+')) candidates.push(compact);
  else if (compact.startsWith('00')) candidates.push(`+${compact.slice(2)}`);
  else {
    candidates.push(compact);
    if (/^\d{10,15}$/.test(compact)) candidates.push(`+${compact}`);
  }
  for (const candidate of candidates) {
    const parsed = parsePhoneNumberFromString(candidate, defaultCountry);
    if (parsed?.isValid()) return parsed.number;
  }
  return null;
}

/** Normalizes a WhatsApp `wa_id` / `from` (digits only) to E.164. */
export function waIdToE164(waId: string): string {
  const digits = waId.replace(/\D/g, '');
  return normalizePhone(`+${digits}`) ?? `+${digits}`;
}

/** E.164 → WhatsApp recipient (digits only). */
export function e164ToWaId(phone: string): string {
  return phone.replace(/\D/g, '');
}

/** `+34600123456` → `+34*****3456` (for logs). */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '-';
  if (phone.length <= 6) return '***';
  return `${phone.slice(0, 3)}${'*'.repeat(Math.max(3, phone.length - 7))}${phone.slice(-4)}`;
}

/** `nombre@gmail.com` → `n*****@gmail.com` (for logs). */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '-';
  const [user, domain] = email.split('@');
  if (!user || !domain) return '***';
  return `${user.slice(0, 1)}*****@${domain}`;
}
