/**
 * F25: response of the proxy with the Content Security Policy, on top of what Kinde decided.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { CSP_REPORT_GROUP } from './security-headers';

export interface PolicyHeaders {
  csp: string;
  nonce: string;
  reportUrl: string;
  /** `CSP_REPORT_ONLY=true`: browsers only report violations (escape hatch, see docs/deploy.md). */
  reportOnly: boolean;
}

function setPolicy(response: Response, { csp, reportUrl, reportOnly }: PolicyHeaders): void {
  response.headers.set(reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', csp);
  response.headers.set('Reporting-Endpoints', `${CSP_REPORT_GROUP}="${reportUrl}"`);
}

/**
 * Lets the request through with the policy, keeping what Kinde did (`auth` is null when Kinde was
 * not consulted). Kinde's own pass-through response cannot be reused: when it refreshes the tokens
 * it rebuilds the request headers that reach the page from the original request, and the nonce
 * would be lost.
 */
export function secureResponse(request: NextRequest, auth: NextResponse | null, policy: PolicyHeaders): Response {
  // A redirect to the landing page (or a 401): nothing is rendered.
  if (auth && auth.headers.get('x-middleware-next') !== '1') {
    setPolicy(auth, policy);
    return auth;
  }
  const headers = new Headers(request.headers);
  // Next.js takes the nonce from this request header and adds it to its scripts.
  headers.set('content-security-policy', policy.csp);
  headers.set('x-nonce', policy.nonce);
  // Tokens refreshed by Kinde: the page must already see them, and the browser must store them.
  const refreshed = auth?.cookies.getAll() ?? [];
  if (refreshed.length > 0) {
    const jar = new Map(request.cookies.getAll().map((cookie) => [cookie.name, cookie.value]));
    for (const cookie of refreshed) {
      if (cookie.maxAge === 0) jar.delete(cookie.name);
      else jar.set(cookie.name, cookie.value);
    }
    headers.set('cookie', [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; '));
  }
  const response = NextResponse.next({ request: { headers } });
  for (const cookie of refreshed) response.cookies.set(cookie);
  setPolicy(response, policy);
  return response;
}
