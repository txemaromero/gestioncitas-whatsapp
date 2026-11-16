import { z } from 'zod';

/**
 * F34: the date range of the calendar lists (appointments, absences). The month view asks for six
 * weeks at most; a larger range would only load the database.
 */
export const LIST_RANGE_MAX_DAYS = 100;

export const listRangeInput = z
  .object({ from: z.date(), to: z.date() })
  .refine((v) => v.to > v.from, 'Rango inválido')
  .refine((v) => v.to.getTime() - v.from.getTime() <= LIST_RANGE_MAX_DAYS * 24 * 60 * 60 * 1000, `Como máximo ${LIST_RANGE_MAX_DAYS} días`);
