/**
 * F28: the agenda of a professional as an iCalendar subscription (`/api/calendar/<token>.ics`).
 * No session: the secret token finds the link with the system connection; the agenda is read
 * inside the clinic's tenant context. Unknown or revoked links get a plain 404.
 */
import { calendarFeedEvents, createRepos, findCalendarFeedByToken, getDatabase, runWithTenant, touchCalendarFeed, type Db } from '@clinicai/db';
import { buildIcal } from '@clinicai/shared';
import { publicBaseUrl } from './booking-page';

/** Subscription address of a token, and the webcal:// one that calendar apps open directly. */
export function calendarFeedUrls(token: string): { url: string; webcalUrl: string } {
  const url = `${publicBaseUrl()}/api/calendar/${token}.ics`;
  return { url, webcalUrl: url.replace(/^https?:/, 'webcal:') };
}

export async function calendarFeedResponse(token: string, options: { db?: { system: Db; app: Db }; now?: Date } = {}): Promise<Response> {
  const db = options.db ?? getDatabase();
  const now = options.now ?? new Date();
  const feed = await findCalendarFeedByToken(db.system, token.replace(/\.ics$/i, ''));
  const tenant = feed ? await createRepos(db.system).tenants.findById(feed.tenantId) : null;
  if (!feed || !tenant) return new Response('No encontrado', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const events = await runWithTenant(feed.tenantId, () =>
    calendarFeedEvents(db.app, feed.tenantId, {
      employeeId: feed.employeeId,
      fullNames: feed.fullNames,
      clinicName: tenant.clinicName,
      timeZone: tenant.timezone,
      now,
    }),
  );
  await touchCalendarFeed(db.system, feed.id, now);
  const body = buildIcal({ name: `${feed.employee.name} · ${tenant.clinicName}`, timeZone: tenant.timezone, events, now });
  return new Response(body, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="agenda.ics"',
      'cache-control': 'private, max-age=300',
      'x-robots-tag': 'noindex',
    },
  });
}
