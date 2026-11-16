/**
 * Pure availability rules shared by the WhatsApp bot and the admin web.
 * An employee is available for [start, start + duration) when:
 *  - they are active,
 *  - one of their schedule ranges for that local weekday fully covers the interval,
 *  - they have no non-cancelled appointment overlapping it,
 *  - no time off (their own absence or a clinic closure) overlaps it (F14).
 */
import {
  addMinutes,
  addZonedDays,
  getZonedParts,
  parseHHmm,
  startOfZonedDay,
  zonedTimeToUtc,
  WEEKDAYS,
} from './dates';
import type { ScheduleSlot } from './schedule';

export interface AvailabilityEmployee {
  id: string;
  active: boolean;
  schedule: readonly ScheduleSlot[];
}

export interface BusyAppointment {
  id?: string;
  employeeId: string;
  date: Date;
  durationMinutes: number;
  status: string;
}

/** Time off (F14): an employee's absence, or a clinic closure when `employeeId` is null. */
export interface TimeBlock {
  employeeId: string | null;
  start: Date;
  end: Date;
}

/** Half-open interval overlap: [aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅ */
/**
 * F34: how far ahead a client can book by WhatsApp (the date comes from the AI, which could return
 * any date). The panel has no limit.
 */
export const BOOKING_HORIZON_DAYS = 183;

export function beyondBookingHorizon(date: Date, now: Date): boolean {
  return date.getTime() > now.getTime() + BOOKING_HORIZON_DAYS * 24 * 60 * 60 * 1000;
}

export function intervalsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/** True when a schedule range of the local weekday covers [start, start + duration]. */
export function isWithinSchedule(
  schedule: readonly ScheduleSlot[],
  start: Date,
  durationMinutes: number,
  timeZone: string,
): boolean {
  const end = addMinutes(start, durationMinutes);
  const p = getZonedParts(start, timeZone);
  const weekday = WEEKDAYS[p.weekday];
  // Compare instants (not wall-clock minutes) so DST transitions are handled correctly.
  const wallToInstant = (hhmm: string): Date => {
    const minutes = parseHHmm(hhmm);
    return zonedTimeToUtc(
      { year: p.year, month: p.month, day: p.day, hour: Math.floor(minutes / 60), minute: minutes % 60 },
      timeZone,
    );
  };
  return schedule.some((slot) => {
    if (slot.day !== weekday) return false;
    const slotStart = wallToInstant(slot.start);
    const slotEnd = wallToInstant(slot.end);
    return slotStart.getTime() <= start.getTime() && end.getTime() <= slotEnd.getTime();
  });
}

export function hasConflict(
  employeeId: string,
  start: Date,
  durationMinutes: number,
  busy: readonly BusyAppointment[],
  ignoreAppointmentId?: string,
): boolean {
  const end = addMinutes(start, durationMinutes);
  return busy.some(
    (a) =>
      a.employeeId === employeeId &&
      a.status !== 'cancelled' &&
      (ignoreAppointmentId === undefined || a.id !== ignoreAppointmentId) &&
      intervalsOverlap(start, end, a.date, addMinutes(a.date, a.durationMinutes)),
  );
}

/** The time off that blocks [start, start + duration) for the employee, if any. */
export function findBlock<B extends TimeBlock>(
  employeeId: string,
  start: Date,
  durationMinutes: number,
  blocks: readonly B[],
): B | null {
  const end = addMinutes(start, durationMinutes);
  return (
    blocks.find((b) => (b.employeeId === null || b.employeeId === employeeId) && intervalsOverlap(start, end, b.start, b.end)) ??
    null
  );
}

export function isBlocked(employeeId: string, start: Date, durationMinutes: number, blocks: readonly TimeBlock[]): boolean {
  return findBlock(employeeId, start, durationMinutes, blocks) !== null;
}

export function filterAvailableEmployees<E extends AvailabilityEmployee>(
  employees: readonly E[],
  busy: readonly BusyAppointment[],
  start: Date,
  durationMinutes: number,
  timeZone: string,
  blocks: readonly TimeBlock[] = [],
): E[] {
  return employees.filter(
    (e) =>
      e.active &&
      e.schedule.length > 0 &&
      isWithinSchedule(e.schedule, start, durationMinutes, timeZone) &&
      !hasConflict(e.id, start, durationMinutes, busy) &&
      !isBlocked(e.id, start, durationMinutes, blocks),
  );
}

