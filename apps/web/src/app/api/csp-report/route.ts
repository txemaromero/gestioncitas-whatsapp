import { CSP_REPORT_MAX_BYTES, parseCspReport } from '@/server/csp-report';

export const dynamic = 'force-dynamic';

/** F25: browsers report here what the Content Security Policy blocked (or would block). */
export async function POST(request: Request): Promise<Response> {
  if (Number(request.headers.get('content-length') ?? 0) > CSP_REPORT_MAX_BYTES) {
    return new Response(null, { status: 413 });
  }
  const text = await request.text();
  if (text.length > CSP_REPORT_MAX_BYTES) return new Response(null, { status: 413 });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const violations = parseCspReport(json);
  if (!violations) return new Response(null, { status: 400 });
  for (const violation of violations) console.warn(`csp violation ${JSON.stringify(violation)}`);
  return new Response(null, { status: 204 });
}
