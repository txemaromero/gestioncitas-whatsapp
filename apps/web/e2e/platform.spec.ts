/**
 * F31: the platform console, from the account menu of a platform administrator (PLATFORM_ADMIN_EMAILS
 * has the e2e user). Who else gets a 404 is covered by the unit tests.
 */
import { expect, expectAccessible, test } from './fixtures';

test('a platform administrator opens the console from the account menu and moves between months', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Menú de la cuenta' }).click();
  await page.getByRole('menuitem', { name: 'Consola de la plataforma' }).click();

  await expect(page).toHaveURL(/\/plataforma$/);
  await expect(page.getByRole('heading', { name: 'Consola de la plataforma' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Clínicas' }).getByText('Clínica E2E', { exact: true })).toBeVisible();
  await expect(page.getByText('Coste estimado de IA')).toBeVisible();
  await expectAccessible(page, 'platform console');

  const months = page.getByRole('navigation', { name: 'Mes' });
  await months.getByRole('link').first().click();
  await expect(page).toHaveURL(/\/plataforma\?mes=\d{4}-\d{2}$/);
  // A past month can go forward again; the current one cannot.
  await expect(months.getByRole('link')).toHaveCount(2);
  await months.getByRole('link').last().click();
  await expect(months.getByRole('link')).toHaveCount(1);
});
