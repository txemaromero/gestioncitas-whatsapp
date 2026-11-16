'use client';

import { PlusIcon, Trash2Icon } from 'lucide-react';
import { WEEKDAYS_MONDAY_FIRST, WEEKDAY_LABELS_ES, type ScheduleSlot } from '@clinicai/shared';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/form-controls';

/** Rows [día ▾] [inicio] – [fin] [🗑] + "Añadir Día al Horario". */
export function ScheduleEditor({
  value,
  onChange,
  errors,
}: {
  value: ScheduleSlot[];
  onChange: (value: ScheduleSlot[]) => void;
  errors: Record<number, string>;
}) {
  const update = (index: number, patch: Partial<ScheduleSlot>) =>
    onChange(value.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)));
  return (
    <div className="grid gap-2">
      {value.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin horario: no aparecerá como disponible en el bot.</p>
      ) : null}
      {value.map((slot, index) => (
        <div key={index} className="grid gap-1">
          <div className="flex items-center gap-2">
            <NativeSelect
              aria-label={`Día de la franja ${index + 1}`}
              className="w-36"
              value={slot.day}
              onChange={(e) => update(index, { day: e.target.value as ScheduleSlot['day'] })}
            >
              {WEEKDAYS_MONDAY_FIRST.map((day) => (
                <option key={day} value={day}>
                  {WEEKDAY_LABELS_ES[day]}
                </option>
              ))}
            </NativeSelect>
            <Input
              aria-label={`Inicio de la franja ${index + 1}`}
              type="time"
              className="w-28"
              value={slot.start}
              onChange={(e) => update(index, { start: e.target.value })}
            />
            <span className="text-muted-foreground">–</span>
            <Input
              aria-label={`Fin de la franja ${index + 1}`}
              type="time"
              className="w-28"
              value={slot.end}
              onChange={(e) => update(index, { end: e.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Quitar la franja ${index + 1}`}
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              <Trash2Icon className="text-destructive" />
            </Button>
          </div>
          {errors[index] ? <p className="text-xs text-destructive">{errors[index]}</p> : null}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => onChange([...value, { day: 'monday', start: '09:00', end: '14:00' }])}
      >
        <PlusIcon /> Añadir Día al Horario
      </Button>
    </div>
  );
}
