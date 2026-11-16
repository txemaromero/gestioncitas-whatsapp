import { calendarFeedResponse } from '@/server/calendar-feed';

export const dynamic = 'force-dynamic';

/** F28: a professional's agenda for Google, Apple or Outlook (secret link, read-only). */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  return calendarFeedResponse(token);
}
