/**
 * F29: rewrites `prisma/seed-data/fisiodemo-faq.txt`, the FAQ prompt of FisioDemo that the AI
 * evaluation uses, from its data and the shared template. Run it after changing either; the
 * «Evaluación IA» workflow then evaluates the new text.
 *
 *   pnpm --filter @clinicai/db faq:fisiodemo
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fisiodemoFaqPrompt } from '../prisma/seed-data/fisiodemo';

const file = path.resolve(import.meta.dirname, '../prisma/seed-data/fisiodemo-faq.txt');
writeFileSync(file, `${fisiodemoFaqPrompt()}\n`, 'utf8');
process.stdout.write(`Escrito ${path.relative(process.cwd(), file)}\n`);
