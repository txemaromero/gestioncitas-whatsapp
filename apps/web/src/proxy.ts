/**
 * Next.js 16 proxy (formerly middleware), on every page request:
 *  - Kinde session for every page except the landing (`/`) and the public booking pages of the
 *    clinics (`/reservar/<slug>`, F27); without it, back to `/`. The layouts check it again on the
 *    server. Kinde also refreshes expired tokens here.
 *  - F25: Content Security Policy with a fresh nonce (`lib/secure-response.ts`).
 */
import { withAuth } from '@kinde-oss/kinde-auth-nextjs/middleware';
import type { NextRequest, NextResponse } from 'next/server';
import { authMockAllowed } from '@/lib/auth-mock';
import { secureResponse } from '@/lib/secure-response';
import { buildContentSecurityPolicy, createNonce, CSP_REPORT_PATH } from '@/lib/security-headers';

const PUBLIC_PAGES = new Set(['/']);
const isPublic = (pathname: string) => PUBLIC_PAGES.has(pathname) || pathname.startsWith('/reservar/');

export default async function proxy(request: NextRequest): Promise<Response> {
  const { pathname, protocol, origin } = request.nextUrl;
  const nonce = createNonce();
  const reportUrl = `${origin}${CSP_REPORT_PATH}`;
  const csp = buildContentSecurityPolicy({
    nonce,
    dev: process.env.NODE_ENV === 'development',
    https: protocol === 'https:',
    reportUrl,
  });
  // e2e tests only (see src/server/auth.ts): the session is mocked server-side.
  const auth =
    isPublic(pathname) || authMockAllowed()
      ? null
      : await (withAuth(request, { loginPage: '/', isReturnToCurrentPage: false }) as Promise<NextResponse>);
  return secureResponse(request, auth, { csp, nonce, reportUrl, reportOnly: process.env.CSP_REPORT_ONLY === 'true' });
}

export const config = {
  // Pages only: not the API (tRPC, Kinde, health, CSP reports) nor files with an extension.
  matcher: ['/((?!api/|_next/static/|_next/image|.*\\.[a-z0-9]+$).*)'],
};
