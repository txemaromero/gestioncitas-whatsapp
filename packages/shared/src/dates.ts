/**
 * Time-zone helpers built on Intl only (no runtime dependency).
 * Rule of the project: persist instants in UTC, interpret/display them in the tenant zone.
 */

export const DEFAULT_TIMEZONE = 'Europe/Madrid';

export const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Monday-first order, used by UIs and schedule formatting. */
export const WEEKDAYS_MONDAY_FIRST: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

export const WEEKDAY_LABELS_ES: Record<Weekday, string> = {
  monday: 'Lunes',
  tuesday: 'Martes',
  wednesday: 'Miércoles',
  thursday: 'Jueves',
  friday: 'Viernes',
  saturday: 'Sábado',
  sunday: 'Domingo',
};

export interface ZonedParts {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsFormatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    partsFormatterCache.set(timeZone, fmt);
  }
  return fmt;
}

const SHORT_WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Validates an IANA time zone name. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in the given zone. */
export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: SHORT_WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

/** Offset (ms) of the zone at the given instant: local wall time − UTC. */
export function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const p = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(date.getTime() / 1000) * 1000;
  return asUtc - truncated;
}

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
}

/**
 * Converts a wall-clock time in `timeZone` to the UTC instant.
 * Non-existent times (spring-forward gap) are shifted forward by the gap, like most libraries.
 */
export function zonedTimeToUtc(wall: WallTime, timeZone: string): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour ?? 0, wall.minute ?? 0);
  const offset1 = getTimeZoneOffsetMs(new Date(guess), timeZone);
  let result = guess - offset1;
  const offset2 = getTimeZoneOffsetMs(new Date(result), timeZone);
  if (offset2 !== offset1) {
    result = guess - offset2;
  }
  return new Date(result);
}

/** Weekday name of an instant in the zone. */
export function getZonedWeekday(date: Date, timeZone: string): Weekday {
  return WEEKDAYS[getZonedParts(date, timeZone).weekday] ?? 'monday';
}

/** Minutes since local midnight of an instant in the zone. */
export function getZonedMinutesOfDay(date: Date, timeZone: string): number {
  const p = getZonedParts(date, timeZone);
  return p.hour * 60 + p.minute;
}

/** `YYYY-MM-DD` of the instant in the zone. */
export function toZonedDateKey(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** UTC instant of local midnight for the day containing `date` in the zone. */
export function startOfZonedDay(date: Date, timeZone: string): Date {
  const p = getZonedParts(date, timeZone);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day }, timeZone);
}

/** Adds calendar days in the zone (DST safe), keeping the wall-clock time. */
export function addZonedDays(date: Date, days: number, timeZone: string): Date {
  const p = getZonedParts(date, timeZone);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return zonedTimeToUtc(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: p.hour,
      minute: p.minute,
    },
    timeZone,
  );
}

