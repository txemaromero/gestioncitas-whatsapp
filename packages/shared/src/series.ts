/**
 * F26: treatments, a series of appointments at the same local time on chosen weekdays, every week
 * or every two weeks. Pure date logic in the clinic's zone (DST safe); availability of each date is
 * checked in the database layer (`planSeries`).
 */
import { getZonedParts, zonedTimeToUtc } from './dates';

export const SERIES_MIN_SESSIONS = 2;
export const SERIES_MAX_SESSIONS = 30;
export const SERIES_INTERVALS = [1, 2] as const;
export type SeriesInterval = (typeof SERIES_INTERVALS)[number];
/**
 * Dates that cannot be booked are skipped and replaced by the next ones of the pattern, looking
 * at most this many weeks of the pattern beyond the sessions asked for.
 */
export const SERIES_EXTRA_WEEKS = 8;

export interface SeriesPattern {
  /** Date and local time of the series: sessions are at this time, from this date on. */
  first: Date;
  /** 0 = Sunday … 6 = Saturday, as `getZonedParts().weekday`. */
  weekdays: number[];
  intervalWeeks: SeriesInterval;
  timeZone: string;
}

/** Monday = 0 … Sunday = 6. */
const mondayIndex = (weekday: number) => (weekday + 6) % 7;

/**
 * Candidate starts in order: the pattern's weekdays from the week (Monday to Sunday) of `first`,
 * every `intervalWeeks` weeks, at the local time of `first`, never before `first`. At most `limit`.
 */
export function seriesCandidates(pattern: SeriesPattern, limit: number): Date[] {
  const days = [...new Set(pattern.weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort(
    (a, b) => mondayIndex(a) - mondayIndex(b),
  );
  if (days.length === 0 || limit <= 0) return [];
  const p = getZonedParts(pattern.first, pattern.timeZone);
  // Local midnight of the Monday of the first week, as a UTC calendar date (no zone involved).
  const monday = Date.UTC(p.year, p.month - 1, p.day - mondayIndex(p.weekday));
  const out: Date[] = [];
  for (let week = 0; out.length < limit; week += pattern.intervalWeeks) {
    for (const day of days) {
      const date = new Date(monday + (week * 7 + mondayIndex(day)) * 86_400_000);
      const start = zonedTimeToUtc(
        { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: p.hour, minute: p.minute },
        pattern.timeZone,
      );
      if (start.getTime() < pattern.first.getTime()) continue;
      out.push(start);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** How many candidates a plan of `sessions` may look at (the extra weeks for skipped dates). */
export function seriesCandidateLimit(sessions: number, weekdays: number): number {
  return sessions + Math.max(1, weekdays) * SERIES_EXTRA_WEEKS;
}

/** Why a date of the pattern was skipped. */
export type SeriesSkipReason = 'past' | 'outside_schedule' | 'employee_inactive' | 'time_off' | 'conflict';

export const SERIES_SKIP_LABELS_ES: Record<SeriesSkipReason, string> = {
  past: 'ya ha pasado',
  outside_schedule: 'fuera de su horario',
  employee_inactive: 'profesional desactivado',
  time_off: 'ausencia o clínica cerrada',
  conflict: 'ya tiene otra cita',
};

/** «L», «M», «X»… with the full name for screen readers, Monday first (value = weekday 0-6). */
export const SERIES_WEEKDAY_OPTIONS_ES = [
  { value: 1, short: 'L', label: 'Lunes' },
  { value: 2, short: 'M', label: 'Martes' },
  { value: 3, short: 'X', label: 'Miércoles' },
  { value: 4, short: 'J', label: 'Jueves' },
  { value: 5, short: 'V', label: 'Viernes' },
  { value: 6, short: 'S', label: 'Sábado' },
  { value: 0, short: 'D', label: 'Domingo' },
] as const;
