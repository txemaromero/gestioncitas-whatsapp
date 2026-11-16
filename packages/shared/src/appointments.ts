export const APPOINTMENT_STATUSES = ['pending', 'confirmed', 'cancelled'] as const;
export type AppointmentStatusValue = (typeof APPOINTMENT_STATUSES)[number];

export const APPOINTMENT_STATUS_LABELS_ES: Record<AppointmentStatusValue, string> = {
  pending: 'Pendiente',
  confirmed: 'Confirmada',
  cancelled: 'Cancelada',
};

/** Attendance of a past appointment (F15); null = not marked yet. */
export const ATTENDANCE_VALUES = ['attended', 'no_show'] as const;
export type AttendanceValue = (typeof ATTENDANCE_VALUES)[number];

export const ATTENDANCE_LABELS_ES: Record<AttendanceValue, string> = {
  attended: 'Asistió',
  no_show: 'No se presentó',
};

export const APPOINTMENT_SOURCES = ['whatsapp', 'web'] as const;
export type AppointmentSourceValue = (typeof APPOINTMENT_SOURCES)[number];

/** Suggested roles for the employee form (free text is also accepted). */
export const EMPLOYEE_ROLES = [
  'fisioterapeuta',
  'osteópata',
  'fisioterapeuta y osteópata',
  'recepcionista',
  'admin',
] as const;
