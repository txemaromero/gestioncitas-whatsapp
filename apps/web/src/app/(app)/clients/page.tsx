import { ClientsView } from '@/components/clients/clients-view';
import { requireAdminSession } from '@/server/session';

export const metadata = { title: 'Clientes' };

/** Owner and administrators only (F18): professionals are sent back to Inicio. */
export default async function ClientsPage() {
  await requireAdminSession();
  return <ClientsView />;
}
