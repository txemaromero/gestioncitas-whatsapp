/**
 * F25: security headers and accessibility (WCAG 2.1 A and AA rules of axe) of every page.
 */
import { expect, expectAccessible, test } from './fixtures';

const PAGES = ['/', '/dashboard', '/calendar', '/clients', '/employees', '/settings', '/metrics', '/activity', '/plataforma'];

test('every page has a strict policy and its scripts carry the nonce of the request', async ({ page }) => {
  for (const path of PAGES) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(200);
    const headers = response.headers();
    const csp = headers['content-security-policy'] ?? '';
    expect(csp, path).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'(;|$)/);
    expect(csp, path).toContain("frame-ancestors 'none'");
    expect(headers['x-frame-options'], path).toBe('DENY');
    expect(headers['x-content-type-options'], path).toBe('nosniff');
    expect(headers['referrer-policy'], path).toBe('strict-origin-when-cross-origin');
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
    const scripts = (await response.text()).match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length, path).toBeGreaterThan(0);
    expect(
      scripts.filter((tag) => !tag.includes(`nonce="${nonce}"`)),
      `${path}: scripts without the nonce`,
    ).toEqual([]);
  }
  // A new nonce on every request.
  const first = (await page.request.get('/dashboard')).headers()['content-security-policy'];
  const second = (await page.request.get('/dashboard')).headers()['content-security-policy'];
  expect(second).not.toBe(first);

  // The 404 page too (it would be prerendered without a nonce otherwise).
  const missing = await page.request.get('/no-existe');
  expect(missing.status()).toBe(404);
  const missingNonce = /'nonce-([^']+)'/.exec(missing.headers()['content-security-policy'] ?? '')![1]!;
  const missingScripts = (await missing.text()).match(/<script\b[^>]*>/g) ?? [];
  expect(missingScripts.filter((tag) => !tag.includes(`nonce="${missingNonce}"`))).toEqual([]);
  await page.goto('/no-existe');

  // The scripts ran under the policy: the page is interactive.
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Menú de la cuenta' }).click();
  await expect(page.getByRole('menuitem', { name: 'Registro de actividad' })).toBeVisible();
});

test('the API is not framed or sniffed either', async ({ page }) => {
  const headers = (await page.request.get('/api/health')).headers();
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['strict-transport-security']).toContain('max-age=');
});

for (const path of PAGES) {
  test(`accessibility of ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await expectAccessible(page, path);
  });
}

test('accessibility of the week view, the main dialogs and the account menu', async ({ page }) => {
  await page.goto('/calendar');
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: 'Ver por semana' }).click();
  await expect(page.getByRole('tab', { name: 'Ver por semana' })).toHaveAttribute('aria-selected', 'true');
  await expectAccessible(page, 'calendar (week)');
  await page.getByRole('button', { name: 'Nueva Cita' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectAccessible(page, 'new appointment dialog');
  // F26: the fields of a treatment.
  await page.getByRole('dialog').getByLabel('Repetir (tratamiento de varias sesiones)').check();
  await expect(page.getByRole('group', { name: 'Días de la semana' })).toBeVisible();
  await expectAccessible(page, 'treatment fields');

  for (const [path, button] of [
    ['/clients', 'Nuevo Cliente'],
    ['/clients', 'Importar CSV'],
    ['/employees', 'Nuevo Empleado'],
  ] as const) {
    await page.goto(path);
    await page.getByRole('button', { name: button }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectAccessible(page, `${path}: ${button}`);
  }

  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Menú de la cuenta' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expectAccessible(page, 'account menu');
});
