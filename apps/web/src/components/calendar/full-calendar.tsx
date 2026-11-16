'use client';

import FullCalendar, { type DateClickInfo, type DatesSetInfo, type EventClickInfo, type EventInput } from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/react/daygrid';
import interactionPlugin from '@fullcalendar/react/interaction';
import esLocale from '@fullcalendar/react/locales/es';
import classicThemePlugin from '@fullcalendar/react/themes/classic';
import timeGridPlugin from '@fullcalendar/react/timegrid';
import '@fullcalendar/react/skeleton.css';
import '@fullcalendar/react/themes/classic/theme.css';
import '@fullcalendar/react/themes/classic/palette.css';

export interface CalendarCanvasProps {
  events: EventInput[];
  onRangeChange: (start: Date, end: Date) => void;
  onDateClick: (date: Date, allDay: boolean) => void;
  onEventClick: (id: string) => void;
}

/** FullCalendar 7 (month by default; week/day views; Spanish locale; week starts on Monday). */
export default function CalendarCanvas({ events, onRangeChange, onDateClick, onEventClick }: CalendarCanvasProps) {
  return (
    <FullCalendar
      plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin, classicThemePlugin]}
      locale={esLocale}
      firstDay={1}
      initialView="dayGridMonth"
      headerToolbar={{ start: 'prev,next today', center: 'title', end: 'dayGridMonth,timeGridWeek,timeGridDay' }}
      // F25: names read by screen readers. The locale's say «Este mes» for the «Hoy» button,
      // «Vista del semana» and «Mes antes».
      todayHint="Hoy"
      prevHint="$0 anterior"
      viewHint={(buttonText: string) => `Ver por ${buttonText.toLocaleLowerCase('es')}`}
      height="auto"
      dayMaxEvents={4}
      nowIndicator
      slotMinTime="07:00:00"
      slotMaxTime="21:00:00"
      // F14: whole-day absences and closures live in the all-day row of the week and day views.
      allDaySlot
      eventDisplay="block"
      events={events}
      eventContent={(info) => <span className="block truncate px-1 text-xs leading-5">{info.event.title}</span>}
      datesSet={(info: DatesSetInfo) => onRangeChange(info.start, info.end)}
      dateClick={(info: DateClickInfo) => onDateClick(info.date, info.allDay)}
      eventClick={(info: EventClickInfo) => {
        info.jsEvent.preventDefault();
        onEventClick(info.event.id);
      }}
    />
  );
}
