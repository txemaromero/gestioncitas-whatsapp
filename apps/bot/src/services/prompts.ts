import { readFileSync } from 'node:fs';

export type PromptName = 'intent' | 'parse-date' | 'faq-guard';

const cache = new Map<PromptName, string>();

/** Loads `src/prompts/<name>.txt` (cached). Prompts are files, never embedded in code. */
export function loadPrompt(name: PromptName): string {
  let prompt = cache.get(name);
  if (prompt === undefined) {
    prompt = readFileSync(new URL(`../prompts/${name}.txt`, import.meta.url), 'utf8').replace(/\r\n/g, '\n').trim();
    cache.set(name, prompt);
  }
  return prompt;
}

/** Replaces `{placeholder}` tokens. Unknown placeholders are left untouched. */
export function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
