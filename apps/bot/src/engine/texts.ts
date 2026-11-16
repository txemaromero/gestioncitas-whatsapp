/**
 * Bot messages (Spanish, Spain). Texts marked "original" reproduce the conversation design of the
 * specification; the rest follow the same tone.
 */
import type { Tenant } from '@clinicai/db';

export const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

export function contactPhoneOf(tenant: Tenant): string {
  return tenant.settings.contactPhone || tenant.phoneNormalized || '';
}

export const T = {
  // mainFlow (original)
  welcomeBack: (name: string, clinic: string) => `¡Hola ${firstName(name)}! Bienvenido/a de nuevo a ${clinic} 👋`,
  aiNotice: (clinic: string) => `Soy el asistente virtual 🤖 de ${clinic}.`,
  howCanIHelp: '¿En qué puedo ayudarte hoy?',

  // registerFlow (original)
  registerIntro: (clinic: string) =>
    `Bienvenido/a a ${clinic}. Soy su asistente virtual 🤖. Parece que es tu primera vez aquí.`,
  // Privacy notice (F12, GDPR art. 13 first layer): shown before storing any data.
  privacyNotice: (clinic: string, policyUrl: string | null) =>
    `🔒 Protección de datos: el responsable es ${clinic}. Usaremos tu nombre, tu email y este teléfono solo para gestionar tus citas y responder a tus consultas. Tus mensajes, también las notas de voz (que se transcriben a texto y no se guardan), los procesa un asistente con inteligencia artificial. Puedes pedir a ${clinic} en cualquier momento que te muestre, corrija o borre tus datos.` +
    (policyUrl ? `\nMás información: ${policyUrl}` : ''),
  registerQuestion: '¿Aceptas el tratamiento de tus datos y quieres registrarte?',
  registerYes: 'Acepto',
  registerNo: 'No acepto',
  registerDeclined: 'De acuerdo, no guardaremos tus datos. Si cambias de opinión, escríbeme cuando quieras.',
  // Clients created from the panel accept the notice the first time they write.
  consentRequired: (name: string, clinic: string) =>
    `¡Hola ${firstName(name)}! Antes de continuar, necesitamos que aceptes cómo trata ${clinic} tus datos.`,
  consentQuestion: '¿Aceptas el tratamiento de tus datos?',
  consentThanks: '✅ ¡Gracias! ¿En qué puedo ayudarte hoy?',
  consentThanksSlot: '✅ ¡Gracias! Seguimos con la cita que has elegido.',
  consentDeclined: (clinic: string, phone: string) =>
    `De acuerdo. Sin tu aceptación no puedo atenderte por este chat. Puedes contactar con ${clinic}${phone ? ` en el ${phone}` : ''}.`,
  registerStart: 'Perfecto, voy a proceder con algunas preguntas',
  askFullName: 'Por favor, escribe tu nombre completo:',
  invalidName: 'Ese nombre no parece válido. Por favor, escribe tu nombre completo (por ejemplo: Ana García López):',
  askEmail: '¿Cuál es tu email?',
  invalidEmail: 'Ese email no parece válido. Ejemplo: nombre@gmail.com. Inténtalo de nuevo:',
  registered: (clinic: string, name: string) =>
    `✅ ¡Registro completado en ${clinic}, ${firstName(name)}! Ahora puedes pedir tu cita.`,
  registeredSlot: (clinic: string, name: string) =>
    `✅ ¡Registro completado en ${clinic}, ${firstName(name)}! Seguimos con la cita que has elegido.`,
  pleaseChooseOption: 'Por favor, elige una de las opciones:',

  // citaFlow (original)
  askDate: (clinic: string) => `Por favor, indícame la fecha para tu cita en ${clinic} (Ej: "15 de marzo a las 10")`,
  dateNotUnderstood:
    'No he entendido la fecha 🤔. Indícame día y hora, por ejemplo "mañana a las 10" o "15 de marzo a las 17:30".',
  askTime: (humanDate: string) =>
    `¿A qué hora te vendría bien el ${humanDate}? Por ejemplo: "a las 10" o "a las 17:30".`,
  pastDate: 'Esa fecha ya ha pasado. Dime otra, por ejemplo "mañana a las 10"',
  // F34: BOOKING_HORIZON_DAYS.
  tooFarDate: (phone: string) =>
    `Por WhatsApp puedo reservar hasta 6 meses vista. Dime una fecha más cercana${phone ? ` o llámanos al ${phone} para algo más adelante` : ''}.`,
  noAvailability: (humanDateTime: string) =>
    `Lo siento, no hay disponibilidad para ${humanDateTime}. ¿Te viene bien otro día u hora?`,
  suggestionsHint: 'Estos son los huecos libres más cercanos. Pulsa uno o escríbeme otra fecha:',
  available: (humanDateTime: string, clinic: string) =>
    `✅ ¡Genial! La fecha ${humanDateTime} está disponible en ${clinic}.`,
  adjustedTime: (time: string) => `(He ajustado la hora a las ${time} para encajar con la duración de las citas).`,

  // employeeFlow (original)
  chooseEmployee: (clinic: string) =>
    `Estos son los profesionales disponibles en ${clinic} para esa hora. Selecciona uno o pulsa "Cancelar" para salir:`,
  employeeNotFound: 'No he encontrado a ese profesional. Elige uno de la lista, por favor:',
  listButton: 'Ver profesionales',
  cancel: 'Cancelar',

  // confirmationFlow (original)
  selectedEmployee: (employee: string, clinic: string) => `✅ Has seleccionado a ${employee} en ${clinic}.`,
  // F14: services with their own duration.
  askService: (clinic: string) => `¿Qué servicio necesitas en ${clinic}? Elige uno de la lista:`,
  servicesButton: 'Ver servicios',
  serviceChosen: (service: string, duration: string) => `Perfecto: ${service} (${duration}).`,
  serviceLine: (service: string, duration: string) => `\n💆 Servicio: ${service} (${duration})`,
  summary: (date: string, time: string, employee: string) =>
    `📅 Fecha: ${date}\n🕐 Hora: ${time}\n👤 Profesional: ${employee}`,
  confirmQuestion: '¿Deseas confirmar la cita, cambiar la fecha o salir?',
  confirmYes: 'Sí ✅',
  confirmOther: 'Otra fecha',
  confirmExit: 'Salir',
  booked: (clinic: string, humanDateTime: string) => `✅ ¡Cita confirmada en ${clinic} para ${humanDateTime}!`,
  slotTaken: 'Lo siento, ese hueco acaba de ocuparse 😕. Indícame otra fecha, por ejemplo "mañana a las 10".',
  bookingCancelled: 'Has cancelado la reserva. ¡Aquí estaré si me necesitas!',

  // manageFlow (F13): the client's existing appointments.
  myAppointments: 'Mis citas',
  newAppointment: 'Pedir cita',
  howCanIHelpWithAppointments: (count: number) =>
    `¿En qué puedo ayudarte hoy? Tienes ${count === 1 ? '1 cita próxima' : `${count} citas próximas`}.`,
  noUpcoming: 'No tienes ninguna cita próxima. Si quieres pedir una, dime qué día y a qué hora te viene bien.',
  appointmentLine: (when: string, employee: string, status: string) => `📅 ${when}\n👤 ${employee}\n📌 ${status}`,
  oneAppointment: (line: string) => `Tu próxima cita:\n${line}\n\n¿Qué quieres hacer?`,
  chooseAppointment: {
    list: 'Estas son tus próximas citas. Elige una para cambiarla o cancelarla:',
    cancel: '¿Qué cita quieres cancelar?',
    change: '¿Qué cita quieres cambiar?',
  },
  appointmentsListButton: 'Ver citas',
  appointmentChosen: (line: string) => `${line}\n\n¿Qué quieres hacer con esta cita?`,
  changeDate: 'Cambiar fecha',
  cancelAppointment: 'Cancelar cita',
  keepAppointment: 'Nada, gracias',
  keptAppointment: 'Perfecto, la dejamos como está. ¿Te puedo ayudar en algo más?',
  confirmCancel: (when: string, employee: string) => `¿Seguro que quieres cancelar tu cita del ${when} con ${employee}?`,
  confirmCancelYes: 'Sí, cancelarla',
  confirmCancelNo: 'No, mantenerla',
  appointmentCancelled: (when: string) =>
    `✅ Tu cita del ${when} ha quedado cancelada. Si quieres pedir otra, dime qué día y a qué hora te viene bien.`,
  tooLateToModify: (hours: number, clinic: string, phone: string) =>
    `Lo siento, por aquí solo se pueden cancelar o cambiar las citas con al menos ${hours} h de antelación. Para hacerlo ahora, contacta con ${clinic}${phone ? ` en el ${phone}` : ''}.`,
  appointmentGone: 'Esa cita ya no se puede modificar: puede que se haya cancelado o que ya haya pasado.',
  rescheduleAskDate: (when: string, employee: string) =>
    `Tu cita actual es el ${when} con ${employee}. ¿Qué día y a qué hora te vendría mejor?`,
  rescheduleSummaryTitle: '🔁 Cambio de cita',
  rescheduleQuestion: '¿Confirmas el cambio, prefieres otra fecha o lo dejas como estaba?',
  rescheduled: (clinic: string, when: string) => `✅ ¡Hecho! Tu cita en ${clinic} ahora es el ${when}.`,
  rescheduleAborted: 'De acuerdo, no cambiamos nada: tu cita sigue como estaba.',
  rescheduleSlotTaken: (oldWhen: string) =>
    `Lo siento, ese hueco acaba de ocuparse 😕. Tu cita sigue el ${oldWhen}. Indícame otra fecha, por ejemplo "mañana a las 10".`,

  // F17: waiting list.
  waitlistAskDay: 'Ese día está completo. ¿Quieres que te avise si se libera algún hueco?',
  waitlistAskTime: (time: string) => `¿Prefieres esperar a las ${time}? Puedo avisarte si se libera.`,
  waitlistButton: '🔔 Avisarme',
  waitlistJoined: (when: string) =>
    `🔔 Te he apuntado a la lista de espera para ${when}. Si se libera un hueco, te escribo por aquí y podrás reservarlo con un botón.`,
  waitlistAlready: (when: string) => `Ya estás en la lista de espera para ${when}. Te aviso si se libera un hueco.`,
  waitlistLimit: (max: number) =>
    `Ya estás en ${max} listas de espera, que es el máximo 🙏. Cuando se resuelva alguna podrás apuntarte a otra.`,
  waitlistUnavailable: 'Ahora mismo no puedo apuntarte a la lista de espera 🙏. ¿Quieres probar con otra fecha?',
  waitlistOfferPreview: (name: string, clinic: string, when: string, minutes: string) =>
    `Hola ${name}, se ha liberado un hueco en ${clinic}: ${when}. ¿Quieres reservarlo? Si no respondes en ${minutes} minutos, se lo ofreceremos a otra persona de la lista de espera.`,
  waitlistButtonBook: 'Reservar',
  waitlistButtonSkip: 'No, gracias',
  waitlistBooked: (clinic: string, when: string, professional: string) =>
    `✅ ¡Reservado! Tu cita en ${clinic} es el ${when} con ${professional}.`,
  waitlistTaken: 'Vaya, ese hueco ya se ha ocupado 😕. Sigues en la lista de espera: te aviso si se libera otro.',
  waitlistLeft: (when: string) => `De acuerdo, te he quitado de la lista de espera para ${when}.`,
  waitlistClosed: 'Esta oferta ya no está disponible. Si quieres, escríbeme y buscamos otra fecha.',

  // reminders (original)
  reminderPreview: (name: string, clinic: string, day: string, time: string) =>
    `Hola ${firstName(name)}, te recordamos tu cita en ${clinic} el ${day} a las ${time}.`,
  reminderButtonConfirm: 'Sí, confirmo',
  reminderButtonCancel: 'No puedo asistir',
  reminderConfirmed: (clinic: string, when: string) =>
    `¡Gracias! Tu cita en ${clinic} ha sido confirmada ✅. ¡Nos vemos ${when}!`,
  reminderAlreadyConfirmed: (when: string) => `Tu cita ya estaba confirmada ✅. ¡Nos vemos ${when}!`,
  reminderCancelled: 'Tu cita ha sido cancelada. Si quieres reservar otra, escríbeme cuando quieras.',
  reminderAlreadyCancelled: 'Esta cita ya estaba cancelada. Si quieres reservar otra, escríbeme cuando quieras.',
  reminderNotFound: 'No he encontrado esa cita. Si necesitas ayuda, escríbeme cuando quieras.',
  /** F32: the FAQ answer did not pass the checks (faqAnswer.ts). */
  faqFallback: (phone: string) =>
    `No puedo responderte a eso por aquí 🙏. Si quieres pedir, cambiar o anular una cita, dímelo y te ayudo.${phone ? ` Para otras dudas, llámanos al ${phone}.` : ''}`,
  reminderPast: 'Esa cita ya ha pasado, así que no he cambiado nada. Si quieres reservar otra, escríbeme cuando quieras.',
  reminderAsk: (clinic: string, when: string, time: string) =>
    `¿Puedes confirmarme si asistirás a tu cita en ${clinic} ${when} a las ${time}?`,

  // global
  escapeGoodbye: 'De acuerdo, he cancelado la operación. Si necesitas algo más, escríbeme cuando quieras 👋',
  menuHelp: (clinic: string) =>
    `Puedo ayudarte a pedir una cita (por ejemplo: "quiero cita mañana a las 10"), decirte las sesiones que te quedan del bono o resolver tus dudas sobre ${clinic}. ¿Qué necesitas?`,

  // packsFlow (F26): sessions left of the client's packs.
  packLine: (name: string, remaining: number, total: number, until: string | null) =>
    `🎟️ «${name}»: te ${remaining === 1 ? 'queda 1 sesión' : `quedan ${remaining} sesiones`} de ${total}${until ? `, hasta el ${until}` : ''}.`,
  packsMany: (lines: string[]) => `Estos son tus bonos:\n${lines.join('\n')}`,
  packsNone: (clinic: string) => `No tienes ningún bono en ${clinic}. Si te interesa, pregunta en la clínica.`,
  packUsedUp: (name: string) => `Ya has usado todas las sesiones de tu «${name}». Si quieres renovarlo, pregunta en la clínica.`,
  packExpired: (name: string, on: string) => `Tu «${name}» caducó el ${on}. Si quieres renovarlo, pregunta en la clínica.`,
  tooManyErrors: (clinic: string, phone: string) =>
    phone
      ? `No consigo entenderte bien 😅. Para continuar, llama a ${clinic} al ${phone}.`
      : `No consigo entenderte bien 😅. Para continuar, ponte en contacto directamente con ${clinic}.`,
  onlyText: 'De momento solo entiendo mensajes de texto 🙏. ¿Puedes escribirme lo que necesitas?',
  // F16: voice notes.
  voiceUnderstood: (text: string) => `🎤 He entendido: «${text}»`,
  voiceTooLong: (maxMinutes: number) =>
    `Tu nota de voz es un poco larga 🙏. ¿Puedes enviarla de ${maxMinutes === 1 ? '1 minuto' : `${maxMinutes} minutos`} como máximo, o escribirme lo que necesitas?`,
  voiceUnavailable: 'Ahora mismo no puedo escuchar esta nota de voz 🙏. ¿Puedes escribirme lo que necesitas?',
  voiceEmpty: 'No he conseguido entender la nota de voz 🙏. ¿Puedes repetirla o escribirme lo que necesitas?',
  voiceNeedsConsent:
    'Antes de escuchar notas de voz necesito que aceptes el aviso de privacidad 🙏. ¿Puedes escribirme lo que necesitas?',
  aiUnavailable: 'Lo siento, ahora mismo no puedo procesar tu mensaje 🙏. Inténtalo de nuevo en unos minutos.',
} as const;
