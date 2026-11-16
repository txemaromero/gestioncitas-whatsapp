'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, UndoIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { AttendanceValue } from '@clinicai/shared';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/utils';
import { useTRPC } from '@/trpc/react';

/**
 * F15: marks whether the client came to a past appointment. `label` names the appointment for
 * screen readers (e.g. "Laura con Ana, lunes 10:00").
 */
export function AttendanceButtons({
  appointmentId,
  attendance,
  label,
  size = 'sm',
  onChanged,
}: {
  appointmentId: string;
  attendance: AttendanceValue | null;
  label: string;
  size?: 'sm' | 'default';
  /** Called with the new value once saved. */
  onChanged?: (value: AttendanceValue | null) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const mark = useMutation(
    trpc.appointments.setAttendance.mutationOptions({
      onSuccess: (result) => {
        onChanged?.(result.attendance);
        // F26: the session spent from the client's pack, if any.
        if (result.pack) {
          const { name, remaining } = result.pack;
          toast.success(`Sesión descontada del bono «${name}»: ${remaining === 1 ? 'queda 1' : `quedan ${remaining}`}.`);
        }
        void queryClient.invalidateQueries({ queryKey: trpc.appointments.pathKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.metrics.pathKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.clients.pathKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.packs.pathKey() });
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );
  const set = (value: AttendanceValue | null) => mark.mutate({ id: appointmentId, attendance: value });

  if (attendance) {
    return (
      <Button type="button" variant="ghost" size={size} disabled={mark.isPending} onClick={() => set(null)} aria-label={`Desmarcar asistencia: ${label}`}>
        <UndoIcon /> Desmarcar
      </Button>
    );
  }
  return (
    <span className="flex flex-wrap gap-2" role="group" aria-label={`Asistencia: ${label}`}>
      <Button type="button" variant="outline" size={size} disabled={mark.isPending} onClick={() => set('attended')}>
        <CheckIcon className="text-emerald-600" /> Asistió
      </Button>
      <Button type="button" variant="outline" size={size} disabled={mark.isPending} onClick={() => set('no_show')}>
        <XIcon className="text-red-600" /> No se presentó
      </Button>
    </span>
  );
}
