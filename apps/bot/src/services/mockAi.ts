/**
 * LLM_MODE=mock: deterministic, rule-based answers so the bot, the tests and the simulator
 * work without any API key. Same interface as the live service.
 */
import {
  getZonedParts,
  normalizeText,
  toZonedIso,
  zonedTimeToUtc,
} from '@clinicai/shared';
import type { AIService, Intent, ParsedDate } from './aiServices';

// ---------------------------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------------------------

const PROCEDURE_QUESTION = /\bcomo (?:puedo |se |hago para |podria )?(?:cancel|anul|cambi|modific|reserv|pedir)/;
const CONFIRM_EXISTING = /\bconfirm(?:ar|o|a)? (?:mi |la )?cita\b/;
const INFO_REQUEST = /\b(?:quiero|quisiera|me gustaria) (?:saber|informacion|preguntar)\b/;
const BOOKING_SIGNALS = [
  /\bcita\b/,
  /\breserv/,
  /\bagend/,
  /\bhueco/,
  /\bdisponib/,
  /\bturno\b/,
  /\bsesion\b/,
  /\bno (?:podre|puedo) ir\b/,
  /\b(?:cambiar|mover|anular|cancelar) (?:mi|la) (?:cita|sesion|reserva)\b/,
  /\bnecesito\b/,
  /\bbusco\b/,
  /\bseria para\b/,
  /\bquisiera\b/,
  /\bme gustaria\b/,
  /\bquiero\b/,
  /\bpodria ser\b/,
  /\bme (?:puede|pueden|podria|podrian) (?:ver|atender)\b/,
  /\bhablar con\b/,
  /\b(?:hoy|manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b.*\b(?:a las|por la)\b/,
  /\ba las \d/,
];

export function ruleBasedIntent(text: string): Intent {
  const t = normalizeText(text);
  if (PROCEDURE_QUESTION.test(t)) return 'FAQ';
  if (CONFIRM_EXISTING.test(t) && !/\b(?:cambiar|cancelar|anular)\b/.test(t)) return 'FAQ';
  if (INFO_REQUEST.test(t) && !/\b(?:cita|reserv|hueco)\b/.test(t)) return 'FAQ';
  return BOOKING_SIGNALS.some((re) => re.test(t)) ? 'CITA' : 'FAQ';
}

// ---------------------------------------------------------------------------------------------
// FAQ
// ---------------------------------------------------------------------------------------------

function promptField(prompt: string, label: string): string | undefined {
  const re = new RegExp(`^${label}:\\s*(.+)$`, 'im');
  return re.exec(prompt)?.[1]?.trim();
}

function promptList(prompt: string, heading: string): string[] {
  const lines = prompt.split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase().startsWith(heading.toLowerCase()));
  if (start === -1) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^\s*-\s+(.+)$/.exec(line);
    if (!m?.[1]) break;
    items.push(m[1].trim());
  }
  return items;
}

