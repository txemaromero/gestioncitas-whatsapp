/**
 * F27: the clinic publishes its booking page; anyone opens it and every free time is a link that
 * opens WhatsApp with the request (and its reference) already written.
 */
import { expect, expectAccessible, test } from './fixtures';

test('the clinic publishes its booking page and a free time opens WhatsApp with the request', async ({ page }) => {
  // A professional working on Mondays, so the next 14 days have free times.
  await page.goto('/employees');
  await page.getByRole('button', { name: 'Nuevo Empleado' }).click();
  const employee = page.getByRole('dialog');
  await employee.getByLabel('Nombre').fill('Profesional Web');
  await employee.getByRole('button', { name: 'Añadir Día al Horario' }).click();
  await employee.getByRole('button', { name: 'Guardar Cambios' }).click();
  await expect(page.getByRole('cell', { name: 'Profesional Web', exact: true })).toBeVisible();

  try {
    // Settings → publish the page.
    await page.goto('/settings');
    const form = page.getByRole('form', { name: 'Página de reservas' });
    await expect(form.getByLabel('Dirección')).toHaveValue('clinica-e2e');
    await form.getByLabel('Publicar la página de reservas').check();
    await form.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Página de reservas publicada')).toBeVisible();
    await expect(page.getByRole('link', { name: /\/reservar\/clinica-e2e$/ })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Código QR de la página de reservas' })).toBeVisible();
    await expectAccessible(page, 'settings with the booking page');

    // The public page.
    await page.goto('/reservar/clinica-e2e');
    await expect(page.getByRole('heading', { level: 1, name: 'Clínica E2E' })).toBeVisible();
    // The first day with free times is a Monday (the only day the professional works).
    const slot = page.getByRole('link', { name: /^Pedir cita el lunes, .* a las \d{2}:00 por WhatsApp/ }).first();
    const href = (await slot.getAttribute('href'))!;
    expect(href).toMatch(/^https:\/\/wa\.me\/34965000000\?text=/);
    expect(decodeURIComponent(href.split('?text=')[1]!)).toMatch(/^Hola, quiero pedir cita el lunes, .* a las \d{2}:00 \(ref\. W-\d{6}-\d{2}00-00000000\)\.$/);
    await expect(slot).toHaveAttribute('target', '_blank');
    await expectAccessible(page, 'public booking page');

    // Public, with the same security headers; unknown addresses do not exist.
    const response = await page.request.get('/reservar/clinica-e2e');
    expect(response.headers()['content-security-policy']).toMatch(/'nonce-[^']+' 'strict-dynamic'/);
    expect((await page.request.get('/reservar/no-existe')).status()).toBe(404);
  } finally {
    // Leave the clinic as it was for the other tests (also when something above failed).
    await page.goto('/employees');
    await page.getByRole('button', { name: 'Eliminar Profesional Web' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Eliminar' }).click();
    await expect(page.getByRole('cell', { name: 'Profesional Web', exact: true })).toHaveCount(0);
  }
});
