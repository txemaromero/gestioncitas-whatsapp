/**
 * Waiting list (F17): pure rules shared by the database layer, the bot and the panel.
 * A client who cannot get the time they asked for can wait for it. If that whole day is full,
 * they wait for any slot that day; if other times were free, only for the time they asked for.
 */
import {
  filterAvailableEmployees,
  findFreeSlots,
  type AvailabilityEmployee,
  type BusyAppointment,
  type TimeBlock,
} from './availability';
import { addZonedDays, startOfZonedDay } from './dates';

/** Waiting entries a client can have at the same time. */
export const WAITLIST_MAX_ACTIVE_PER_CLIENT = 3;

export const WAITLIST_STATUS_LABELS_ES = {
  waiting: 'En espera',
  booked: 'Reservado',
  left: 'Se dio de baja',
  expired: 'Caducado',
} as const;
export type WaitlistStatusValue = keyof typeof WAITLIST_STATUS_LABELS_ES;

/** Acceptable start instants of a waiting entry: [start, end], both inclusive. */
export interface WaitlistWindow {
  start: Date;
  end: Date;
  wholeDay: boolean;
  /** The time the client asked for: whole-day entries get the free slot closest to it. */
  preferred: Date;
}

/** Whole local day of `requested` (DST safe): from 00:00 to the last minute of the day. */
export function wholeDayWindow(requested: Date, timeZone: string): WaitlistWindow {
  const start = startOfZonedDay(requested, timeZone);
  const end = new Date(addZonedDays(start, 1, timeZone).getTime() - 60_000);
  return { start, end, wholeDay: true, preferred: requested };
}

export function exactTimeWindow(start: Date): WaitlistWindow {
  return { start, end: start, wholeDay: false, preferred: start };
}

export interface WaitlistSlotQuery {
  employees: readonly AvailabilityEmployee[];
  /** Appointments, plus the slots currently offered to other waiting clients. */
  busy: readonly BusyAppointment[];
  blocks?: readonly TimeBlock[];
  window: WaitlistWindow;
  /** Nothing is offered before this instant (now + the minimum notice to answer and come). */
  earliest: Date;
  durationMinutes: number;
  slotMinutes: number;
  timeZone: string;
  /** Starts already offered to this entry (never offered twice). */
  exclude?: readonly Date[];
}

/**
 * Free start (and a professional free then) for a waiting entry, or null: the one closest to the
 * requested time (the earlier one on a tie).
 */
export function findWaitlistSlot(query: WaitlistSlotQuery): { start: Date; employeeId: string } | null {
  const { window, earliest, durationMinutes, timeZone } = query;
  const blocks = query.blocks ?? [];
  const excluded = new Set((query.exclude ?? []).map((d) => d.getTime()));
  const from = window.start.getTime() >= earliest.getTime() ? window.start : earliest;
  if (from.getTime() > window.end.getTime()) return null;

  const candidates = window.wholeDay
    ? findFreeSlots({
        employees: query.employees,
        busy: query.busy,
        blocks,
        from,
        durationMinutes,
        slotMinutes: query.slotMinutes,
        timeZone,
        limit: 300,
        maxDays: 0,
      })
    : [window.start];
  const distance = (d: Date) => Math.abs(d.getTime() - window.preferred.getTime());
  const ordered = candidates
    .filter((d) => d.getTime() >= from.getTime() && d.getTime() <= window.end.getTime() && !excluded.has(d.getTime()))
    .sort((a, b) => distance(a) - distance(b) || a.getTime() - b.getTime());
  for (const start of ordered) {
    const [employee] = filterAvailableEmployees(query.employees, query.busy, start, durationMinutes, timeZone, blocks);
    if (employee) return { start, employeeId: employee.id };
  }
  return null;
}
