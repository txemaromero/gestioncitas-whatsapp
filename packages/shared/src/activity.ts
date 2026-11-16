/**
 * F24: activity log. Actions of the panel are the tRPC procedure path ("appointments.update");
 * actions of the bot and of automatic jobs are prefixed ("whatsapp.…", "system.…").
 */

export const ACTIVITY_ACTOR_LABELS_ES = {
  member: 'Panel',
  whatsapp: 'WhatsApp',
  system: 'Sistema',
} as const;
export type ActivityActorValue = keyof typeof ACTIVITY_ACTOR_LABELS_ES;

export const ACTIVITY_LABELS_ES: Record<string, string> = {
  // Panel: appointments.
  'appointments.create': 'Creó una cita',
  'appointments.update': 'Cambió una cita',
  'appointments.delete': 'Borró una cita',
  'appointments.setAttendance': 'Marcó la asistencia de una cita',
  'appointments.createSeries': 'Creó un tratamiento (varias citas)',
  'appointments.cancelFollowing': 'Canceló una cita y las siguientes del tratamiento',
  // Panel: clients.
  'clients.create': 'Dio de alta a un cliente',
  'clients.update': 'Editó la ficha de un cliente',
  'clients.get': 'Consultó la ficha de un cliente',
  'clients.export': 'Exportó los datos de un cliente',
  'clients.delete': 'Borró a un cliente y todos sus datos',
  'clients.import': 'Importó clientes desde un CSV',
  // Panel: packs (F26).
  'packs.create': 'Dio de alta un bono',
  'packs.update': 'Editó un bono',
  'packs.delete': 'Borró un bono',
  // Panel: team.
  'team.invite': 'Invitó a alguien al equipo',
  'team.cancelInvitation': 'Canceló una invitación',
  'team.changeRole': 'Cambió el rol de alguien del equipo',
  'team.remove': 'Quitó a alguien del equipo',
  'team.leave': 'Salió de la clínica',
  // F28: agenda links of the professionals.
  'calendarFeed.create': 'Creó el enlace de la agenda de un profesional',
  'calendarFeed.setFullNames': 'Cambió qué muestra el enlace de la agenda',
  'calendarFeed.revoke': 'Revocó el enlace de la agenda de un profesional',
  // Panel: clinic settings, professionals, services, absences.
  'tenant.update': 'Cambió los ajustes del negocio',
  'tenant.updatePrivacy': 'Cambió los ajustes de protección de datos',
  'tenant.updateWhatsApp': 'Cambió la configuración de WhatsApp',
  'tenant.uploadFaqPrompt': 'Cambió las preguntas frecuentes del asistente',
  'tenant.updateBookingPage': 'Cambió la página de reservas',
  'tenant.updateAssistantInfo': 'Cambió la información para el asistente',
  'employees.create': 'Dio de alta a un profesional',
  'employees.update': 'Editó un profesional',
  'employees.setActive': 'Activó o desactivó un profesional',
  'employees.delete': 'Borró un profesional',
  'services.create': 'Creó un servicio',
  'services.update': 'Editó un servicio',
  'services.setActive': 'Activó o desactivó un servicio',
  'services.delete': 'Borró un servicio',
  'timeOff.create': 'Añadió una ausencia o un cierre',
  'timeOff.delete': 'Quitó una ausencia o un cierre',
  'waitlist.add': 'Añadió a alguien a la lista de espera',
  'waitlist.remove': 'Quitó a alguien de la lista de espera',
  // WhatsApp (the client, through the bot).
  'whatsapp.client_registered': 'Se registró y aceptó el aviso de privacidad',
  'whatsapp.consent_accepted': 'Aceptó el aviso de privacidad',
  'whatsapp.appointment_booked': 'Reservó una cita',
  'whatsapp.appointment_rescheduled': 'Cambió la fecha de su cita',
  'whatsapp.appointment_cancelled': 'Canceló su cita',
  'whatsapp.appointment_confirmed': 'Confirmó su cita desde el recordatorio',
  'whatsapp.waitlist_joined': 'Se apuntó a la lista de espera',
  'whatsapp.waitlist_booked': 'Reservó un hueco de la lista de espera',
  'whatsapp.waitlist_left': 'Salió de la lista de espera',
  // Automatic jobs.
  'system.client_anonymized': 'Anonimizó a un cliente por el plazo de conservación',
};

export function activityLabel(action: string): string {
  return ACTIVITY_LABELS_ES[action] ?? action;
}

/** Filters of the panel: action prefixes of each category. */
export const ACTIVITY_CATEGORIES = {
  citas: { label: 'Citas', prefixes: ['appointments.', 'whatsapp.appointment_'] },
  clientes: { label: 'Clientes', prefixes: ['clients.', 'packs.', 'whatsapp.client_', 'whatsapp.consent_', 'system.client_'] },
  equipo: { label: 'Equipo', prefixes: ['team.', 'calendarFeed.'] },
  ajustes: { label: 'Ajustes', prefixes: ['tenant.', 'employees.', 'services.', 'timeOff.'] },
  espera: { label: 'Lista de espera', prefixes: ['waitlist.', 'whatsapp.waitlist_'] },
} as const;
export type ActivityCategory = keyof typeof ACTIVITY_CATEGORIES;

/**
 * Details that may be stored (never names, phones, emails, notes, reasons or file contents).
 * Anything else in an input is dropped.
 */
export const ACTIVITY_SAFE_FIELDS = [
  'status',
  'start',
  'employeeId',
  'serviceId',
  'attendance',
  'role',
  'active',
  'consent',
  'waitlistEnabled',
  'minNoticeHours',
  'slotMinutes',
  'retentionMonths',
  'durationMinutes',
  'day',
  'time',
  'onlyThatTime',
  'startsAt',
  'endsAt',
  'force',
  'imported',
  'skippedCount',
  // F26: treatments and packs.
  'sessions',
  'intervalWeeks',
  'cancelled',
  'totalSessions',
  'expiresOn',
  'packNoShowSpends',
  // F27: booking page.
  'bookingPageEnabled',
  // F28: agenda links.
  'fullNames',
] as const;

export function safeActivityDetails(...sources: unknown[]): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const field of ACTIVITY_SAFE_FIELDS) {
      const value = (source as Record<string, unknown>)[field];
      if (value === undefined || value === null) continue;
      if (value instanceof Date) details[field] = value.toISOString();
      else if (['string', 'number', 'boolean'].includes(typeof value)) details[field] = value;
    }
  }
  return details;
}
