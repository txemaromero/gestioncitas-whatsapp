/**
 * F32: deterministic checks on the FAQ answer before it reaches the client. It is the only free
 * text of the LLM that the client reads, so a manipulated answer must not speak for the clinic:
 *  - at most FAQ_ANSWER_MAX_CHARS (the prompt asks for one or two sentences; a long text is usually
 *    the prompt being dumped);
 *  - links, emails and phone numbers only if they appear in the clinic's own text;
 *  - no line of the system instructions (`faq-guard.txt`) repeated;
 *  - no claim of having booked, confirmed or cancelled anything (the LLM cannot do that: only the
 *    booking flows can).
 * A rejected answer is replaced by a fixed text; only the reason is logged, never the text.
 */
export const FAQ_ANSWER_MAX_CHARS = 700;

export type FaqAnswerProblem = 'empty' | 'too_long' | 'unknown_link' | 'unknown_email' | 'unknown_phone' | 'instructions' | 'action_claim';

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'()]+/gi;
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
/** Runs of digits with spaces, dots or dashes in between; phone numbers have at least 9 digits. */
const PHONE_PATTERN = /\+?\d[\d\s.-]{7,}\d/g;
const ACTION_CLAIM_PATTERN =
  /\b(?:he|hemos)\s+(?:reservado|confirmado|cancelado|anulado|apuntado|cambiado|movido|programado)\b|\btu\s+cita\s+(?:est[aá]|queda|ha\s+quedado|ha\s+sido)\s+(?:confirmada|reservada|cancelada|anulada|cambiada)\b/i;

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const bareUrl = (url: string) => url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[.,;:!?]+$/, '').replace(/\/$/, '');
const digits = (s: string) => s.replace(/\D/g, '');
/** Last 9 digits: the national number, with or without the country code. */
const phoneKeys = (text: string) =>
  new Set((text.match(PHONE_PATTERN) ?? []).map(digits).filter((d) => d.length >= 9).map((d) => d.slice(-9)));

export function reviewFaqAnswer(answer: string, source: { faqPrompt: string; guard: string }): FaqAnswerProblem | null {
  const text = answer.trim();
  if (!text) return 'empty';
  if (text.length > FAQ_ANSWER_MAX_CHARS) return 'too_long';

  const prompt = source.faqPrompt.toLowerCase();
  if ((text.match(URL_PATTERN) ?? []).some((url) => !prompt.includes(bareUrl(url)))) return 'unknown_link';
  if ((text.match(EMAIL_PATTERN) ?? []).some((email) => !prompt.includes(email.toLowerCase()))) return 'unknown_email';
  const known = phoneKeys(source.faqPrompt);
  if ([...phoneKeys(text)].some((key) => !known.has(key))) return 'unknown_phone';

  const answerText = normalize(text);
  const guardLines = source.guard
    .split('\n')
    .map((line) => normalize(line.replace(/^[-•]\s*/, '')))
    .filter((line) => line.length >= 25);
  if (guardLines.some((line) => answerText.includes(line))) return 'instructions';
  if (ACTION_CLAIM_PATTERN.test(text)) return 'action_claim';
  return null;
}
