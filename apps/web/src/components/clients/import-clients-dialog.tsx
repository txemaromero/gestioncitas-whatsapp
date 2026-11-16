'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileUpIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { CLIENT_IMPORT_MAX_ROWS, decodeCsvBytes } from '@clinicai/shared';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { errorMessage } from '@/lib/utils';
import type { RouterOutputs } from '@/server/routers/_app';
import { useTRPC } from '@/trpc/react';

type Preview = RouterOutputs['clients']['importPreview'];
const FIELD_LABELS = { name: 'Nombre', surname: 'Apellidos', phone: 'Teléfono', email: 'Email', notes: 'Notas' } as const;

/**
 * F23: imports existing clients from a CSV (Excel in Spain: `;` and Windows-1252, or `,` and
 * UTF-8). First a preview of what will be created and what will be skipped; nothing is saved until
 * the user confirms, and the server checks everything again.
 */
export function ImportClientsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // Remounting the file input (new key) clears it.
  const [inputKey, setInputKey] = useState(0);
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [consent, setConsent] = useState(false);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setConsent(false);
    setInputKey((k) => k + 1);
  };
  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const check = useMutation(
    trpc.clients.importPreview.mutationOptions({
      onSuccess: setPreview,
      onError: (e) => {
        setPreview(null);
        toast.error(errorMessage(e));
      },
    }),
  );
  const run = useMutation(
    trpc.clients.import.mutationOptions({
      onSuccess: (result) => {
        toast.success(
          `${result.imported} ${result.imported === 1 ? 'cliente importado' : 'clientes importados'}` +
            (result.skippedCount ? ` · ${result.skippedCount} filas no se han importado` : ''),
        );
        void queryClient.invalidateQueries({ queryKey: trpc.clients.pathKey() });
        close(false);
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  );

  const choose = async (picked: File | undefined) => {
    setPreview(null);
    if (!picked) return setFile(null);
    const csv = decodeCsvBytes(new Uint8Array(await picked.arrayBuffer()));
    setFile({ name: picked.name, csv });
    check.mutate({ csv });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Importar clientes</DialogTitle>
          <DialogDescription>
            Sube un CSV exportado de Excel o de tu programa anterior, con una fila por cliente y una columna «Nombre». También
            se reconocen «Apellidos», «Teléfono» o «Móvil», «Email» y «Notas». Máximo {CLIENT_IMPORT_MAX_ROWS.toLocaleString('es-ES')}{' '}
            filas.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <input
            key={inputKey}
            id="import-file"
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => void choose(e.target.files?.[0])}
          />
          <label htmlFor="import-file" className={buttonVariants({ variant: 'outline', className: 'w-fit cursor-pointer' })}>
            <FileUpIcon /> {file ? 'Elegir otro fichero' : 'Elegir fichero .csv'}
          </label>
          {file ? <p className="text-sm text-muted-foreground">{check.isPending ? `Revisando ${file.name}…` : file.name}</p> : null}

          {preview ? (
            <div className="grid gap-3 text-sm" aria-label="Vista previa de la importación">
              <p>
                <strong>{preview.toImport}</strong> de {preview.total} {preview.total === 1 ? 'cliente se importará' : 'clientes se importarán'}
                {preview.skippedCount ? (
                  <>
                    {' '}
                    · <strong>{preview.skippedCount}</strong> no
                  </>
                ) : null}
                .
              </p>
              <p className="text-xs text-muted-foreground">
                Columnas: {Object.entries(preview.columns)
                  .map(([field, headers]) => `${FIELD_LABELS[field as keyof typeof FIELD_LABELS]} ← ${headers.join(', ')}`)
                  .join(' · ')}
                {preview.ignoredColumns.length ? ` · Se ignoran: ${preview.ignoredColumns.join(', ')}` : ''}
              </p>
              {preview.sample.length ? (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="px-2 py-1.5 font-medium">Fila</th>
                        <th className="px-2 py-1.5 font-medium">Nombre</th>
                        <th className="px-2 py-1.5 font-medium">Teléfono</th>
                        <th className="px-2 py-1.5 font-medium">Email</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sample.map((r) => (
                        <tr key={r.row} className="border-t">
                          <td className="px-2 py-1.5 tabular-nums">{r.row}</td>
                          <td className="px-2 py-1.5">{r.name}</td>
                          <td className="px-2 py-1.5 tabular-nums">{r.phone ?? '—'}</td>
                          <td className="px-2 py-1.5">{r.email ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {preview.skipped.length ? (
                <details className="rounded-md border px-3 py-2">
                  <summary className="cursor-pointer font-medium">Filas que no se importarán ({preview.skippedCount})</summary>
                  <ul className="mt-2 grid max-h-48 gap-1 overflow-y-auto text-xs">
                    {preview.skipped.map((s) => (
                      <li key={s.row}>
                        Fila {s.row}
                        {s.name ? ` (${s.name})` : ''}: {s.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <label htmlFor="import-consent" className="flex items-start gap-2 font-medium">
                <input
                  id="import-consent"
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                Estos clientes ya aceptaron la política de privacidad (p. ej. firmada en la clínica)
              </label>
              <p className="text-xs text-muted-foreground">
                Si no lo marcas, el bot les mostrará el aviso de privacidad en su primer mensaje de WhatsApp y no tratará nada más
                hasta que lo acepten.
              </p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancelar
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={!file || !preview || preview.toImport === 0 || run.isPending}
            onClick={() => file && run.mutate({ csv: file.csv, consent })}
          >
            {run.isPending ? 'Importando…' : preview ? `Importar ${preview.toImport} ${preview.toImport === 1 ? 'cliente' : 'clientes'}` : 'Importar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