export function ruleBasedFaq(faqPrompt: string, text: string): string {
  const t = normalizeText(text);
  const phone = promptField(faqPrompt, 'Teléfono') ?? 'el teléfono de la clínica';
  const field = (label: string, intro: string): string | undefined => {
    const value = promptField(faqPrompt, label);
    return value ? `${intro} ${value.charAt(0).toLowerCase()}${value.slice(1)}.` : undefined;
  };

  if (/\b(?:hola|buenas|buenos dias|buenas tardes)\b/.test(t) && t.split(' ').length <= 4) {
    return '¡Hola! ¿En qué puedo ayudarte?';
  }
  if (/\bgracias\b/.test(t)) return '¡Gracias a ti! Aquí estaré si necesitas algo más.';
  if (/\b(?:adios|hasta luego|chao)\b/.test(t)) return '¡Hasta pronto! Que tengas un buen día.';
  if (/\b(?:horario|hora(?:s)? (?:abr|cerr)|abris|abren|cerrais|cierran|que horas)\b/.test(t)) {
    return field('Horario', 'Nuestro horario es:') ?? `Llama al ${phone} para más detalles.`;
  }
  if (/\b(?:direccion|donde|ubicad|como llego|llegar)\b/.test(t)) {
    return field('Dirección', 'Estamos en') ?? `Llama al ${phone} para más detalles.`;
  }
  if (/\b(?:aparcar|parking|aparcamiento)\b/.test(t)) {
    return field('Parking', 'Sobre el aparcamiento:') ?? `Llama al ${phone} para más detalles.`;
  }
  if (/\b(?:pago|pagar|tarjeta|efectivo|bizum)\b/.test(t)) {
    return field('Pagos', 'Formas de pago:') ?? `Llama al ${phone} para más detalles.`;
  }
  if (/\b(?:seguro|aseguradora|mutua|sanitas|adeslas|asisa)\b/.test(t)) {
    return `Sobre aseguradoras, llama al ${phone} para más detalles.`;
  }
  if (/\burgencia/.test(t)) {
    return `No atendemos urgencias como tal, pero llama al ${phone} y vemos disponibilidad.`;
  }
  if (/\b(?:telefono|llamar|contacto)\b/.test(t)) return `Puedes llamarnos al ${phone}.`;
  if (/\b(?:profesional|fisios?|fisioterapeutas?|quien|osteopatas?)\b/.test(t)) {
    const list = promptList(faqPrompt, 'Profesionales');
    if (list.length > 0) return `Nuestro equipo: ${list.join('; ')}.`;
  }
  if (/\b(?:servicio|tratamiento|haceis|ofreceis|teneis|masaje|ecografia|presoterapia|rehabilitacion)/.test(t)) {
    const list = promptList(faqPrompt, 'Servicios');
    if (list.length > 0) return `Ofrecemos: ${list.join(', ').toLowerCase()}.`;
  }
  if (/\b(?:precio|cuanto cuesta|tarifa|cuanto vale)\b/.test(t)) {
    return `Llama al ${phone} para más detalles sobre precios.`;
  }
  if (/\b(?:reserv|cita)\b/.test(t)) {
    return 'Puedes pedir cita aquí mismo indicando el día y la hora que prefieres.';
  }
  return `No estoy seguro, mejor llama al ${phone}.`;
}

// ---------------------------------------------------------------------------------------------
// Dates (Spanish)
// ---------------------------------------------------------------------------------------------

const WEEKDAY_WORDS: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};
const MONTH_WORDS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};
const NUMBER_WORDS: Record<string, number> = {
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
};

interface DayRef {
  year: number;
  month: number;
  day: number;
}

function toNumber(token: string): number {
  return /^\d+$/.test(token) ? Number(token) : (NUMBER_WORDS[token] ?? NaN);
}

function compareDay(a: DayRef, b: DayRef): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

function isValidDay(d: DayRef): boolean {
  const date = new Date(Date.UTC(d.year, d.month - 1, d.day));
  return date.getUTCMonth() === d.month - 1 && date.getUTCDate() === d.day;
}

