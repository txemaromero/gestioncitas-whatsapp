/**
 * Namespaces of the two-key PostgreSQL advisory locks (`pg_[try_]advisory_xact_lock(int, int)`,
 * second key `hashtext(<id>)`). Each kind of work needs its own: two jobs sharing one would block
 * (or silently skip) each other for the same clinic. F32: the second reminders shared the waiting
 * list's. `locks.test.ts` checks they are all different.
 * The single-key locks (`hashtext(employeeId)` for bookings, `hashtext('pack:' || clientId)` for
 * packs) live in another key space and do not collide with these.
 */
export const LOCK_NAMESPACES = {
  /** First reminders, one run per clinic at a time. */
  reminders: 802_401,
  /** Waiting list offers, one run per clinic at a time (F17). */
  waitlist: 802_402,
  /** Joining the waiting list, per client (F17). */
  waitlistClient: 802_403,
  /** Second reminders the same day, one run per clinic at a time (F30). */
  secondReminders: 802_404,
} as const;
