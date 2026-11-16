/**
 * Services offered by a clinic (F14): each one has its own duration. All professionals can do
 * every service (restricting services per professional is left for later).
 */
export const SERVICE_DURATION_MIN = 10;
export const SERVICE_DURATION_MAX = 480;
/** Durations offered in the panel (minutes). */
export const SERVICE_DURATION_OPTIONS = [15, 20, 30, 45, 60, 75, 90, 120] as const;

/** `45 min`, `1 h`, `1 h 30 min`. */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
