/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalizeText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s@.+:/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function isValidEmail(input: string): boolean {
  const value = input.trim();
  return value.length <= 254 && EMAIL_REGEX.test(value);
}

/** Full name: 2-80 chars with at least one letter. */
export function isValidFullName(input: string): boolean {
  const value = input.trim();
  return value.length >= 2 && value.length <= 80 && /\p{L}/u.test(value);
}

export function cleanName(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

/** Truncates text to `max` characters (used before sending user input to the LLM). */
export function truncate(input: string, max: number): string {
  return input.length > max ? input.slice(0, max) : input;
}
