'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DownloadIcon, MailIcon, PhoneIcon, ShieldCheckIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { formatHumanDateTime } from '@clinicai/shared';
import { useTenant } from '@/components/layout/tenant-context';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AttendanceBadge, Skeleton, StatusBadge } from '@/components/ui/misc';
import { errorMessage } from '@/lib/utils';
import { useTRPC } from '@/trpc/react';
import { ClientPacks } from './client-packs';

const CHANNEL_LABEL = { whatsapp: 'por WhatsApp', web: 'fuera de WhatsApp (marcado en el panel)' } as const;

function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Side drawer with the client data and their past and future appointments. */
export function ClientDetail({ clientId, onOpenChange }: { clientId: string | null; onOpenChange: (open: boolean) => void }) {
  const trpc = useTRPC();
  const tenant = useTenant();
  const queryClient = useQueryClient();
  const [exporting, setExporting] = useState(false);
  const detail = useQuery({
    ...trpc.clients.get.queryOptions({ id: clientId ?? '00000000-0000-4000-8000-000000000000' }),
    enabled: clientId !== null,
  });
  // Reference time = when the data was fetched (pure value, no Date.now() during render).
  const now = detail.dataUpdatedAt;
  const appointments = detail.data?.appointments ?? [];
  const future = appointments.filter((a) => a.date.getTime() >= now).reverse();
  const past = appointments.filter((a) => a.date.getTime() < now);

  /** Right of access / portability: downloads everything stored about the client as JSON. */
  const exportData = async () => {
    if (!clientId || !detail.data) return;
    setExporting(true);
    try {
      const data = await queryClient.fetchQuery({ ...trpc.clients.export.queryOptions({ id: clientId }), staleTime: 0 });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `datos-${slug(detail.data.name) || 'cliente'}-${data.exportedAt.slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  const renderList = (items: typeof appointments, empty: string) =>
    items.length === 0 ? (
      <p className="text-sm text-muted-foreground">{empty}</p>
    ) : (
      <ul className="grid gap-2">
        {items.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{formatHumanDateTime(a.date, tenant.timezone)}</span>
              <span className="block text-xs text-muted-foreground">con {a.employee.name}</span>
            </span>
            {a.attendance ? <AttendanceBadge attendance={a.attendance} /> : <StatusBadge status={a.status} />}
          </li>
        ))}
      </ul>
    );

  return (
    <Dialog open={clientId !== null} onOpenChange={onOpenChange}>
      <DialogContent side="right">
        <DialogHeader>
          <DialogTitle>{detail.data?.name ?? 'Cliente'}</DialogTitle>
          <DialogDescription>Ficha del cliente e historial de citas.</DialogDescription>
        </DialogHeader>
        {detail.isLoading ? (
          <Skeleton className="h-40" />
        ) : detail.data ? (
          <div className="grid gap-6">
            <div className="grid gap-1 text-sm">
              <p className="flex items-center gap-2">
                <PhoneIcon className="size-4 text-muted-foreground" /> {detail.data.phone ?? '-'}
              </p>
              <p className="flex items-center gap-2">
                <MailIcon className="size-4 text-muted-foreground" /> {detail.data.email ?? '-'}
              </p>
              {detail.data.notes ? <p className="mt-2 rounded-md bg-muted p-3 text-muted-foreground">{detail.data.notes}</p> : null}
            </div>
            <section className="grid gap-2" aria-label="Protección de datos">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <ShieldCheckIcon className="size-4 text-muted-foreground" /> Protección de datos
              </h3>
              <p className="text-sm text-muted-foreground">
                {detail.data.anonymizedAt
                  ? `Datos personales anonimizados el ${formatHumanDateTime(detail.data.anonymizedAt, tenant.timezone)} por la política de conservación.`
                  : detail.data.consentAt
                    ? `Aviso de privacidad aceptado ${CHANNEL_LABEL[detail.data.consentChannel ?? 'web']} el ${formatHumanDateTime(detail.data.consentAt, tenant.timezone)}.`
                    : 'Aviso de privacidad pendiente: el bot se lo pedirá en su próximo mensaje de WhatsApp.'}
              </p>
              <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => void exportData()} disabled={exporting}>
                <DownloadIcon className="size-4" /> {exporting ? 'Exportando…' : 'Exportar datos (JSON)'}
              </Button>
            </section>
            {clientId ? <ClientPacks clientId={clientId} /> : null}
            <section className="grid gap-2">
              <h3 className="text-sm font-semibold">Próximas citas</h3>
              {renderList(future, 'Sin citas futuras.')}
            </section>
            <section className="grid gap-2">
              <h3 className="text-sm font-semibold">Citas pasadas</h3>
              {renderList(past, 'Sin citas pasadas.')}
            </section>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
