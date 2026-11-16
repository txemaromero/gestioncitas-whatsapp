/**
 * FisioDemo (fictitious physiotherapy clinic): professionals, services and the information of its
 * assistant (F29). Shared by the seed, the FAQ evaluation (`fisiodemo-faq.txt` is the prompt they
 * produce, checked by a test) and `pnpm --filter @clinicai/db faq:fisiodemo`, which rewrites it.
 */
import { buildDefaultFaqPrompt, DEFAULT_SECTOR, type AssistantInfo, type ScheduleSlot } from '@clinicai/shared';

export const FISIODEMO_NAME = 'FisioDemo';
export const FISIODEMO_CONTACT_PHONE = '965 000 000';
export const FISIODEMO_SECTOR = DEFAULT_SECTOR;

export const FISIODEMO_EMPLOYEES: { id: string; name: string; role: string; schedule: ScheduleSlot[] }[] = [
  { id: '11111111-0000-4000-8000-000000000001', name: 'Óscar', role: 'admin', schedule: [] },
  {
    id: '11111111-0000-4000-8000-000000000002',
    name: 'Daniel',
    role: 'fisioterapeuta y osteópata',
    schedule: [
      { day: 'monday', start: '07:00', end: '13:55' },
      { day: 'wednesday', start: '07:00', end: '19:55' },
      { day: 'thursday', start: '12:00', end: '19:55' },
      { day: 'friday', start: '07:00', end: '11:55' },
    ],
  },
  {
    id: '11111111-0000-4000-8000-000000000003',
    name: 'Marcos',
    role: 'fisioterapeuta y osteópata',
    schedule: [
      { day: 'monday', start: '12:00', end: '19:55' },
      { day: 'wednesday', start: '07:00', end: '11:55' },
      { day: 'thursday', start: '12:00', end: '19:55' },
      { day: 'saturday', start: '09:00', end: '17:00' },
      { day: 'sunday', start: '09:00', end: '17:00' },
    ],
  },
  {
    id: '11111111-0000-4000-8000-000000000004',
    name: 'Inés',
    role: 'fisioterapeuta',
    schedule: [
      { day: 'tuesday', start: '07:00', end: '11:55' },
      { day: 'thursday', start: '07:00', end: '11:55' },
      { day: 'friday', start: '12:00', end: '19:55' },
      { day: 'sunday', start: '09:00', end: '17:00' },
    ],
  },
];

// F14: services (fixed ids so the demo appointments can use one).
export const SESSION_SERVICE_ID = '11111111-0000-4000-a000-000000000001';
export const ASSESSMENT_SERVICE_ID = '11111111-0000-4000-a000-000000000002';
export const DRY_NEEDLING_SERVICE_ID = '11111111-0000-4000-a000-000000000003';
export const FISIODEMO_SERVICES = [
  { id: SESSION_SERVICE_ID, name: 'Sesión de fisioterapia', durationMinutes: 60 },
  { id: ASSESSMENT_SERVICE_ID, name: 'Valoración inicial', durationMinutes: 60 },
  { id: DRY_NEEDLING_SERVICE_ID, name: 'Punción seca', durationMinutes: 30 },
];

/** F29: what the assistant knows about FisioDemo (Settings → «Información para el asistente»). */
export const FISIODEMO_ASSISTANT_INFO: AssistantInfo = {
  address: 'C/ Mayor, 1, Alicante',
  city: 'Alicante',
  hours: 'lunes a viernes, de 7:00 a 20:00',
  payments: 'Aceptamos efectivo y tarjeta',
  insurers: '',
  parking: 'No propio, pero hay aparcamiento en la zona',
  services: [
    'Fisioterapia y terapia manual',
    'Osteopatía',
    'Rehabilitación y readaptación',
    'Ecografías',
    'Presoterapia',
    'Masajes terapéuticos y de descarga',
  ],
  notes: [`No atendemos urgencias como tal, pero te recomiendo llamar al ${FISIODEMO_CONTACT_PHONE} y vemos disponibilidad.`],
};

/** The FAQ prompt the bot uses for FisioDemo (the panel lists professionals by name). */
export function fisiodemoFaqPrompt(): string {
  return buildDefaultFaqPrompt({
    clinicName: FISIODEMO_NAME,
    phone: FISIODEMO_CONTACT_PHONE,
    sector: FISIODEMO_SECTOR,
    employees: [...FISIODEMO_EMPLOYEES].sort((a, b) => a.name.localeCompare(b.name, 'es')).map((e) => ({ ...e, active: true })),
    info: FISIODEMO_ASSISTANT_INFO,
    services: FISIODEMO_SERVICES.map((s) => ({ ...s, active: true })),
  });
}
