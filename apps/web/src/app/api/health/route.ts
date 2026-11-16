export const dynamic = 'force-dynamic';

/** Liveness probe (no database access). */
export function GET() {
  return Response.json({ status: 'ok', service: 'clinicai-web' });
}
