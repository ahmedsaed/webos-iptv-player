import { test, expect, enterTab, isChromium53, type Page } from './helpers';
import { seedXtream } from './fixtures/xtream';

// Pages the catalog leaves must be freed: every visit rebuilds the rails, a
// detail and a See all grid, and nothing may keep the old ones alive.
const ROUNDS = 6;

const back = (page: Page) => page.evaluate(() =>
  document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));

async function openDetail(page: Page, section: 'movies' | 'series', id: string): Promise<void> {
  await page.locator(`#view-${section} .catalog-layer-browse .catalog-tile[data-item-id="${id}"]`).first()
    .evaluate(el => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator(`#view-${section} .catalog-layer-detail .detail-title`)).toBeVisible();
  await back(page);
  await expect(page.locator(`#view-${section} .catalog-layer-browse`)).toBeVisible();
}

async function openGrid(page: Page): Promise<void> {
  await page.locator('#view-movies .catalog-layer-browse .catalog-see-all[data-category-id="1"]')
    .evaluate(el => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  const grid = page.locator('#view-movies .catalog-layer-grid .catalog-grid-track .catalog-tile');
  await expect(grid.first()).toBeVisible();
  await grid.nth(3).evaluate(el => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await back(page);
  await expect(page.locator('#view-movies .catalog-layer-browse')).toBeVisible();
}

async function round(page: Page): Promise<void> {
  await enterTab(page, 'movies');
  for (const id of ['10', '1001', '1002']) await openDetail(page, 'movies', id);
  await openGrid(page);
  await enterTab(page, 'series');
  await openDetail(page, 'series', '20');
  await enterTab(page, 'home');
}

test('frees the catalog pages it leaves', async ({ page }) => {
  test.skip(isChromium53(), 'reads Blink counters through CDP, which the simulation adds nothing to');
  test.setTimeout(120_000);
  await seedXtream(page, { catalog: 'large' });
  await page.goto('/');
  await expect(page.locator('#view-home')).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const counters = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const value = (name: string) => metrics.find(m => m.name === name)?.value ?? 0;
    return { nodes: value('Nodes'), listeners: value('JSEventListeners') };
  };

  await round(page);
  const baseline = await counters();
  for (let i = 1; i < ROUNDS; i++) await round(page);
  const after = await counters();
  test.info().annotations.push({
    type: 'counters',
    description: `nodes ${baseline.nodes} -> ${after.nodes}, listeners ${baseline.listeners} -> ${after.listeners}`,
  });
  expect(after.nodes).toBeLessThanOrEqual(baseline.nodes * 1.05);
  expect(after.listeners).toBeLessThanOrEqual(baseline.listeners * 1.05);
});