/** Total minutes of [start, end) not covered by `cuts` (half-open intervals). */
function uncoveredMinutes(start: number, end: number, cuts: readonly { start: number; end: number }[]): number {
  const clipped = cuts
    .map((c) => ({ start: Math.max(start, c.start), end: Math.min(end, c.end) }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start);
  let covered = 0;
  let cursor = start;
  for (const c of clipped) {
    if (c.end <= cursor) continue;
    covered += c.end - Math.max(cursor, c.start);
    cursor = c.end;
  }
  return (end - start - covered) / 60_000;
}

/**
 * Minutes an employee is scheduled to work in [from, to) in the tenant zone, minus their
 * absences and the clinic closures (F15: denominator of the occupancy). DST safe: the schedule
 * ranges are converted to instants day by day.
 */
export function scheduledMinutes(
  employee: { id: string; schedule: readonly ScheduleSlot[] },
  from: Date,
  to: Date,
  timeZone: string,
  blocks: readonly TimeBlock[] = [],
): number {
  const cuts = blocks
    .filter((b) => b.employeeId === null || b.employeeId === employee.id)
    .map((b) => ({ start: b.start.getTime(), end: b.end.getTime() }));
  let total = 0;
  for (let day = startOfZonedDay(from, timeZone); day.getTime() < to.getTime(); day = startOfZonedDay(addZonedDays(day, 1, timeZone), timeZone)) {
    const p = getZonedParts(day, timeZone);
    const weekday = WEEKDAYS[p.weekday];
    for (const slot of employee.schedule) {
      if (slot.day !== weekday) continue;
      const at = (hhmm: string) => {
        const minutes = parseHHmm(hhmm);
        return zonedTimeToUtc(
          { year: p.year, month: p.month, day: p.day, hour: Math.floor(minutes / 60), minute: minutes % 60 },
          timeZone,
        ).getTime();
      };
      const start = Math.max(at(slot.start), from.getTime());
      const end = Math.min(at(slot.end), to.getTime());
      if (end > start) total += uncoveredMinutes(start, end, cuts);
    }
  }
  return Math.round(total);
}

export interface FreeSlotQuery {
  employees: readonly AvailabilityEmployee[];
  busy: readonly BusyAppointment[];
  /** Absences and clinic closures (F14). */
  blocks?: readonly TimeBlock[];
  /** Earliest candidate instant (inclusive). */
  from: Date;
  durationMinutes: number;
  slotMinutes: number;
  timeZone: string;
  limit?: number;
  maxDays?: number;
}

/**
 * Nearest free start instants (any employee), searching forward from `from`
 * on the local slot grid: the same local day plus the `maxDays` following days.
 */
export function findFreeSlots(query: FreeSlotQuery): Date[] {
  const { employees, busy, from, durationMinutes, slotMinutes, timeZone } = query;
  const blocks = query.blocks ?? [];
  const limit = query.limit ?? 3;
  const maxDays = query.maxDays ?? 7;
  const step = Math.max(5, Math.min(slotMinutes, 60));
  const results: Date[] = [];
  const firstDay = startOfZonedDay(from, timeZone);

  for (let d = 0; d <= maxDays && results.length < limit; d++) {
    const day = startOfZonedDay(addZonedDays(firstDay, d, timeZone), timeZone);
    const p = getZonedParts(day, timeZone);
    const weekday = WEEKDAYS[p.weekday];
    const ranges = employees
      .filter((e) => e.active)
      .flatMap((e) => e.schedule.filter((s) => s.day === weekday));
    if (ranges.length === 0) continue;
    const dayStart = Math.min(...ranges.map((r) => parseHHmm(r.start)));
    const dayEnd = Math.max(...ranges.map((r) => parseHHmm(r.end)));
    const firstCandidate = Math.ceil(dayStart / step) * step;
    for (let m = firstCandidate; m + durationMinutes <= dayEnd && results.length < limit; m += step) {
      const candidate = zonedTimeToUtc(
        { year: p.year, month: p.month, day: p.day, hour: Math.floor(m / 60), minute: m % 60 },
        timeZone,
      );
      if (candidate.getTime() < from.getTime()) continue;
      if (filterAvailableEmployees(employees, busy, candidate, durationMinutes, timeZone, blocks).length > 0) {
        results.push(candidate);
      }
    }
  }
  return results;
}
