/**
 * F29: the clinic fills the information for the assistant in Settings and sees the text it uses.
 */
import { expect, expectAccessible, test } from './fixtures';

test('the information for the assistant is filled in Settings and goes into its text', async ({ page }) => {
  await page.goto('/settings');
  const form = page.getByRole('form', { name: 'Información para el asistente' });
  await form.getByLabel('Dirección').fill('C/ Prueba, 1');
  await form.getByLabel('Ciudad').fill('Alicante');
  await form.getByLabel('Formas de pago').fill('Efectivo y tarjeta');
  await form.getByLabel('Información importante').fill('Trae ropa cómoda.');
  await form.getByRole('button', { name: 'Guardar información' }).click();
  await expect(page.getByText('Información del asistente guardada')).toBeVisible();

  await page.getByRole('button', { name: 'Ver el texto del asistente' }).click();
  const text = page.getByLabel('Texto que usa el asistente');
  await expect(text).toHaveValue(/Clínica E2E, una clínica de fisioterapia ubicada en Alicante\./);
  await expect(text).toHaveValue(/Dirección: C\/ Prueba, 1\n/);
  await expect(text).toHaveValue(/- Trae ropa cómoda\.\n/);
  await page.getByText('Avanzado: usar un texto propio (.txt)').click();
  await expectAccessible(page, 'assistant information');
});
