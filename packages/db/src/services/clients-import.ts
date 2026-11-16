/**
 * F23: import of clients from a CSV (owner and administrators, from the panel). The file is parsed
 * and validated in @clinicai/shared; here the rows whose phone already exists in the clinic are
 * left out, and the rest are created in a single statement (all or nothing). The unique index
 * (tenant_id, phone) also skips anyone created with the same phone in the meantime.
 */
import {
  PRIVACY_NOTICE_VERSION,
  parseClientsCsv,
  type ImportedClientRow,
  type ParsedClientsCsv,
  type SkippedClientRow,
} from '@clinicai/shared';
import type { Db } from '../client';

/** The file cannot be imported at all (empty, no name column, too many rows…). */
export class ClientImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientImportError';
  }
}

export interface ClientImportPlan {
  total: number;
  toImport: ImportedClientRow[];
  skipped: SkippedClientRow[];
  columns: ParsedClientsCsv['columns'];
  ignoredColumns: string[];
}

export async function planClientImport(db: Db, tenantId: string, text: string): Promise<ClientImportPlan> {
  const parsed = parseClientsCsv(text);
  if ('error' in parsed) throw new ClientImportError(parsed.error);
  const phones = parsed.rows.map((r) => r.phone).filter((p): p is string => Boolean(p));
  const existing = phones.length
    ? new Set(
        (await db.client.findMany({ where: { tenantId, phone: { in: phones } }, select: { phone: true } })).map((c) => c.phone),
      )
    : new Set<string | null>();
  const toImport: ImportedClientRow[] = [];
  const skipped = [...parsed.skipped];
  for (const row of parsed.rows) {
    if (row.phone && existing.has(row.phone)) {
      skipped.push({ row: row.row, name: row.name, reason: 'Ya existe un cliente con ese teléfono en la clínica' });
    } else {
      toImport.push(row);
    }
  }
  skipped.sort((a, b) => a.row - b.row);
  return { total: parsed.total, toImport, skipped, columns: parsed.columns, ignoredColumns: parsed.ignoredColumns };
}

/**
 * Creates the valid rows. With `consent`, the clinic states that these clients already accepted the
 * privacy policy (e.g. signed at the clinic): recorded as web consent with the current notice
 * version. Without it, the bot shows them the notice in their first message (F12).
 */
export async function importClients(
  db: Db,
  tenantId: string,
  text: string,
  options: { consent: boolean; now?: Date },
): Promise<{ total: number; imported: number; skipped: SkippedClientRow[] }> {
  const plan = await planClientImport(db, tenantId, text);
  const now = options.now ?? new Date();
  const consent = options.consent ? { consentAt: now, consentChannel: 'web' as const, consentVersion: PRIVACY_NOTICE_VERSION } : {};
  const { count } = plan.toImport.length
    ? await db.client.createMany({
        data: plan.toImport.map((r) => ({ tenantId, name: r.name, phone: r.phone, email: r.email, notes: r.notes, ...consent })),
        skipDuplicates: true,
      })
    : { count: 0 };
  return { total: plan.total, imported: count, skipped: plan.skipped };
}