function shiftDays(base: DayRef, days: number): DayRef {
  const date = new Date(Date.UTC(base.year, base.month - 1, base.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Day of month in the current month, or next month when already past. */
function nextDayOfMonth(today: DayRef, day: number): DayRef | null {
  for (let i = 0; i < 3; i++) {
    const month = ((today.month - 1 + i) % 12) + 1;
    const year = today.year + Math.floor((today.month - 1 + i) / 12);
    const candidate = { year, month, day };
    if (isValidDay(candidate) && compareDay(candidate, today) >= 0) return candidate;
  }
  return null;
}

function extractDay(t: string, today: DayRef, todayWeekday: number): DayRef | null {
  const months = Object.keys(MONTH_WORDS).join('|');
  const explicit = new RegExp(`\\b(\\d{1,2}) de (${months})(?: de (\\d{4}))?\\b`).exec(t);
  if (explicit) {
    const day = Number(explicit[1]);
    const month = MONTH_WORDS[explicit[2] ?? ''] ?? 0;
    let candidate: DayRef = { year: explicit[3] ? Number(explicit[3]) : today.year, month, day };
    if (!explicit[3] && compareDay(candidate, today) < 0) candidate = { ...candidate, year: today.year + 1 };
    return isValidDay(candidate) ? candidate : null;
  }
  const numeric = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
  if (numeric) {
    const yearRaw = numeric[3];
    const year = yearRaw ? (yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw)) : today.year;
    let candidate: DayRef = { year, month: Number(numeric[2]), day: Number(numeric[1]) };
    if (!yearRaw && compareDay(candidate, today) < 0) candidate = { ...candidate, year: today.year + 1 };
    return isValidDay(candidate) ? candidate : null;
  }
  if (/\bpasado manana\b/.test(t)) return shiftDays(today, 2);
  if (/(?<!por la |de la |esta |la )\bmanana\b/.test(t)) return shiftDays(today, 1);
  if (/\bhoy\b/.test(t)) return today;
  const inDays = /\bdentro de (\d{1,2}) dias\b/.exec(t);
  if (inDays) return shiftDays(today, Number(inDays[1]));
  const weekday = new RegExp(`\\b(${Object.keys(WEEKDAY_WORDS).join('|')})\\b(?:\\s+(?:dia\\s+)?(\\d{1,2})\\b)?`).exec(t);
  if (weekday) {
    if (weekday[2]) return nextDayOfMonth(today, Number(weekday[2]));
    const target = WEEKDAY_WORDS[weekday[1] ?? ''] ?? 0;
    let diff = (target - todayWeekday + 7) % 7;
    if (diff === 0) diff = 7;
    return shiftDays(today, diff);
  }
  const dayOnly = /\bel (?:dia )?(\d{1,2})\b(?!\s*(?:h\b|:|y |menos|de la))/.exec(t);
  if (dayOnly) return nextDayOfMonth(today, Number(dayOnly[1]));
  return null;
}

function extractTime(t: string): { hour: number; minute: number } | null {
  const words = Object.keys(NUMBER_WORDS).join('|');
  const re = new RegExp(
    `\\b(?:a las|a la|sobre las|hacia las|para las|las)\\s+(\\d{1,2}|${words})(?:[:.h](\\d{2}))?` +
      `(?:\\s*(y media|y cuarto|menos cuarto))?(?:\\s*(?:h|horas)\\b)?` +
      `(?:\\s*(de la manana|de la tarde|de la noche|del mediodia|am|pm))?`,
  );
  let hour: number;
  let minute = 0;
  let period: string | undefined;
  const m = re.exec(t);
  if (m) {
    hour = toNumber(m[1] ?? '');
    if (m[2]) minute = Number(m[2]);
    if (m[3] === 'y media') minute = 30;
    if (m[3] === 'y cuarto') minute = 15;
    if (m[3] === 'menos cuarto') {
      hour -= 1;
      minute = 45;
    }
    period = m[4];
  } else {
    const clock = /\b(\d{1,2})[:.](\d{2})\b/.exec(t) ?? /\b(\d{1,2})\s*h\b/.exec(t);
    const ampm = /\b(\d{1,2})\s*(am|pm)\b/.exec(t);
    if (clock) {
      hour = Number(clock[1]);
      minute = clock[2] ? Number(clock[2]) : 0;
    } else if (ampm) {
      hour = Number(ampm[1]);
      period = ampm[2];
    } else {
      return null;
    }
    if (!period) period = /\bde la (manana|tarde|noche)\b/.exec(t)?.[0];
  }
  if (Number.isNaN(hour)) return null;
  if (period && /tarde|noche|pm/.test(period) && hour < 12) hour += 12;
  else if (period && /manana|am/.test(period) && hour === 12) hour = 0;
  else if (!period && hour >= 1 && hour <= 6) hour += 12;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function ruleBasedParseDate(text: string, now: Date, timeZone: string): ParsedDate {
  const t = normalizeText(text);
  const p = getZonedParts(now, timeZone);
  const today: DayRef = { year: p.year, month: p.month, day: p.day };
  let day = extractDay(t, today, p.weekday);
  const time = extractTime(t);
  if (!day && !time) return { datetime: null, hasTime: false };
  if (!day && time) {
    const passed = time.hour * 60 + time.minute <= p.hour * 60 + p.minute;
    day = passed ? shiftDays(today, 1) : today;
  }
  if (!day) return { datetime: null, hasTime: false };
  const instant = zonedTimeToUtc(
    { ...day, hour: time?.hour ?? 0, minute: time?.minute ?? 0 },
    timeZone,
  );
  return { datetime: toZonedIso(instant, timeZone), hasTime: time !== null };
}

export function createMockAIService(): AIService {
  return {
    mode: 'mock',
    async getAIResponse(req) {
      return `[mock] ${req.user.slice(0, 120)}`;
    },
    async detectIntent(text) {
      return ruleBasedIntent(text);
    },
    async answerFaq(tenant, text) {
      return ruleBasedFaq(tenant.faqPrompt, text);
    },
    async parseDate(text, now, timeZone) {
      return ruleBasedParseDate(text, now, timeZone);
    },
  };
}
