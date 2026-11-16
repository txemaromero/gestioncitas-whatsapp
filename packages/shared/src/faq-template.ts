/**
 * Default FAQ prompt. Built from the template of the optimized FisioDemo prompt (evaluated in
 * `eval/`) filled with the tenant data; unknown data becomes
 * "Consultar por teléfono". Used when the tenant has not uploaded its own `faqPrompt`.
 * F29: the clinic fills the rest in Settings (`settings.assistantInfo`): address, city, hours,
 * payments, insurers, parking, services with their prices and important notes. FisioDemo's
 * evaluated prompt (`fisiodemo-faq.txt`) is this template with its data (a test checks it).
 *
 * Kept as a TS module (not a .txt read with fs) because it is consumed both by the bot
 * and by the Next.js server (download/restore in Settings), where runtime fs paths are
 * not reliable across deployments.
 */
import { WEEKDAYS_MONDAY_FIRST, WEEKDAY_LABELS_ES } from './dates';
import { openingHoursByDay, type ScheduleSlot } from './schedule';
import { formatDuration } from './services';
import { DEFAULT_SECTOR, type AssistantInfo } from './settings';

export const UNKNOWN_INFO = 'Consultar por teléfono';

export const DEFAULT_FAQ_TEMPLATE = `Actúas como recepcionista virtual de {clinic}, {sector_article} {sector}{location}. Tu tarea es responder preguntas frecuentes de forma clara, profesional y concisa.

Dirección: {address}
Teléfono: {phone}
Horario: {hours}
Pagos: {payments}
Aseguradoras: {insurers}
Parking: {parking}

Servicios y tratamientos:
{services}

Profesionales:
{professionals}

Información importante:
{important}

Normas de respuesta:
- Contesta en **una sola frase**.
- Sé claro, útil y cordial.
- Si preguntan por reservas, invita a pedir cita aquí mismo indicando día y hora.
- Si algo requiere más información, responde: “Llama al {phone} para más detalles.”
- Si la información es general o razonable (como experiencia, tipos de pacientes, etc.), responde con una frase estándar profesional.
- Solo responde “No estoy seguro, mejor llama al {phone}” si la pregunta es muy específica o ambigua.`;

/** Always the last line of «Información importante». */
export const FAQ_ALWAYS_IMPORTANT = 'No podemos asegurar atención sin cita previa; se recomienda reservar con antelación.';

export interface DefaultFaqInput {
  clinicName: string;
  phone?: string | null;
  sector?: string | null;
  employees: readonly { name: string; role: string; active: boolean; schedule: readonly ScheduleSlot[] }[];
  /** F29: filled in Settings; null or empty fields → «Consultar por teléfono». */
  info?: AssistantInfo | null;
  /** F29: the panel's services, listed when the information has no services of its own. */
  services?: readonly { name: string; durationMinutes: number; active: boolean }[];
}

/** F29: the lines «Servicios y tratamientos» start with in Settings (the panel's active services). */
export function suggestedServiceLines(services: readonly { name: string; durationMinutes: number; active: boolean }[]): string[] {
  return services.filter((s) => s.active).map((s) => `${s.name} (${formatDuration(s.durationMinutes)})`);
}

function formatHours(schedules: readonly (readonly ScheduleSlot[])[]): string {
  const byDay = openingHoursByDay(schedules);
  const parts = WEEKDAYS_MONDAY_FIRST.flatMap((day) => {
    const range = byDay[day];
    return range ? [`${WEEKDAY_LABELS_ES[day].toLowerCase()} de ${range.start} a ${range.end}`] : [];
  });
  return parts.length > 0 ? parts.join('; ') : UNKNOWN_INFO;
}

export function buildDefaultFaqPrompt(input: DefaultFaqInput): string {
  const phone = input.phone?.trim() || UNKNOWN_INFO;
  const sector = input.sector?.trim() || DEFAULT_SECTOR;
  const visible = input.employees.filter((e) => e.active && e.schedule.length > 0);
  const professionals =
    visible.length > 0 ? visible.map((e) => `- ${e.name}: ${e.role}`).join('\n') : `- ${UNKNOWN_INFO}`;
  const article = /^(clínica|consulta|peluquería|academia|barbería)/i.test(sector) ? 'una' : 'un';
  const info = input.info ?? null;
  const or = (value: string | undefined) => value?.trim() || UNKNOWN_INFO;
  const serviceLines = info?.services.length ? info.services : suggestedServiceLines(input.services ?? []);
  const values: Record<string, string> = {
    clinic: input.clinicName,
    sector,
    sector_article: article,
    location: info?.city.trim() ? ` ${article === 'una' ? 'ubicada' : 'ubicado'} en ${info.city.trim()}` : '',
    address: or(info?.address),
    phone,
    hours: info?.hours.trim() || formatHours(visible.map((e) => e.schedule)),
    payments: or(info?.payments),
    insurers: or(info?.insurers),
    parking: or(info?.parking),
    services: serviceLines.length > 0 ? serviceLines.map((line) => `- ${line}`).join('\n') : `- ${UNKNOWN_INFO}`,
    professionals,
    important: [...(info?.notes ?? []), FAQ_ALWAYS_IMPORTANT].map((line) => `- ${line}`).join('\n'),
  };
  return DEFAULT_FAQ_TEMPLATE.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
