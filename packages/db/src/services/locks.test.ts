import { describe, expect, it } from 'vitest';
import { LOCK_NAMESPACES } from './locks';
import { REMINDER_LOCK_NAMESPACE, SECOND_REMINDER_LOCK_NAMESPACE } from './reminders';
import { WAITLIST_LOCK_NAMESPACE } from './waitlist';

describe('advisory lock namespaces (F32)', () => {
  it('are all different, so two kinds of work never block each other', () => {
    const values = Object.values(LOCK_NAMESPACES);
    expect(new Set(values).size).toBe(values.length);
    // The second reminders used to share the waiting list's namespace.
    expect(SECOND_REMINDER_LOCK_NAMESPACE).not.toBe(WAITLIST_LOCK_NAMESPACE);
    expect([REMINDER_LOCK_NAMESPACE, SECOND_REMINDER_LOCK_NAMESPACE, WAITLIST_LOCK_NAMESPACE]).toEqual([
      LOCK_NAMESPACES.reminders,
      LOCK_NAMESPACES.secondReminders,
      LOCK_NAMESPACES.waitlist,
    ]);
  });
});
