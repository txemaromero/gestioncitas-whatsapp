import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, expectAccessible, test } from './fixtures';

/** Next Monday (Madrid) as `YYYY-MM-DDT10:00` for the datetime-local input. */
function nextMondayAt10(): string {
  const now = new Date();
  const diff = ((8 - now.getDay()) % 7) || 7;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:00`;
}

async function confirmDialog(page: Page, button: string) {
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: button }).click();
}

test('admin manages employees, clients and appointments', async ({ page }) => {
  // Dashboard (session mocked server-side)
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Clínica E2E' })).toBeVisible();
  await expect(page.getByText('Abrir calendario')).toBeVisible();

  // ── Employees: create (Monday 09:00–14:00 default row) and edit ──
  await page.goto('/employees');
  await expect(page.getByRole('heading', { name: 'Gestión de Empleados' })).toBeVisible();
  await page.getByRole('button', { name: 'Nuevo Empleado' }).click();
  const employeeDialog = page.getByRole('dialog');
  await employeeDialog.getByLabel('Nombre').fill('Empleada E2E');
  await employeeDialog.getByRole('button', { name: 'Añadir Día al Horario' }).click();
  await employeeDialog.getByRole('button', { name: 'Guardar Cambios' }).click();
  await expect(page.getByRole('cell', { name: 'Empleada E2E', exact: true })).toBeVisible();
  await expect(page.getByRole('row', { name: /Empleada E2E/ }).getByRole('cell', { name: 'Lunes: 09:00 - 14:00', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Editar Empleada E2E' }).click();
  await page.getByRole('dialog').getByLabel('Rol').selectOption('osteópata');
  await page.getByRole('dialog').getByRole('button', { name: 'Guardar Cambios' }).click();
  await expect(page.getByRole('cell', { name: 'osteópata', exact: true })).toBeVisible();

  // ── Clients: create (phone normalized to E.164) and edit ──
  await page.goto('/clients');
  await expect(page.getByRole('heading', { name: 'Gestión de Clientes' })).toBeVisible();
  await page.getByRole('button', { name: 'Nuevo Cliente' }).click();
  const clientDialog = page.getByRole('dialog');
  await clientDialog.getByLabel('Nombre').fill('Cliente E2E');
  await clientDialog.getByLabel('Email').fill('cliente@e2e.test');
  await clientDialog.getByLabel('Teléfono').fill('699 123 456');
  await clientDialog.getByRole('button', { name: 'Crear Cliente' }).click();
  await expect(page.getByRole('cell', { name: '+34699123456', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Editar Cliente E2E' }).click();
  await page.getByRole('dialog').getByLabel('Notas').fill('Paciente de prueba');
  // F12: privacy notice accepted outside WhatsApp (e.g. signed at the clinic).
  await page.getByRole('dialog').getByLabel(/Ha aceptado la política de privacidad/).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Guardar Cambios' }).click();
  await expect(page.getByText('Cambios guardados')).toBeVisible();

  // F12: the detail shows the acceptance and exports everything as JSON (right of access).
  await page.getByRole('button', { name: 'Cliente E2E', exact: true }).click();
  const detail = page.getByRole('dialog');
  await expect(detail.getByText(/Aviso de privacidad aceptado fuera de WhatsApp/)).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await detail.getByRole('button', { name: 'Exportar datos (JSON)' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^datos-cliente-e2e-\d{4}-\d{2}-\d{2}\.json$/);
  const exported = JSON.parse(readFileSync(await download.path(), 'utf8')) as { client: { name: string; notes: string } };
  expect(exported.client).toMatchObject({ name: 'Cliente E2E', notes: 'Paciente de prueba' });

  // F26: a pack in the client record; its name follows the sessions, also after emptying the field.
  await detail.getByRole('button', { name: 'Nuevo bono' }).click();
  const packDialog = page.getByRole('dialog', { name: 'Nuevo bono' });
  const packSessions = packDialog.getByLabel('Sesiones');
  await packSessions.fill('');
  await packSessions.pressSequentially('5');
  await expect(packDialog.getByLabel('Nombre')).toHaveValue('Bono 5 sesiones');
  await expectAccessible(page, 'pack dialog');
  await packDialog.getByRole('button', { name: 'Crear bono' }).click();
  await expect(page.getByText('Bono creado')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Cliente E2E' }).getByText('0 de 5 sesiones usadas · quedan 5')).toBeVisible();
  await page.keyboard.press('Escape');

  // ── Appointments: create, edit status, delete ──
  await page.goto('/calendar');
  await expect(page.getByRole('heading', { name: 'Calendario' })).toBeVisible();
  await page.getByRole('button', { name: 'Nueva Cita' }).first().click();
  const appointment = page.getByRole('dialog');
  await expect(appointment.getByRole('heading', { name: 'Nueva Cita' })).toBeVisible();
  await appointment.getByRole('combobox', { name: /Cliente/ }).click();
  await page.getByPlaceholder('Buscar cliente…').fill('Cliente E2E');
  await page.getByRole('option', { name: /Cliente E2E/ }).click();
  await appointment.getByLabel('Fecha y hora').fill(nextMondayAt10());
  await appointment.getByLabel('Empleado').selectOption({ label: 'Empleada E2E · disponible' });
  await expect(appointment.getByText(/Disponible el/)).toBeVisible();
  await appointment.getByRole('button', { name: 'Crear Cita' }).click();
  await expect(page.getByText('Cita creada')).toBeVisible();

  const upcoming = page.getByRole('list', { name: 'Próximas citas' });
  const item = upcoming.getByRole('button', { name: /Cliente E2E con Empleada E2E/ });
  await expect(item).toBeVisible();
  await expect(item.getByText('Pendiente')).toBeVisible();

  await item.click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Editar Cita' })).toBeVisible();
  await page.getByRole('dialog').getByLabel('Estado').selectOption('confirmed');
  await page.getByRole('dialog').getByRole('button', { name: 'Actualizar cita' }).click();
  await expect(page.getByText('Cita actualizada')).toBeVisible();
  await expect(item.getByText('Confirmada')).toBeVisible();

  await item.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Eliminar Cita' }).click();
  await confirmDialog(page, 'Eliminar Cita');
  await expect(page.getByText('Cita eliminada')).toBeVisible();
  await expect(item).toHaveCount(0);

  // ── F26: a treatment of 3 Mondays, then cancel from the second one on ──
  await page.getByRole('button', { name: 'Nueva Cita' }).first().click();
  const series = page.getByRole('dialog');
  await series.getByRole('combobox', { name: /Cliente/ }).click();
  await page.getByPlaceholder('Buscar cliente…').fill('Cliente E2E');
  await page.getByRole('option', { name: /Cliente E2E/ }).click();
  await series.getByLabel('Fecha y hora').fill(nextMondayAt10());
  await series.getByLabel('Empleado').selectOption({ label: 'Empleada E2E · disponible' });
  await expect(series.getByText(/Bono «Bono 5 sesiones»: quedan 5 de 5 sesiones/)).toBeVisible();
  await series.getByLabel('Repetir (tratamiento de varias sesiones)').check();
  await expect(series.getByRole('button', { name: 'Lunes' })).toHaveAttribute('aria-pressed', 'true');
  // An emptied field stays empty, so typing «3» gives 3 (not «03»).
  const seriesSessions = series.getByLabel('Sesiones', { exact: true });
  await seriesSessions.fill('');
  await seriesSessions.pressSequentially('3');
  await expect(seriesSessions).toHaveValue('3');
  await series.getByRole('button', { name: 'Ver fechas' }).click();
  await expect(series.getByText('3 sesiones:')).toBeVisible();
  await expectAccessible(page, 'treatment preview');
  await series.getByRole('button', { name: 'Reservar 3 sesiones' }).click();
  await expect(page.getByText('Tratamiento creado: 3 citas')).toBeVisible();

  const sessions = upcoming.getByRole('button', { name: /Cliente E2E con Empleada E2E/ });
  await expect(sessions).toHaveCount(3);
  await sessions.nth(1).click();
  await expect(page.getByRole('dialog').getByText('Sesión 2 de 3 del tratamiento')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancelar esta y las siguientes' }).click();
  await confirmDialog(page, 'Cancelar sesiones');
  await expect(page.getByText('Canceladas 2 citas del tratamiento')).toBeVisible();
  // Cancelled appointments leave «Próximas citas» too, like the calendar (unless «Ver canceladas»).
  await expect(sessions).toHaveCount(1);

  // ── Delete client and employee ──
  await page.goto('/clients');
  await page.getByRole('button', { name: 'Eliminar Cliente E2E' }).click();
  await confirmDialog(page, 'Eliminar');
  await expect(page.getByText('Cliente y todos sus datos eliminados')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Cliente E2E', exact: true })).toHaveCount(0);

  await page.goto('/employees');
  await page.getByRole('button', { name: 'Eliminar Empleada E2E' }).click();
  await confirmDialog(page, 'Eliminar');
  await expect(page.getByText('Empleado eliminado')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Empleada E2E', exact: true })).toHaveCount(0);
});

test('unauthenticated landing shows the value proposition', async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Simplifica la gestión de tu clínica de fisioterapia' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Empezar' })).toBeVisible();
  await page.close();
});
