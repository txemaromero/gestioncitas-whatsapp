/**
 * F28: from the calendar, a link to subscribe to a professional's agenda (iCalendar); revoking it
 * makes the address stop working.
 */
import { expect, expectAccessible, test } from './fixtures';

test('an administrator creates the agenda link of a professional, which serves the agenda until revoked', async ({ page }) => {
  await page.goto('/employees');
  await page.getByRole('button', { name: 'Nuevo Empleado' }).click();
  const employee = page.getByRole('dialog');
  await employee.getByLabel('Nombre').fill('Profesional Agenda');
  await employee.getByRole('button', { name: 'Añadir Día al Horario' }).click();
  await employee.getByRole('button', { name: 'Guardar Cambios' }).click();
  await expect(page.getByRole('cell', { name: 'Profesional Agenda', exact: true })).toBeVisible();

  try {
    await page.goto('/calendar');
    await page.getByRole('button', { name: 'Ver en el móvil' }).click();
    const dialog = page.getByRole('dialog', { name: 'Ver la agenda en el móvil' });
    await dialog.getByLabel('Profesional').selectOption({ label: 'Profesional Agenda' });
    await dialog.getByRole('button', { name: 'Crear enlace' }).click();
    const url = dialog.getByLabel('Enlace');
    await expect(url).toHaveValue(/\/api\/calendar\/[A-Za-z0-9_-]{43}\.ics$/);
    await expect(dialog.getByRole('link', { name: 'Añadir a Apple Calendar' })).toHaveAttribute('href', /^webcal:\/\//);
    await expectAccessible(page, 'agenda link dialog');

    const address = await url.inputValue();
    const feed = await page.request.get(address);
    expect(feed.status()).toBe(200);
    expect(feed.headers()['content-type']).toBe('text/calendar; charset=utf-8');
    expect(await feed.text()).toContain('X-WR-CALNAME:Profesional Agenda · Clínica E2E');

    await dialog.getByRole('button', { name: 'Revocar enlace' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revocar enlace' }).click();
    await expect(page.getByText('Enlace revocado')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Crear enlace' })).toBeVisible();
    expect((await page.request.get(address)).status()).toBe(404);
  } finally {
    await page.goto('/employees');
    await page.getByRole('button', { name: 'Eliminar Profesional Agenda' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Eliminar' }).click();
    await expect(page.getByRole('cell', { name: 'Profesional Agenda', exact: true })).toHaveCount(0);
  }
});
