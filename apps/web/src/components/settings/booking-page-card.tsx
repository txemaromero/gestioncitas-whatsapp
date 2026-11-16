'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CopyIcon, DownloadIcon, ExternalLinkIcon } from 'lucide-react';
import Image from 'next/image';
import { useState } from 'react';
import { toast } from 'sonner';
import { slugify } from '@clinicai/shared';
import { Button, buttonVariants } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/form-controls';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/misc';
import { errorMessage } from '@/lib/utils';
import type { TenantView } from '@/server/routers/tenant';
import { useTRPC } from '@/trpc/react';

const copy = (value: string, done: string) =>
  navigator.clipboard.writeText(value).then(
    () => toast.success(done),
    () => toast.error('No se ha podido copiar: selecciónalo y cópialo a mano'),
  );

/** HTML of a button for the clinic's own website (a plain link, no script nor frame). */
const buttonHtml = (url: string) =>
  `<a href="${url}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#2563eb;color:#ffffff;font-family:sans-serif;font-weight:600;text-decoration:none">Pedir cita</a>`;

/** F27: publish the public booking page, its address, link, QR code and a button for the website. */
export function BookingPageCard({ tenant }: { tenant: TenantView }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(tenant.bookingPageEnabled);
  const [slug, setSlug] = useState(tenant.publicSlug ?? slugify(tenant.clinicName));
  const qr = useQuery({ ...trpc.tenant.bookingPageQr.queryOptions(), enabled: Boolean(tenant.publicSlug) });
  const update = useMutation(
    trpc.tenant.updateBookingPage.mutationOptions({
      onSuccess: (view) => {
        toast.success(view.bookingPageEnabled ? 'Página de reservas publicada' : 'Página de reservas guardada (sin publicar)');
        void queryClient.invalidateQueries({ queryKey: trpc.tenant.pathKey() });
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );
  const live = tenant.bookingPageEnabled && tenant.bookingPageUrl;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Página de reservas
          <Badge variant={live ? 'confirmed' : 'muted'}>{live ? 'Publicada' : 'Sin publicar'}</Badge>
        </CardTitle>
        <CardDescription>
          Una página pública con tus huecos libres. El cliente elige uno y se abre WhatsApp con la cita ya escrita; el asistente la confirma.
          No muestra nombres de profesionales ni de clientes.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!tenant.phoneNormalized ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            Para publicarla, indica antes el número de WhatsApp de la clínica en «WhatsApp».
          </p>
        ) : null}
        <form
          aria-label="Página de reservas"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ enabled, slug });
          }}
        >
          <Field label="Dirección" htmlFor="booking-slug" hint="Letras sin tildes, números y guiones. Por ejemplo: fisio-centro.">
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-sm text-muted-foreground">…/reservar/</span>
              <Input id="booking-slug" value={slug} maxLength={40} onChange={(e) => setSlug(e.target.value.toLowerCase())} />
            </div>
          </Field>
          <label htmlFor="booking-enabled" className="flex items-center gap-2 text-sm font-medium">
            <input
              id="booking-enabled"
              type="checkbox"
              className="size-4 accent-primary"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Publicar la página de reservas
          </label>
          <Button type="submit" className="w-fit" disabled={update.isPending}>
            {update.isPending ? 'Guardando…' : 'Guardar'}
          </Button>
        </form>

        {live && tenant.bookingPageUrl ? (
          <div className="grid gap-4 border-t pt-4">
            <div className="grid gap-2">
              <p className="text-sm font-medium">Enlace</p>
              <div className="flex flex-wrap items-center gap-2">
                <a href={tenant.bookingPageUrl} target="_blank" rel="noopener noreferrer" className="break-all text-sm text-primary underline underline-offset-2">
                  {tenant.bookingPageUrl}
                </a>
                <Button type="button" variant="outline" size="sm" onClick={() => void copy(tenant.bookingPageUrl!, 'Enlace copiado')}>
                  <CopyIcon /> Copiar enlace
                </Button>
              </div>
            </div>
            {qr.data ? (
              <div className="flex flex-wrap items-center gap-4">
                <Image src={qr.data.svg} alt="Código QR de la página de reservas" width={144} height={144} unoptimized className="rounded-md border" />
                <div className="grid gap-2">
                  <p className="text-sm text-muted-foreground">Para el mostrador o la puerta: al escanearlo se abre la página.</p>
                  <div className="flex flex-wrap gap-2">
                    <a href={qr.data.svg} download={`qr-reservas-${tenant.publicSlug}.svg`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                      <DownloadIcon /> QR en SVG
                    </a>
                    <a href={qr.data.png} download={`qr-reservas-${tenant.publicSlug}.png`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                      <DownloadIcon /> QR en PNG
                    </a>
                  </div>
                </div>
              </div>
            ) : null}
            <Field label="Botón para tu web" htmlFor="booking-button-html" hint="Pega este código en tu web: es un enlace, sin scripts ni cookies.">
              <Textarea id="booking-button-html" readOnly rows={3} value={buttonHtml(tenant.bookingPageUrl)} className="font-mono text-xs" />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void copy(buttonHtml(tenant.bookingPageUrl!), 'Código copiado')}>
                <CopyIcon /> Copiar código
              </Button>
              <a href={tenant.bookingPageUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                <ExternalLinkIcon /> Ver la página
              </a>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
