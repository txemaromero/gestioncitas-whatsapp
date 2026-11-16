/** Display helpers for time off (F14), in the tenant zone. */
import { addMinutes, formatHumanDate, formatTime, isWholeLocalDays, startOfZonedDay } from '@clinicai/shared';

/** «lunes, 8 de diciembre de 2026», «del … al …» or «lunes, 8 de diciembre de 2026, 10:00–12:00». */
export function formatTimeOffRange(start: Date, end: Date, timeZone: string): string {
  if (isWholeLocalDays(start, end, timeZone)) {
    // Last included day = the day containing end - 1 minute.
    const lastDay = startOfZonedDay(addMinutes(end, -1), timeZone);
    const first = formatHumanDate(start, timeZone);
    return lastDay.getTime() === start.getTime() ? first : `del ${first} al ${formatHumanDate(lastDay, timeZone)}`;
  }
  const sameDay = startOfZonedDay(start, timeZone).getTime() === startOfZonedDay(addMinutes(end, -1), timeZone).getTime();
  return sameDay
    ? `${formatHumanDate(start, timeZone)}, ${formatTime(start, timeZone)}–${formatTime(end, timeZone)}`
    : `del ${formatHumanDate(start, timeZone)}, ${formatTime(start, timeZone)} al ${formatHumanDate(end, timeZone)}, ${formatTime(end, timeZone)}`;
}
