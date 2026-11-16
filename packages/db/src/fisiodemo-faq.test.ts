/**
 * F29 — the FAQ prompt the AI evaluation uses (`fisiodemo-faq.txt`) is exactly what the bot builds
 * for FisioDemo from its information and the shared template. If the template or the data change,
 * run `pnpm --filter @clinicai/db faq:fisiodemo`: the new text triggers the «Evaluación IA» workflow.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fisiodemoFaqPrompt } from '../prisma/seed-data/fisiodemo';

describe('FisioDemo FAQ prompt (F29)', () => {
  it('the evaluated text is the one the bot generates', () => {
    const evaluated = readFileSync(path.resolve(import.meta.dirname, '../prisma/seed-data/fisiodemo-faq.txt'), 'utf8');
    expect(`${fisiodemoFaqPrompt()}\n`).toBe(evaluated);
  });
});
