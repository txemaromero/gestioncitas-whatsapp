/**
 * F31: platform console (`/plataforma`). Only for the accounts listed in PLATFORM_ADMIN_EMAILS
 * (Kinde emails, verified by the sign-in code); anyone else gets a 404. Read-only figures of every
 * clinic, with the system connection: no client data.
 */
import { getDatabase, platformOverview, type Db, type PlatformClinic } from '@clinicai/db';
import {
  emptyUsageTotals,
  estimateUsageCost,
  mergeUsageTotals,
  parsePlatformAdminEmails,
  resolveUsagePrices,
  type UsageCost,
  type UsagePrices,
  type UsageTotals,
} from '@clinicai/shared';

/** Whether the email is one of PLATFORM_ADMIN_EMAILS (or of `raw`, in tests). */
export function isPlatformAdmin(email: string | null | undefined, raw: string | undefined = process.env.PLATFORM_ADMIN_EMAILS): boolean {
  return Boolean(email) && parsePlatformAdminEmails(raw).has(email!.trim().toLowerCase());
}

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`;

export interface PlatformMonth {
  key: string;
  /** First instant of the month and of the next one (UTC). */
  from: Date;
  to: Date;
  previous: string;
  /** Null for the current month (nothing to see after it). */
  next: string | null;
}

/** The month of `?mes=YYYY-MM` (UTC), the current one when missing, invalid or in the future. */
export function platformMonth(raw: string | undefined, now: Date = new Date()): PlatformMonth {
  const current = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  const match = raw ? MONTH_PATTERN.exec(raw) : null;
  let year = match ? Number(match[1]) : current.year;
  let month = match ? Number(match[2]) : current.month;
  if (year * 12 + month > current.year * 12 + current.month || year < 2000) ({ year, month } = current);
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));
  const prev = new Date(Date.UTC(year, month - 2, 1));
  const isCurrent = year === current.year && month === current.month;
  return {
    key: monthKey(year, month),
    from,
    to,
    previous: monthKey(prev.getUTCFullYear(), prev.getUTCMonth() + 1),
    next: isCurrent ? null : monthKey(to.getUTCFullYear(), to.getUTCMonth() + 1),
  };
}

export interface PlatformClinicRow extends PlatformClinic {
  cost: UsageCost;
  /** Received a message or got an appointment booked this month. */
  active: boolean;
}

export interface PlatformConsole {
  month: PlatformMonth;
  clinics: PlatformClinicRow[];
  totals: {
    clinics: number;
    active: number;
    usage: UsageTotals;
    appointments: { whatsapp: number; web: number };
    cost: { ai: number; whatsapp: number };
    unpriced: string[];
  };
  prices: UsagePrices;
  /** Why PLATFORM_PRICES was ignored, if it was. */
  pricesError: string | null;
}

export async function loadPlatformConsole(
  rawMonth: string | undefined,
  options: { db?: Db; now?: Date; pricesRaw?: string } = {},
): Promise<PlatformConsole> {
  const now = options.now ?? new Date();
  const month = platformMonth(rawMonth, now);
  const { prices, error } = resolveUsagePrices('pricesRaw' in options ? options.pricesRaw : process.env.PLATFORM_PRICES);
  const overview = await platformOverview(options.db ?? getDatabase().system, { from: month.from, to: month.to }, now);
  const clinics = overview.map((c) => ({
    ...c,
    cost: estimateUsageCost(c.usage, prices),
    active: c.usage.inbound > 0 || c.appointments.whatsapp + c.appointments.web > 0,
  }));
  const unpriced = new Set<string>();
  const totals = clinics.reduce(
    (acc, c) => {
      c.cost.unpriced.forEach((m) => unpriced.add(m));
      return {
        ...acc,
        active: acc.active + (c.active ? 1 : 0),
        usage: mergeUsageTotals(acc.usage, c.usage),
        appointments: {
          whatsapp: acc.appointments.whatsapp + c.appointments.whatsapp,
          web: acc.appointments.web + c.appointments.web,
        },
        cost: { ai: acc.cost.ai + c.cost.ai, whatsapp: acc.cost.whatsapp + c.cost.whatsapp },
      };
    },
    {
      clinics: clinics.length,
      active: 0,
      usage: emptyUsageTotals(),
      appointments: { whatsapp: 0, web: 0 },
      cost: { ai: 0, whatsapp: 0 },
      unpriced: [] as string[],
    },
  );
  return { month, clinics, totals: { ...totals, unpriced: [...unpriced].sort() }, prices, pricesError: error };
}
