/**
 * F26: «¿cuántas sesiones me quedan?». Answers with the sessions left of each valid pack of the
 * client and until when; without any, says whether the last one was used up or expired. Only for
 * registered clients who accepted the privacy notice (routed from intentionFlow), no LLM.
 */
import { clientPackSummaries } from '@clinicai/db';
import { formatHumanDate, zonedTimeToUtc } from '@clinicai/shared';
import { IDLE, text, type FlowContext, type FlowResult } from '../engine/flow';
import { T } from '../engine/texts';

/** `YYYY-MM-DD` (a local date of the clinic) → «martes, 31 de marzo de 2027». */
function humanDay(key: string, timeZone: string): string {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  return formatHumanDate(zonedTimeToUtc({ year, month, day, hour: 12 }, timeZone), timeZone);
}

export async function packsReply(ctx: FlowContext): Promise<FlowResult> {
  const { tenant, client, deps, now } = ctx;
  if (!client) return { replies: [text(T.menuHelp(tenant.clinicName))], next: IDLE };
  const packs = await clientPackSummaries(deps.db, tenant.id, client.id, now);
  const active = packs.filter((p) => p.state === 'active');
  if (active.length > 0) {
    const lines = active.map((p) => T.packLine(p.name, p.remaining, p.totalSessions, p.expiresOn ? humanDay(p.expiresOn, tenant.timezone) : null));
    return { replies: [text(lines.length === 1 ? lines[0]! : T.packsMany(lines))], next: IDLE };
  }
  const last = packs.at(-1);
  if (!last) return { replies: [text(T.packsNone(tenant.clinicName))], next: IDLE };
  const reply = last.state === 'expired' && last.expiresOn ? T.packExpired(last.name, humanDay(last.expiresOn, tenant.timezone)) : T.packUsedUp(last.name);
  return { replies: [text(reply)], next: IDLE };
}
