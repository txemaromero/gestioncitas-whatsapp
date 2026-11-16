/**
 * F25: Content Security Policy violation reports sent by browsers, in both formats: `report-uri`
 * (`{"csp-report": {...}}`) and the Reporting API (`[{"type": "csp-violation", "body": {...}}]`).
 * Only what helps to fix the policy is kept: the directive, where the blocked resource came from
 * (origin, or `inline` / `eval`) and the page path. Never query strings nor code samples.
 */
import { z } from 'zod';

export const CSP_REPORT_MAX_BYTES = 16 * 1024;
const MAX_VIOLATIONS = 10;

const legacyReport = z.object({
  'csp-report': z.object({
    'document-uri': z.string().optional(),
    'blocked-uri': z.string().optional(),
    'effective-directive': z.string().optional(),
    'violated-directive': z.string().optional(),
    disposition: z.string().optional(),
  }),
});

const reportingApiReports = z
  .array(
    z.object({
      type: z.string(),
      body: z
        .object({
          documentURL: z.string().optional(),
          blockedURL: z.string().optional(),
          effectiveDirective: z.string().optional(),
          disposition: z.string().optional(),
        })
        .optional(),
    }),
  )
  .max(100);

export interface CspViolation {
  directive: string;
  blocked: string;
  page: string;
  disposition: string;
}

/** `https://cdn.example.com/x.js?a=1` → `https://cdn.example.com`; `inline`, `eval`, `data:`… as is. */
function blockedSource(value: string | undefined): string {
  if (!value) return 'unknown';
  try {
    const url = new URL(value);
    return url.origin === 'null' ? url.protocol : url.origin;
  } catch {
    return value.slice(0, 20);
  }
}

function pagePath(value: string | undefined): string {
  if (!value) return 'unknown';
  try {
    return new URL(value).pathname;
  } catch {
    return 'unknown';
  }
}

/** Null when the body is not a CSP report. */
export function parseCspReport(json: unknown): CspViolation[] | null {
  const legacy = legacyReport.safeParse(json);
  if (legacy.success) {
    const r = legacy.data['csp-report'];
    return [
      {
        directive: (r['effective-directive'] ?? r['violated-directive'] ?? 'unknown').slice(0, 40),
        blocked: blockedSource(r['blocked-uri']),
        page: pagePath(r['document-uri']),
        disposition: r.disposition === 'report' ? 'report' : 'enforce',
      },
    ];
  }
  const reports = reportingApiReports.safeParse(json);
  if (!reports.success) return null;
  return reports.data
    .filter((r) => r.type === 'csp-violation' && r.body)
    .slice(0, MAX_VIOLATIONS)
    .map(({ body }) => ({
      directive: (body?.effectiveDirective ?? 'unknown').slice(0, 40),
      blocked: blockedSource(body?.blockedURL),
      page: pagePath(body?.documentURL),
      disposition: body?.disposition === 'report' ? 'report' : 'enforce',
    }));
}
