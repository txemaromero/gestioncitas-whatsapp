/** Deterministic text matching used by the flows (never the LLM). */
import { normalizeText } from '@clinicai/shared';

const YES = /^(?:si+|sip|claro|vale|ok|okay|okey|de acuerdo|perfecto|por supuesto|confirmo|confirmado|confirmada|correcto|adelante|genial|venga)\b/;
const YES_ANYWHERE = /\b(?:alli estare|ahi estare|cuenta conmigo|nos vemos|confirmo|si confirmo|asistire)\b/;
const NO = /^(?:no|nop|nunca|para nada)\b/;
const NO_ANYWHERE = /\b(?:no puedo|no podre|no voy|no ire|no asistire|no me va bien|cancela|cancelar|anula|anular|imposible)\b/;

export function isYes(text: string): boolean {
  const t = normalizeText(text);
  return (YES.test(t) || YES_ANYWHERE.test(t)) && !NO_ANYWHERE.test(t);
}

export function isNo(text: string): boolean {
  const t = normalizeText(text);
  return NO.test(t) || NO_ANYWHERE.test(t);
}

export type YesNo = 'yes' | 'no' | 'unknown';

export function classifyYesNo(text: string): YesNo {
  const yes = isYes(text);
  const no = isNo(text);
  if (yes && !no) return 'yes';
  if (no && !yes) return 'no';
  return 'unknown';
}

const GREETING = /^(?:hola+|holi|ola|buenas|buenos dias|buen dia|buenas tardes|buenas noches|hey|hello|hi|saludos|que tal|hola que tal|hola buenas|hola buenos dias|hola buenas tardes)$/;

/** Message that only greets (no request inside). */
export function isGreetingOnly(text: string): boolean {
  const t = normalizeText(text).replace(/[.:,+-]/g, ' ').replace(/\s+/g, ' ').trim();
  return t === '' || GREETING.test(t);
}

export type EscapeWord = 'cancel' | 'menu';

/** Global escape words (whole message): cancelar / salir → cancel, menú → menu. */
export function detectEscape(text: string): EscapeWord | null {
  const t = normalizeText(text).replace(/[.!?]/g, '').trim();
  if (/^(?:cancelar|cancela|cancelo|salir|salgo|terminar|parar|stop)$/.test(t)) return 'cancel';
  if (/^(?:menu|menu principal|inicio|ayuda|opciones)$/.test(t)) return 'menu';
  return null;
}

/** Flexible employee name matching (no accents, case-insensitive, first name allowed). */
export function matchEmployee<E extends { id: string; name: string }>(text: string, employees: readonly E[]): E | null {
  const t = normalizeText(text);
  if (!t) return null;
  const exact = employees.filter((e) => normalizeText(e.name) === t);
  if (exact.length === 1) return exact[0] ?? null;
  const partial = employees.filter((e) => {
    const name = normalizeText(e.name);
    return name.includes(t) || t.includes(name) || name.split(' ').some((part) => part.length > 2 && t.split(' ').includes(part));
  });
  return partial.length === 1 ? (partial[0] ?? null) : null;
}

/** Does the text mention a day (so it is a full new date, not only a time)? */
export function mentionsDay(text: string): boolean {
  const t = normalizeText(text);
  return /\b(?:hoy|manana|pasado|lunes|martes|miercoles|jueves|viernes|sabado|domingo|dia|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|semana)\b|\d{1,2}\/\d{1,2}/.test(
    t,
  );
}

export type ManageAction = 'list' | 'cancel' | 'change';

const APPOINTMENT_WORD = /\b(?:citas?|reservas?|sesion(?:es)?)\b/;
const CANCEL_VERB = /\b(?:cancel(?:ar|a|o)|anul(?:ar|a|o)|desconvocar|borr(?:ar|a)|elimin(?:ar|a)|quit(?:ar|a))(?:la|las)?\b/;
const CHANGE_VERB =
  /\b(?:cambi(?:ar|a|o)|mov(?:er|ed)|muev(?:o|e)|modific(?:ar|a)|aplaz(?:ar|a)|retras(?:ar|a)|adelant(?:ar|a)|reprogram(?:ar|a)|pospon(?:er|go)?)(?:la|las)?\b/;
const PRONOUN_VERB = /\b(?:cancelarla|anularla|cambiarla|moverla|modificarla|aplazarla|retrasarla|adelantarla|reprogramarla|posponerla)\b/;
const LIST_REQUEST =
  /\b(?:mis citas|ver (?:mi|mis) citas?|que citas? tengo|cuando (?:es|tengo) (?:mi |la )?cita|a que hora (?:es|tengo) (?:mi |la )?cita|cual es mi cita|tengo (?:alguna |ya )?cita|mi proxima cita|no (?:podre|puedo|voy a poder) ir)\b/;

/**
 * Requests about the client's EXISTING appointments (F13), detected with rules before the LLM:
 * see them, cancel one or change its date. The evaluated intent prompt already sends explicit
 * cancel/change requests to CITA; this decides deterministically that they are not new bookings.
 */
export function detectManageRequest(text: string): ManageAction | null {
  const t = normalizeText(text);
  const aboutAppointment = APPOINTMENT_WORD.test(t) || PRONOUN_VERB.test(t);
  const cancel = aboutAppointment && CANCEL_VERB.test(t);
  const change = aboutAppointment && CHANGE_VERB.test(t);
  if (cancel && change) return 'list';
  if (cancel) return 'cancel';
  if (change) return 'change';
  return LIST_REQUEST.test(t) ? 'list' : null;
}

const PACK_SUBJECT = /\b(?:sesion(?:es)?|bonos?)\b/;
const PACK_LEFT = /\b(?:quedan?|restan?|faltan?|llevo|usad[ao]s?|gastad[ao]s?|consumid[ao]s?)\b/;
const PACK_MINE = /\b(?:mis? bonos?|cuantas sesiones tengo)\b/;
/** Questions about free slots, prices or new bookings are not about the client's own pack. */
const NOT_PACK_STATUS =
  /\b(?:libres?|huecos?|disponibles?|disponibilidad|precios?|cuestan?|valen?|comprar|contratar|reservar)\b|\b(?:pedir|quiero) (?:una )?cita\b/;

/**
 * F26: «¿cuántas sesiones me quedan?», «¿me queda algo del bono?», «mi bono»… detected with rules
 * before the LLM (the evaluated intent prompt does not change). Price questions stay FAQ.
 */
export function detectPackRequest(text: string): boolean {
  const t = normalizeText(text);
  if (NOT_PACK_STATUS.test(t)) return false;
  return (PACK_SUBJECT.test(t) && PACK_LEFT.test(t)) || PACK_MINE.test(t);
}