/** [start, end) UTC range of the local day `offsetDays` after the day of `now`. */
export function zonedDayRange(
  now: Date,
  offsetDays: number,
  timeZone: string,
): { start: Date; end: Date } {
  const start = startOfZonedDay(addZonedDays(startOfZonedDay(now, timeZone), offsetDays, timeZone), timeZone);
  const end = startOfZonedDay(addZonedDays(start, 1, timeZone), timeZone);
  return { start, end };
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * [start, end) of the whole local days `from`..`toInclusive` (`YYYY-MM-DD`) in the zone, e.g. a
 * holiday or a holiday period (F14). DST safe: days of 23 or 25 hours keep their real length.
 * Null when a date is malformed or the range is empty.
 */
export function localDaysRange(from: string, toInclusive: string, timeZone: string): { start: Date; end: Date } | null {
  const a = DATE_KEY.exec(from);
  const b = DATE_KEY.exec(toInclusive);
  if (!a || !b) return null;
  const start = zonedTimeToUtc({ year: Number(a[1]), month: Number(a[2]), day: Number(a[3]) }, timeZone);
  const last = zonedTimeToUtc({ year: Number(b[1]), month: Number(b[2]), day: Number(b[3]) }, timeZone);
  const end = startOfZonedDay(addZonedDays(last, 1, timeZone), timeZone);
  return end.getTime() > start.getTime() ? { start, end } : null;
}

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** `YYYY-MM` shifted by `delta` months (F15 metrics); null when malformed. */
export function shiftMonthKey(month: string, delta: number): string | null {
  const m = MONTH_KEY.exec(month);
  if (!m) return null;
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  return `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`;
}

/** [start, end) of the month `YYYY-MM` in the zone; null when malformed. */
export function localMonthRange(month: string, timeZone: string): { start: Date; end: Date } | null {
  const m = MONTH_KEY.exec(month);
  if (!m) return null;
  const lastDay = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return localDaysRange(`${m[1]}-${m[2]}-01`, `${m[1]}-${m[2]}-${pad2(lastDay)}`, timeZone);
}

/** True when [start, end) are whole local days (both bounds at local midnight). */
export function isWholeLocalDays(start: Date, end: Date, timeZone: string): boolean {
  return startOfZonedDay(start, timeZone).getTime() === start.getTime() && startOfZonedDay(end, timeZone).getTime() === end.getTime();
}

/** ISO 8601 with the zone offset, e.g. `2025-05-08T12:00:00+02:00`. */
export function toZonedIso(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  const offsetMin = Math.round(getTimeZoneOffsetMs(date, timeZone) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

/** `jueves, 8 de mayo de 2025, 12:00` */
export function formatHumanDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

/** `jueves, 8 de mayo de 2025` */
export function formatHumanDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

/** `jueves, 19 de noviembre` (F30: the date of the reminder template). */
export function formatWeekdayDayMonth(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('es-ES', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(date);
}

/** `12:00` */
export function formatTime(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Short label that fits a WhatsApp button (≤ 20 chars): `jue 8 may, 12:00`. */
export function formatShortSlot(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  const wd = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][p.weekday] ?? '';
  const mo =
    ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][
      p.month - 1
    ] ?? '';
  return `${wd} ${p.day} ${mo}, ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Spanish short format used by the web form help: `04/06/2025, 12:00`. */
export function formatEsShort(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  return `${pad2(p.day)}/${pad2(p.month)}/${p.year}, ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** `YYYY-MM-DDTHH:mm` (value for `<input type="datetime-local">`) in the zone. */
export function toDateTimeLocalValue(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Parses `YYYY-MM-DDTHH:mm` as wall time in the zone. Returns null when malformed. */
export function fromDateTimeLocalValue(value: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return zonedTimeToUtc(
    { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi) },
    timeZone,
  );
}

/** Parses `HH:mm` into minutes since midnight. */
export function parseHHmm(value: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`Invalid time: ${value}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function minutesToHHmm(minutes: number): string {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Rounds an instant to the nearest slot boundary of the local day grid
 * (grid step = min(slotMinutes, 60), anchored at local midnight).
 */
export function roundToSlot(date: Date, slotMinutes: number, timeZone: string): Date {
  const step = Math.max(5, Math.min(slotMinutes, 60));
  const p = getZonedParts(date, timeZone);
  const minutes = p.hour * 60 + p.minute;
  const rounded = Math.round(minutes / step) * step;
  if (rounded === minutes && p.second === 0) return date;
  return addMinutesWall(p, rounded, timeZone);
}

function addMinutesWall(p: ZonedParts, minutesOfDay: number, timeZone: string): Date {
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day, 0, minutesOfDay));
  return zonedTimeToUtc(
    {
      year: base.getUTCFullYear(),
      month: base.getUTCMonth() + 1,
      day: base.getUTCDate(),
      hour: base.getUTCHours(),
      minute: base.getUTCMinutes(),
    },
    timeZone,
  );
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}
