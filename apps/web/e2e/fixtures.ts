/**
 * F25: every e2e test fails if the browser reports a Content Security Policy violation (blocked
 * or, with CSP_REPORT_ONLY, reported), so the policy is checked on everything the tests click.
 */
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page } from '@playwright/test';

export const test = base.extend<{ cspGuard: void }>({
  cspGuard: [
    async ({ page }, use) => {
      const violations: string[] = [];
      page.on('console', (message) => {
        if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
      });
      // Also the violations the browser does not log (injected by the test runner, outside the policy).
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => {
          console.error(`Content Security Policy violation: ${event.effectiveDirective} ${event.blockedURI}`);
        });
      });
      await use();
      expect(violations, 'Content Security Policy violations').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/**
 * axe measures colours as they are on screen, so a toast or dialog still fading in fails the contrast
 * rule. Waits two frames (so pending enter transitions start) and then for every finite animation.
 */
async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
  });
}

/** F25: no violation of the WCAG 2.1 A and AA rules of axe in what the page shows now. */
export async function expectAccessible(page: Page, label: string): Promise<void> {
  await settleAnimations(page);
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(
    violations.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`),
    label,
  ).toEqual([]);
}
