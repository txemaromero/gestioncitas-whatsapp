'use client';

import { AlertTriangleIcon } from 'lucide-react';
import {
  formatEsShort,
  formatHumanDateTime,
  SERIES_MAX_SESSIONS,
  SERIES_MIN_SESSIONS,
  SERIES_SKIP_LABELS_ES,
  SERIES_WEEKDAY_OPTIONS_ES,
  type SeriesInterval,
  type SeriesSkipReason,
} from '@clinicai/shared';
import { Field, Input, NativeSelect } from '@/components/ui/form-controls';
import { cn } from '@/lib/utils';

/** Skipped dates listed one by one; the rest are only counted. */
const SKIPPED_SHOWN = 6;

export interface SeriesPatternValue {
  weekdays: number[];
  intervalWeeks: SeriesInterval;
  sessions: number;
}

export interface SeriesPlanView {
  sessions: Date[];
  skipped: { start: Date; reason: SeriesSkipReason }[];
  complete: boolean;
}

/** F26: the pattern of a treatment (weekdays, frequency, sessions) and, once asked, its dates. */
export function SeriesFields({
  pattern,
  onChange,
  plan,
  timeZone,
}: {
  pattern: SeriesPatternValue;
  onChange: (pattern: SeriesPatternValue) => void;
  plan: SeriesPlanView | null;
  timeZone: string;
}) {
  const toggle = (day: number) =>
    onChange({
      ...pattern,
      weekdays: pattern.weekdays.includes(day) ? pattern.weekdays.filter((d) => d !== day) : [...pattern.weekdays, day],
    });
  // The dates before «now» of the first week are not worth showing.
  const skipped = plan?.skipped.filter((s) => s.reason !== 'past') ?? [];

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <span id="series-weekdays" className="text-sm font-medium">
          Días de la semana
        </span>
        <div role="group" aria-labelledby="series-weekdays" className="flex flex-wrap gap-1.5">
          {SERIES_WEEKDAY_OPTIONS_ES.map((d) => {
            const on = pattern.weekdays.includes(d.value);
            return (
              <button
                key={d.value}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(d.value)}
                className={cn(
                  'grid size-9 place-items-center rounded-md border text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  on ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
                )}
              >
                <span aria-hidden="true">{d.short}</span>
                <span className="sr-only">{d.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Frecuencia" htmlFor="series-interval">
          <NativeSelect
            id="series-interval"
            value={pattern.intervalWeeks}
            onChange={(e) => onChange({ ...pattern, intervalWeeks: Number(e.target.value) === 2 ? 2 : 1 })}
          >
            <option value={1}>Cada semana</option>
            <option value={2}>Cada 2 semanas</option>
          </NativeSelect>
        </Field>
        <Field label="Sesiones" htmlFor="series-sessions" hint={`De ${SERIES_MIN_SESSIONS} a ${SERIES_MAX_SESSIONS}`}>
          <Input
            id="series-sessions"
            type="number"
            min={SERIES_MIN_SESSIONS}
            max={SERIES_MAX_SESSIONS}
            // An emptied field stays empty (NaN, refused on submit): as 0 it turned a typed «4» into «04».
            value={Number.isNaN(pattern.sessions) ? '' : pattern.sessions}
            onChange={(e) => onChange({ ...pattern, sessions: e.target.valueAsNumber })}
          />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">
        Todas a la misma hora, con el mismo profesional y servicio. Si una fecha no está libre, se salta y se añade otra al final.
      </p>

      {plan ? (
        <section aria-label="Fechas del tratamiento" className="grid gap-2 rounded-md bg-muted/50 p-3">
          <p className="text-sm font-medium">
            {plan.sessions.length === 0
              ? 'No hay ninguna fecha libre con este patrón.'
              : plan.complete
                ? `${plan.sessions.length} sesiones:`
                : `Solo hay ${plan.sessions.length} de ${pattern.sessions} sesiones libres en las próximas semanas:`}
          </p>
          {plan.sessions.length > 0 ? (
            <ol aria-label="Sesiones" tabIndex={0} className="grid max-h-40 gap-0.5 overflow-y-auto text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
              {plan.sessions.map((date, i) => (
                <li key={date.toISOString()}>
                  {i + 1}. <span className="first-letter:uppercase">{formatHumanDateTime(date, timeZone)}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {skipped.length > 0 ? (
            <div className="grid gap-1 text-sm text-amber-900">
              <p className="flex items-center gap-2 font-medium">
                <AlertTriangleIcon className="size-4" aria-hidden="true" /> Fechas saltadas
              </p>
              <ul className="grid gap-0.5">
                {skipped.slice(0, SKIPPED_SHOWN).map((s) => (
                  <li key={s.start.toISOString()}>
                    {formatEsShort(s.start, timeZone)}: {SERIES_SKIP_LABELS_ES[s.reason]}
                  </li>
                ))}
                {skipped.length > SKIPPED_SHOWN ? (
                  <li>
                    y {skipped.length - SKIPPED_SHOWN === 1 ? '1 fecha más' : `${skipped.length - SKIPPED_SHOWN} fechas más`}
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
