import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** "Tiempo real": WhatsApp bookings appear without reloading (polling every 15 s + on window focus). */
export const REFRESH_MS = 15_000;

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Human message from a tRPC/zod error for toasts. */
export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const data = (error as { data?: { zodError?: { fieldErrors?: Record<string, string[]>; formErrors?: string[] } } }).data;
    const field = data?.zodError?.fieldErrors ? Object.values(data.zodError.fieldErrors).flat()[0] : undefined;
    const form = data?.zodError?.formErrors?.[0];
    if (field || form) return field ?? form ?? 'Datos no válidos';
    const message = (error as { message?: string }).message;
    if (message && !message.startsWith('[')) return message;
  }
  return 'Ha ocurrido un error. Inténtalo de nuevo.';
}
