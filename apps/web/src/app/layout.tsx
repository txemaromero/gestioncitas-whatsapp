import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Toaster } from 'sonner';
import { TRPCReactProvider } from '@/trpc/react';
import './globals.css';

// F25: every page is rendered per request (also the 404), so its scripts carry the nonce of the
// Content Security Policy (src/proxy.ts). A prerendered page would have none and be blocked.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { default: 'ClinicAI', template: '%s · ClinicAI' },
  description: 'Citas automáticas por WhatsApp con IA y panel de gestión para clínicas.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#ffffff',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-dvh font-sans">
        <TRPCReactProvider>{children}</TRPCReactProvider>
        <Toaster position="top-right" richColors closeButton />
      </body>
    </html>
  );
}
