/** Browser-side helpers to show tenant wall-clock times regardless of the browser zone. */
import { fromDateTimeLocalValue, pad2 } from '@clinicai/shared';

/** `YYYY-MM-DDTHH:mm` from the LOCAL components of a Date (what FullCalendar shows/clicks). */
export function localWall(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(
    date.getMinutes(),
  )}`;
}

/** Interprets a local wall-clock Date of the calendar as a wall time in the tenant zone. */
export function calendarDateToInstant(date: Date, timeZone: string): Date {
  return fromDateTimeLocalValue(localWall(date), timeZone) ?? date;
}
