/**
 * Spec-19 item 9 — sql-injection-risk false positive.
 * Template literal passed to `page.evaluate()` — it's a CSS selector, not SQL.
 * The violation should NOT fire: `evaluate` on a Playwright `page` object is not a DB call.
 */

import { Page } from 'playwright';

async function checkElementVisible(page: Page, selector: string): Promise<boolean> {
  // CSS selector interpolation in page.evaluate — not SQL
  const visible = await page.evaluate(
    (sel) => document.querySelector(sel) !== null,
    selector
  );

  // Another template — also CSS
  const count = await page.evaluate(
    `document.querySelectorAll('${selector}').length`
  );

  return visible && count > 0;
}

export { checkElementVisible };
