import { EmployeesView } from '@/components/employees/employees-view';
import { requireAdminSession } from '@/server/session';

export const metadata = { title: 'Empleados' };

/** Owner and administrators only (F18): professionals are sent back to Inicio. */
export default async function EmployeesPage() {
  await requireAdminSession();
  return <EmployeesView />;
}
