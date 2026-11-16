/**
 * F27: free slots of the public booking page, with the same rules as the bot (`findNearbySlots`):
 * any active professional free for the whole duration, no absences nor closures, on the slot grid.
 */
import { addZonedDays, BOOKING_PAGE_DAYS, BOOKING_PAGE_LEAD_MINUTES, toZonedDateKey } from '@clinicai/shared';
import type { Db } from '../client';
import { findNearbySlots } from './availability';

export interface BookingPageDay {
  /** Local date `YYYY-MM-DD` in the clinic zone. */
  dayKey: string;
  slots: Date[];
}

/** Free slots from an hour from now until the end of the 14th day (today included), by day. */
export async function bookingPageDays(
  db: Db,
  tenantId: string,
  input: { durationMinutes: number; slotMinutes: number; timeZone: string; now?: Date },
): Promise<BookingPageDay[]> {
  const now = input.now ?? new Date();
  const from = new Date(now.getTime() + BOOKING_PAGE_LEAD_MINUTES * 60_000);
  const slots = await findNearbySlots(db, tenantId, {
    from,
    durationMinutes: input.durationMinutes,
    slotMinutes: input.slotMinutes,
    timeZone: input.timeZone,
    limit: 5000,
    maxDays: BOOKING_PAGE_DAYS,
  });
  const lastDay = toZonedDateKey(addZonedDays(now, BOOKING_PAGE_DAYS - 1, input.timeZone), input.timeZone);
  const days: BookingPageDay[] = [];
  for (const slot of slots) {
    const dayKey = toZonedDateKey(slot, input.timeZone);
    if (dayKey > lastDay) break;
    const last = days.at(-1);
    if (last?.dayKey === dayKey) last.slots.push(slot);
    else days.push({ dayKey, slots: [slot] });
  }
  return days;
}
