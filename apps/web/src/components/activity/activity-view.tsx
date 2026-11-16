'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ACTIVITY_ACTOR_LABELS_ES,
  ACTIVITY_CATEGORIES,
  ATTENDANCE_LABELS_ES,
  formatEsShort,
  type ActivityCategory,
  type AttendanceValue,
} from '@clinicai/shared';
import { useTenant } from '@/components/layout/tenant-context';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/form-controls';
import {
  Badge,
  Card,
  CardContent,
  PageHeader,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui/misc';
import { useTRPC } from '@/trpc/react';

const STATUS_ES: Record<string, string> = {
  pending: 'pendiente',
  confirmed: 'confirmada',
  cancelled: 'cancelada',
};
const ROLE_ES: Record<string, string> = { admin: 'administrador', professional: 'profesional' };

/** F24: who did what. The log only keeps ids and safe details; names are the current ones. */
export function ActivityView() {
  const trpc = useTRPC();
  const tenant = useTenant();
  const [category, setCategory] = useState<ActivityCategory | ''>('');
  const query = useInfiniteQuery(
    trpc.activity.list.infiniteQueryOptions(
      { category: category || null },
      { getNextPageParam: (last) => last.nextCursor ?? undefined },
    ),
  );
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  const about = (item: (typeof items)[number]) => {
    const parts: string[] = [];
    if (item.clientName) parts.push(item.clientName);
    else if ((item.action.startsWith('clients.') && item.action !== 'clients.import') || item.action.startsWith('packs.'))
      parts.push('Cliente borrado o anonimizado');
    const d = item.details;
    if (typeof d.start === 'string') parts.push(formatEsShort(new Date(d.start), tenant.timezone));
    if (item.employeeName) parts.push(`con ${item.employeeName}`);
    if (typeof d.status === 'string') parts.push(STATUS_ES[d.status] ?? d.status);
    if (typeof d.attendance === 'string')
      parts.push(ATTENDANCE_LABELS_ES[d.attendance as AttendanceValue] ?? d.attendance);
    if (typeof d.role === 'string') parts.push(ROLE_ES[d.role] ?? d.role);
    if (typeof d.imported === 'number') parts.push(`${d.imported} importados`);
    if (typeof d.day === 'string') parts.push(`día ${d.day.split('-').reverse().join('/')}`);
    // F26: treatments and packs.
    if (typeof d.sessions === 'number') parts.push(`${d.sessions} sesiones${d.intervalWeeks === 2 ? ', cada 2 semanas' : ''}`);
    if (typeof d.cancelled === 'number') parts.push(d.cancelled === 1 ? '1 cancelada' : `${d.cancelled} canceladas`);
    if (typeof d.totalSessions === 'number') parts.push(`bono de ${d.totalSessions} sesiones`);
    return parts.join(' · ');
  };

  return (
    <>
      <PageHeader
        title="Registro de actividad"
        description="Quién ha hecho qué en el panel y por WhatsApp. Se guarda 2 años, sin nombres, teléfonos ni notas."
        actions={
          <NativeSelect
            aria-label="Filtrar por tipo"
            value={category}
            onChange={(e) => setCategory(e.target.value as ActivityCategory | '')}
          >
            <option value="">Todo</option>
            {(Object.keys(ACTIVITY_CATEGORIES) as ActivityCategory[]).map((key) => (
              <option key={key} value={key}>
                {ACTIVITY_CATEGORIES[key].label}
              </option>
            ))}
          </NativeSelect>
        }
      />
      <Card>
        <CardContent className="p-0">
          {query.isLoading ? (
            <Skeleton className="m-4 h-40" />
          ) : items.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">Todavía no hay actividad.</p>
          ) : (
            <>
              {/* Phones: one block per entry, so «Sobre» is not pushed off-screen. */}
              <ul aria-label="Actividad" className="divide-y md:hidden">
                {items.map((item) => {
                  const detail = about(item);
                  return (
                    <li key={item.id} className="space-y-1 p-4">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="tabular-nums">
                          {formatEsShort(item.at, tenant.timezone)}
                        </span>
                        <Badge variant={item.actorType === 'member' ? 'outline' : 'muted'}>
                          {ACTIVITY_ACTOR_LABELS_ES[item.actorType]}
                        </Badge>
                        {item.actorType === 'member' ? (
                          <span className="break-all">{item.actorLabel}</span>
                        ) : null}
                      </div>
                      <p className="text-sm font-medium">{item.label}</p>
                      {detail ? <p className="text-sm text-muted-foreground">{detail}</p> : null}
                    </li>
                  );
                })}
              </ul>
              <div className="hidden overflow-x-auto md:block">
                <Table aria-label="Registro de actividad">
                  <THead>
                    <TR>
                      <TH>Fecha</TH>
                      <TH>Quién</TH>
                      <TH>Qué</TH>
                      <TH>Sobre</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {items.map((item) => (
                      <TR key={item.id}>
                        <TD className="whitespace-nowrap tabular-nums">
                          {formatEsShort(item.at, tenant.timezone)}
                        </TD>
                        <TD>
                          <span className="flex flex-wrap items-center gap-2">
                            <Badge variant={item.actorType === 'member' ? 'outline' : 'muted'}>
                              {ACTIVITY_ACTOR_LABELS_ES[item.actorType]}
                            </Badge>
                            {item.actorType === 'member' ? (
                              <span className="text-sm">{item.actorLabel}</span>
                            ) : null}
                          </span>
                        </TD>
                        <TD>{item.label}</TD>
                        <TD className="text-sm text-muted-foreground">{about(item)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      {query.hasNextPage ? (
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {query.isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
        </Button>
      ) : null}
    </>
  );
}
