import { MetricsView } from '@/components/metrics/metrics-view';
import { requireAdminSession } from '@/server/session';

export const metadata = { title: 'Métricas' };

/** Owner and administrators only (F18): professionals are sent back to Inicio. */
export default async function MetricsPage() {
  await requireAdminSession();
  return <MetricsView />;
}
