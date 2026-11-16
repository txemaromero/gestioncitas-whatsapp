import { z } from 'zod';
import { WEEKDAYS, WEEKDAYS_MONDAY_FIRST, WEEKDAY_LABELS_ES, parseHHmm, type Weekday } from './dates';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const weekdaySchema = z.enum(WEEKDAYS);

export const scheduleSlotSchema = z.object({
  day: weekdaySchema,
  start: z.string().regex(HHMM, 'Formato HH:mm'),
  end: z.string().regex(HHMM, 'Formato HH:mm'),
});
export type ScheduleSlot = z.infer<typeof scheduleSlotSchema>;

export interface ScheduleIssue {
  index: number;
  message: string;
}

/** Business validation: start < end and no overlapping ranges on the same day. */
export function validateSchedule(slots: readonly ScheduleSlot[]): ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];
  slots.forEach((slot, index) => {
    if (parseHHmm(slot.start) >= parseHHmm(slot.end)) {
      issues.push({ index, message: 'La hora de inicio debe ser anterior a la de fin' });
    }
  });
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i];
      const b = slots[j];
      if (!a || !b || a.day !== b.day) continue;
      if (parseHHmm(a.start) < parseHHmm(b.end) && parseHHmm(b.start) < parseHHmm(a.end)) {
        issues.push({
          index: j,
          message: `La franja se solapa con otra del ${WEEKDAY_LABELS_ES[a.day].toLowerCase()}`,
        });
      }
    }
  }
  return issues;
}

/** Zod schema for a full schedule with business validation. */
export const scheduleSchema = z.array(scheduleSlotSchema).superRefine((slots, ctx) => {
  for (const issue of validateSchedule(slots)) {
    ctx.addIssue({ code: 'custom', message: issue.message, path: [issue.index] });
  }
});

/** Parses a JSON value coming from the DB into a schedule (invalid → empty). */
export function parseSchedule(value: unknown): ScheduleSlot[] {
  const parsed = z.array(scheduleSlotSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function sortSchedule(slots: readonly ScheduleSlot[]): ScheduleSlot[] {
  return [...slots].sort((a, b) => {
    const d = WEEKDAYS_MONDAY_FIRST.indexOf(a.day) - WEEKDAYS_MONDAY_FIRST.indexOf(b.day);
    return d !== 0 ? d : parseHHmm(a.start) - parseHHmm(b.start);
  });
}

/** `Lunes: 07:00 - 13:55, Miércoles: 07:00 - 19:55` or `-` when empty. */
export function formatScheduleEs(slots: readonly ScheduleSlot[]): string {
  if (slots.length === 0) return '-';
  return sortSchedule(slots)
    .map((s) => `${WEEKDAY_LABELS_ES[s.day]}: ${s.start} - ${s.end}`)
    .join(', ');
}

/** Union of opening ranges per day across employees, e.g. for the default FAQ prompt. */
export function openingHoursByDay(
  schedules: readonly (readonly ScheduleSlot[])[],
): Partial<Record<Weekday, { start: string; end: string }>> {
  const result: Partial<Record<Weekday, { start: string; end: string }>> = {};
  for (const slots of schedules) {
    for (const s of slots) {
      const current = result[s.day];
      if (!current) {
        result[s.day] = { start: s.start, end: s.end };
      } else {
        if (parseHHmm(s.start) < parseHHmm(current.start)) current.start = s.start;
        if (parseHHmm(s.end) > parseHHmm(current.end)) current.end = s.end;
      }
    }
  }
  return result;
}
