/** Stable, readable palette (white text on top) for per-employee calendar colors. */
export const EMPLOYEE_PALETTE = [
  '#2563eb', // blue-600
  '#059669', // emerald-600
  '#7c3aed', // violet-600
  '#db2777', // pink-600
  '#ea580c', // orange-600
  '#0891b2', // cyan-600
  '#4f46e5', // indigo-600
  '#65a30d', // lime-600
  '#dc2626', // red-600
  '#0f766e', // teal-700
] as const;

/** FNV-1a hash → palette index, so the same employee always gets the same color. */
export function employeeColor(employeeId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < employeeId.length; i++) {
    hash ^= employeeId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return EMPLOYEE_PALETTE[hash % EMPLOYEE_PALETTE.length] ?? EMPLOYEE_PALETTE[0];
}
