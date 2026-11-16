/**
 * F25: security headers of the panel. The Content Security Policy carries a fresh nonce on every
 * request, so `proxy.ts` builds it; the other headers never change (`next.config.ts`).
 * No imports: `next.config.ts` loads this file too.
 */

export const CSP_REPORT_PATH = '/api/csp-report';
/** Name of the Reporting API endpoint (`Reporting-Endpoints` header + `report-to` directive). */
export const CSP_REPORT_GROUP = 'csp';

export interface CspOptions {
  nonce: string;
  /** `next dev`: React uses eval for its error overlay (never in production). */
  dev: boolean;
  /** Only over HTTPS: on http://localhost the upgrade would break every request. */
  https: boolean;
  /** Absolute URL of the violation reports endpoint. */
  reportUrl: string;
}

export function buildContentSecurityPolicy({ nonce, dev, https, reportUrl }: CspOptions): string {
  return [
    "default-src 'self'",
    // Only scripts carrying this request's nonce (Next.js adds it to its own) and what they load.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // Server-rendered style attributes and the <style> tags of sonner and the calendar need it.
    // Styles cannot run code; scripts stay strict.
    "style-src 'self' 'unsafe-inline'",
    // The avatar of the account menu comes from the identity provider (Kinde, Google…).
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ['upgrade-insecure-requests'] : []),
    `report-uri ${reportUrl}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ].join('; ');
}

/** 128 random bits, base64 (a new one per request). */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/** Sent with every response of the panel, pages and API alike. */
export const STATIC_SECURITY_HEADERS: { key: string; value: string }[] = [
  // Browsers ignore it over plain HTTP (local development).
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Older browsers; `frame-ancestors 'none'` does the same in the CSP.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];
