/**
 * F25 — security headers of the panel: the Content Security Policy, the proxy (with Kinde mocked,
 * including a token refresh) and the violation reports endpoint.
 */
import { NextRequest, NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const withAuth = vi.fn<(request: NextRequest, options: unknown) => Promise<NextResponse>>();
vi.mock('@kinde-oss/kinde-auth-nextjs/middleware', () => ({ withAuth: (...args: [NextRequest, unknown]) => withAuth(...args) }));

const { buildContentSecurityPolicy, createNonce, STATIC_SECURITY_HEADERS } = await import('../src/lib/security-headers');
const { secureResponse } = await import('../src/lib/secure-response');
const { parseCspReport } = await import('../src/server/csp-report');
const { POST: cspReport } = await import('../src/app/api/csp-report/route');
const { default: proxy, config } = await import('../src/proxy');

const directive = (csp: string, name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `));
/** What Next.js will pass to the page as request header `name` (empty when not overridden). */
function forwarded(response: Response, name: string): string | null {
  const overridden = (response.headers.get('x-middleware-override-headers') ?? '').split(',');
  return overridden.includes(name) ? response.headers.get(`x-middleware-request-${name}`) : null;
}
const policy = (extra: { reportOnly?: boolean } = {}) => ({
  csp: buildContentSecurityPolicy({ nonce: 'abc123', dev: false, https: true, reportUrl: 'https://panel.test/api/csp-report' }),
  nonce: 'abc123',
  reportUrl: 'https://panel.test/api/csp-report',
  reportOnly: extra.reportOnly ?? false,
});

describe('Content Security Policy (F25)', () => {
  it('only lets scripts with the nonce run, and never in frames', () => {
    const csp = buildContentSecurityPolicy({ nonce: 'abc123', dev: false, https: true, reportUrl: 'https://panel.test/api/csp-report' });
    expect(directive(csp, 'script-src')).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain('unsafe-eval');
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(directive(csp, 'report-uri')).toBe('report-uri https://panel.test/api/csp-report');
    expect(directive(csp, 'report-to')).toBe('report-to csp');
  });

  it('allows eval only in development and does not upgrade plain http', () => {
    const csp = buildContentSecurityPolicy({ nonce: 'n', dev: true, https: false, reportUrl: 'http://localhost:3000/api/csp-report' });
    expect(directive(csp, 'script-src')).toContain("'unsafe-eval'");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('creates a different 128-bit nonce each time', () => {
    const nonces = new Set(Array.from({ length: 50 }, createNonce));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(Buffer.from(nonce, 'base64')).toHaveLength(16);
  });

  it('sends the fixed headers on every response', () => {
    const keys = STATIC_SECURITY_HEADERS.map((h) => h.key);
    expect(keys).toEqual(
      expect.arrayContaining(['Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy']),
    );
  });
});

describe('proxy response (F25)', () => {
  it('passes the nonce to the page and the policy to the browser', () => {
    const request = new NextRequest('https://panel.test/');
    const response = secureResponse(request, null, policy());
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('content-security-policy')).toContain("'nonce-abc123'");
    expect(response.headers.get('reporting-endpoints')).toBe('csp="https://panel.test/api/csp-report"');
    expect(forwarded(response, 'x-nonce')).toBe('abc123');
    expect(forwarded(response, 'content-security-policy')).toContain("'nonce-abc123'");
  });

  it('can only report (escape hatch) without blocking', () => {
    const response = secureResponse(new NextRequest('https://panel.test/'), null, policy({ reportOnly: true }));
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(response.headers.get('content-security-policy-report-only')).toContain("'nonce-abc123'");
    // Next.js still gets the nonce.
    expect(forwarded(response, 'content-security-policy')).toContain("'nonce-abc123'");
  });

  it('keeps the redirect of Kinde when there is no session', () => {
    const redirect = NextResponse.redirect('https://panel.test/');
    const response = secureResponse(new NextRequest('https://panel.test/dashboard'), redirect, policy());
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://panel.test/');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('keeps the nonce and the refreshed tokens when Kinde refreshes the session', () => {
    const request = new NextRequest('https://panel.test/dashboard', {
      headers: { cookie: 'access_token=old; id_token=old-id; split_token1=stale; theme=light' },
    });
    // What Kinde returns after refreshing: new cookies, and the request headers rebuilt from the
    // original request (which is why its response cannot be reused).
    const kinde = NextResponse.next({ request: { headers: new Headers(request.headers) } });
    kinde.cookies.set('access_token', 'new', { httpOnly: true, path: '/', maxAge: 3600 });
    kinde.cookies.set('id_token', 'new-id', { httpOnly: true, path: '/', maxAge: 3600 });
    kinde.cookies.set('split_token1', '', { path: '/', maxAge: 0 });

    const response = secureResponse(request, kinde, policy());
    expect(forwarded(response, 'x-nonce')).toBe('abc123');
    const cookie = forwarded(response, 'cookie')!;
    expect(cookie.split('; ').sort()).toEqual(['access_token=new', 'id_token=new-id', 'theme=light']);
    expect(response.headers.getSetCookie().join('\n')).toMatch(/access_token=new;.*HttpOnly/);
    expect((response as NextResponse).cookies.get('id_token')?.value).toBe('new-id');
  });
});

describe('proxy (F25)', () => {
  beforeEach(() => {
    withAuth.mockReset();
    vi.stubEnv('AUTH_MOCK_USER', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('asks Kinde for every page except the landing, always with a fresh policy', async () => {
    withAuth.mockResolvedValue(NextResponse.redirect('https://panel.test/'));
    const landing = await proxy(new NextRequest('https://panel.test/'));
    expect(withAuth).not.toHaveBeenCalled();
    expect(landing.headers.get('content-security-policy')).toContain('upgrade-insecure-requests');

    const panel = await proxy(new NextRequest('https://panel.test/activity'));
    expect(withAuth).toHaveBeenCalledTimes(1);
    expect(panel.status).toBe(307);
    const nonceOf = (r: Response) => /'nonce-([^']+)'/.exec(r.headers.get('content-security-policy') ?? '')?.[1];
    expect(nonceOf(panel)).toBeTruthy();
    expect(nonceOf(panel)).not.toBe(nonceOf(landing));
  });

  it('runs on pages only (not the API nor files)', () => {
    const matcher = new RegExp(`^${config.matcher[0]!.replace('/(', '/(?:')}$`);
    for (const path of ['/', '/dashboard', '/activity', '/clients', '/onboarding', '/metrics']) expect(path).toMatch(matcher);
    for (const path of ['/api/trpc/clients.list', '/api/auth/login', '/api/csp-report', '/_next/static/chunks/a.js', '/favicon.ico']) {
      expect(path).not.toMatch(matcher);
    }
  });
});

describe('CSP violation reports (F25)', () => {
  it('reads both report formats and keeps no query strings', () => {
    expect(
      parseCspReport({
        'csp-report': {
          'document-uri': 'https://panel.test/clients?id=123',
          'blocked-uri': 'https://evil.example/x.js?token=secret',
          'effective-directive': 'script-src-elem',
        },
      }),
    ).toEqual([{ directive: 'script-src-elem', blocked: 'https://evil.example', page: '/clients', disposition: 'enforce' }]);
    expect(
      parseCspReport([
        { type: 'csp-violation', body: { documentURL: 'https://panel.test/dashboard?x=1', blockedURL: 'inline', effectiveDirective: 'script-src-elem', disposition: 'report' } },
        { type: 'deprecation', body: {} },
      ]),
    ).toEqual([{ directive: 'script-src-elem', blocked: 'inline', page: '/dashboard', disposition: 'report' }]);
    expect(parseCspReport({ hello: 'world' })).toBeNull();
  });

  it('logs valid reports and rejects the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const post = (body: string) => cspReport(new Request('https://panel.test/api/csp-report', { method: 'POST', body }));
      const ok = await post(JSON.stringify({ 'csp-report': { 'document-uri': 'https://panel.test/a?b=c', 'blocked-uri': 'eval', 'violated-directive': 'script-src' } }));
      expect(ok.status).toBe(204);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).not.toContain('b=c');
      expect((await post('not json')).status).toBe(400);
      expect((await post('{"other":1}')).status).toBe(400);
      expect((await post(JSON.stringify({ 'csp-report': { 'blocked-uri': 'x'.repeat(20_000) } }))).status).toBe(413);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('mocked sign-in of the e2e tests (F34)', async () => {
  const { authMockAllowed } = await import('../src/lib/auth-mock');
  const base = { AUTH_MOCK_USER: 'kp_e2e:admin@e2e.test', KINDE_SITE_URL: 'http://localhost:3100' };

  it('only works on this machine, also when both variables reach a deployment', () => {
    expect(authMockAllowed({ ...base, NODE_ENV: 'development' })).toBe(true);
    expect(authMockAllowed({ ...base, NODE_ENV: 'production', ALLOW_AUTH_MOCK: 'true' })).toBe(true);
    expect(authMockAllowed({ ...base, KINDE_SITE_URL: 'http://127.0.0.1:3000', NODE_ENV: 'development' })).toBe(true);
    // A production build needs ALLOW_AUTH_MOCK too.
    expect(authMockAllowed({ ...base, NODE_ENV: 'production' })).toBe(false);
    // A deployed panel never skips the sign-in, whatever the variables say.
    expect(authMockAllowed({ ...base, KINDE_SITE_URL: 'https://panel.clinica.es', NODE_ENV: 'production', ALLOW_AUTH_MOCK: 'true' })).toBe(false);
    expect(authMockAllowed({ ...base, KINDE_SITE_URL: 'https://localhost.attacker.example', NODE_ENV: 'development' })).toBe(false);
    expect(authMockAllowed({ AUTH_MOCK_USER: base.AUTH_MOCK_USER, NODE_ENV: 'development' })).toBe(false);
    expect(authMockAllowed({ KINDE_SITE_URL: base.KINDE_SITE_URL, NODE_ENV: 'development' })).toBe(false);
  });
});
