'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DownloadIcon, EyeIcon, UploadIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { FAQ_PROMPT_MAX_BYTES } from '@clinicai/shared';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/form-controls';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@/components/ui/misc';
import { errorMessage } from '@/lib/utils';
import type { RouterOutputs } from '@/server/routers/_app';
import { useTRPC } from '@/trpc/react';

type AssistantData = RouterOutputs['tenant']['getAssistantInfo'];

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * F29: what the assistant knows about the clinic, as a form (no .txt needed). The FAQ prompt is
 * the optimized template filled with it; a .txt of one's own can still replace it (advanced).
 */
export function AssistantInfoCard() {
  const trpc = useTRPC();
  const data = useQuery(trpc.tenant.getAssistantInfo.queryOptions());
  if (!data.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Información para el asistente</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-64" />
        </CardContent>
      </Card>
    );
  }
  return <AssistantInfoForm initial={data.data} />;
}

function AssistantInfoForm({ initial }: { initial: AssistantData }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const current = useQuery({ ...trpc.tenant.getAssistantInfo.queryOptions(), initialData: initial });
  const faq = useQuery(trpc.tenant.getFaqPrompt.queryOptions());
  const custom = current.data.usesCustomPrompt;
  const [values, setValues] = useState({
    address: initial.info.address,
    city: initial.info.city,
    hours: initial.info.hours,
    payments: initial.info.payments,
    insurers: initial.info.insurers,
    parking: initial.info.parking,
    // The panel's services to start with, so adding the prices is enough.
    services: (initial.info.services.length > 0 ? initial.info.services : initial.suggestedServices).join('\n'),
    notes: initial.info.notes.join('\n'),
  });
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [key]: e.target.value }));
  const [showText, setShowText] = useState(false);
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null);
  const [confirmForm, setConfirmForm] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.tenant.pathKey() });
  };
  const save = useMutation(
    trpc.tenant.updateAssistantInfo.mutationOptions({
      onSuccess: () => {
        toast.success('Información del asistente guardada');
        refresh();
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );
  const upload = useMutation(
    trpc.tenant.uploadFaqPrompt.mutationOptions({
      onSuccess: (_data, variables) => {
        toast.success(variables.content === null ? 'El asistente vuelve a usar el formulario' : 'Texto propio del asistente guardado');
        setPreview(null);
        setConfirmForm(false);
        refresh();
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      if (!file.name.toLowerCase().endsWith('.txt')) return void toast.error('Sube un fichero de texto (.txt)');
      if (file.size > FAQ_PROMPT_MAX_BYTES) return void toast.error('El fichero supera los 20 KB');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (!content.trim()) return void toast.error('El fichero está vacío');
      setPreview({ name: file.name, content });
    } catch {
      toast.error('El fichero no está en UTF-8');
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const download = () => {
    if (!faq.data) return;
    const url = URL.createObjectURL(new Blob([faq.data.content], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'asistente-preguntas-frecuentes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Información para el asistente
          <Badge variant={custom ? 'default' : 'muted'}>{custom ? 'Texto propio' : 'Formulario'}</Badge>
        </CardTitle>
        <CardDescription>
          Con esto el asistente responde las dudas de tus clientes por WhatsApp. Lo que dejes vacío lo contestará con «Consultar por
          teléfono». El nombre, el teléfono y los profesionales salen de lo que ya tienes en el panel.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {custom ? (
          <div className="grid gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <p>Ahora el asistente usa un texto propio subido como .txt: esta información no se usa hasta que vuelvas al formulario.</p>
            <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setConfirmForm(true)}>
              Usar el formulario
            </Button>
          </div>
        ) : null}

        <form
          aria-label="Información para el asistente"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ ...values, services: lines(values.services), notes: lines(values.notes) });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Dirección" htmlFor="ai-address">
              <Input id="ai-address" maxLength={200} value={values.address} onChange={set('address')} placeholder="C/ Mayor, 1" />
            </Field>
            <Field label="Ciudad" htmlFor="ai-city">
              <Input id="ai-city" maxLength={80} value={values.city} onChange={set('city')} placeholder="Alicante" />
            </Field>
          </div>
          <Field label="Horario" htmlFor="ai-hours" hint="Si lo dejas vacío, se calcula con los horarios de los profesionales.">
            <Input id="ai-hours" maxLength={300} value={values.hours} onChange={set('hours')} placeholder="lunes a viernes, de 9:00 a 20:00" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Formas de pago" htmlFor="ai-payments">
              <Input id="ai-payments" maxLength={300} value={values.payments} onChange={set('payments')} placeholder="Efectivo, tarjeta y Bizum" />
            </Field>
            <Field label="Parking" htmlFor="ai-parking">
              <Input id="ai-parking" maxLength={300} value={values.parking} onChange={set('parking')} placeholder="Zona azul en la calle" />
            </Field>
          </div>
          <Field label="Aseguradoras" htmlFor="ai-insurers">
            <Input id="ai-insurers" maxLength={500} value={values.insurers} onChange={set('insurers')} placeholder="Las que atendéis, o vacío" />
          </Field>
          <Field label="Servicios y precios" htmlFor="ai-services" hint="Uno por línea. Por ejemplo: Sesión de fisioterapia (1 h): 40 €">
            <Textarea id="ai-services" rows={5} value={values.services} onChange={set('services')} />
          </Field>
          <Field label="Información importante" htmlFor="ai-notes" hint="Una por línea: urgencias, qué traer, política de cancelación…">
            <Textarea id="ai-notes" rows={3} value={values.notes} onChange={set('notes')} />
          </Field>
          <Button type="submit" className="w-fit" disabled={save.isPending}>
            {save.isPending ? 'Guardando…' : 'Guardar información'}
          </Button>
        </form>

        <div className="grid gap-2 border-t pt-4">
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setShowText((v) => !v)} aria-expanded={showText}>
              <EyeIcon /> {showText ? 'Ocultar el texto del asistente' : 'Ver el texto del asistente'}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={download} disabled={!faq.data}>
              <DownloadIcon /> Descargar
            </Button>
          </div>
          {showText ? (
            <Textarea readOnly rows={12} value={faq.data?.content ?? ''} className="font-mono text-xs" aria-label="Texto que usa el asistente" />
          ) : null}
        </div>

        <details className="grid gap-2 border-t pt-4 text-sm">
          <summary className="cursor-pointer font-medium">Avanzado: usar un texto propio (.txt)</summary>
          <p className="mt-2 text-muted-foreground">
            Sustituye por completo a esta información (máx. 20 KB, UTF-8). Parte del texto que genera el formulario para no perder sus normas.
          </p>
          <input
            ref={fileInput}
            type="file"
            accept=".txt,text/plain"
            className="sr-only"
            aria-label="Fichero .txt del asistente"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          <Button type="button" variant="dark" size="sm" className="mt-2 w-fit" onClick={() => fileInput.current?.click()}>
            <UploadIcon /> Subir .txt
          </Button>
          {preview ? (
            <div className="mt-2 grid gap-2">
              <p className="font-medium">Vista previa: {preview.name}</p>
              <Textarea readOnly rows={10} value={preview.content} className="font-mono text-xs" aria-label="Vista previa del texto propio" />
              <div className="flex gap-2">
                <Button type="button" size="sm" onClick={() => upload.mutate({ content: preview.content })} disabled={upload.isPending}>
                  Guardar texto propio
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setPreview(null)}>
                  Descartar
                </Button>
              </div>
            </div>
          ) : null}
        </details>
      </CardContent>

      <ConfirmDialog
        open={confirmForm}
        onOpenChange={setConfirmForm}
        title="¿Volver a usar el formulario?"
        description="El asistente dejará de usar el texto propio y responderá con la información de este formulario. Descarga antes el texto propio si quieres conservarlo."
        confirmLabel="Usar el formulario"
        destructive={false}
        pending={upload.isPending}
        onConfirm={() => upload.mutate({ content: null })}
      />
    </Card>
  );
}
