/**
 * F28: iCalendar (RFC 5545) of a professional's agenda, the format Google Calendar, Apple Calendar
 * and Outlook read from a subscription link. Lines end in CRLF and are folded at 75 octets, texts
 * are escaped, timed events are in UTC and whole days use local dates.
 */

export interface IcalEvent {
  uid: string;
  summary: string;
  description?: string;
  /** Timed event: UTC instants. */
  start: Date;
  end: Date;
  /** Whole days instead: local dates `YYYY-MM-DD` of the clinic, end exclusive. */
  allDay?: { startKey: string; endKey: string };
  status?: 'CONFIRMED' | 'TENTATIVE';
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `20261118T090000Z` */
export function icalUtc(date: Date): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(
    date.getUTCMinutes(),
  )}${pad(date.getUTCSeconds())}Z`;
}

/**
 * Escapes a TEXT value: backslash, semicolon, comma and line breaks (also a lone CR). F34: other
 * control characters and Unicode line separators are dropped, so no text can start a new property.
 */
export function icalText(value: string): string {
  return (
    value
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n|\r|\n/g, '\\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g, '')
  );
}

const encoder = new TextEncoder();

/** Folds a content line at 75 octets (continuations start with a space), never inside a character. */
export function foldIcalLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    // The first line holds 75 octets; the following ones 74 plus the leading space.
    if (size + bytes > (parts.length === 0 ? 75 : 74)) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export function buildIcal(calendar: { name: string; timeZone: string; events: IcalEvent[]; now: Date }): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ClinicAI//Agenda//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icalText(calendar.name)}`,
    `X-WR-TIMEZONE:${calendar.timeZone}`,
    // Hints for the apps that honour them (Google refreshes at its own pace).
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  const stamp = icalUtc(calendar.now);
  for (const event of calendar.events) {
    lines.push('BEGIN:VEVENT', `UID:${event.uid}`, `DTSTAMP:${stamp}`);
    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${event.allDay.startKey.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${event.allDay.endKey.replace(/-/g, '')}`);
    } else {
      lines.push(`DTSTART:${icalUtc(event.start)}`, `DTEND:${icalUtc(event.end)}`);
    }
    lines.push(`SUMMARY:${icalText(event.summary)}`);
    if (event.description) lines.push(`DESCRIPTION:${icalText(event.description)}`);
    if (event.status) lines.push(`STATUS:${event.status}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldIcalLine).join('\r\n')}\r\n`;
}

/** «Laura Martínez Pérez» → «L. M.»: what the agenda shows of a client by default. */
export function clientInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (words.length === 0) return 'Cliente';
  return words.map((w) => `${[...w][0]!.toLocaleUpperCase('es')}.`).join(' ');
}
