import { test, expect, enterTab, type Page, openGuide } from './helpers';
import { seedXtream } from './fixtures/xtream';

// Opened from Home's Live card after every load (see `startOn`).
test.use({ startOn: 'live' });

// TV lists show no scrollbar: focus moving down a list already says it scrolls.

// Headless Chromium hides scrollbars by default, which would hide a regression.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

const LONG_M3U = ['#EXTM3U', ...Array.from({ length: 80 }, (_, i) => [
  `#EXTINF:-1 tvg-id="ch${String(i)}" group-title="Group ${String(i % 30)}",Channel ${String(i)}`,
  `http://host/${String(i)}`,
]).reduce<string[]>((all, pair) => all.concat(pair), [])].join('\n');

async function seedLongXtream(page: Page): Promise<void> {
  await seedXtream(page, { catalog: 'large' });
  // Registered last, so it wins over the fixture's short live playlist.
  await page.route('**/get.php*', (r) => r.fulfill({
    status: 200, contentType: 'application/x-mpegurl', body: LONG_M3U,
  }));
}

// Every box that clips its overflow, and the viewport, must give no width or
// height to a scrollbar. The 2px slack absorbs subpixel border rounding.
async function expectNoScrollbars(page: Page, where: string): Promise<void> {
  const offenders = await page.evaluate(() => {
    const found: string[] = [];
    const root = document.documentElement;
    if (window.innerWidth - root.clientWidth > 0 || window.innerHeight - root.clientHeight > 0) {
      found.push('viewport');
    }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const style = getComputedStyle(el);
      if (style.display === 'inline' || !el.offsetWidth) continue;
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const borderX = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      const borderY = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const vertical = el.offsetWidth - el.clientWidth - borderX;
      const horizontal = el.offsetHeight - el.clientHeight - borderY;
      if (vertical >= 2 || horizontal >= 2) {
        found.push(`${el.tagName.toLowerCase()}.${String(el.className)} (${String(vertical)}x${String(horizontal)})`);
      }
    }
    if (document.querySelector('.channel-scroll-indicator, .channel-scroll-thumb')) {
      found.push('custom scroll thumb');
    }
    return found;
  });
  expect(offenders, `${where} shows no scrollbar`).toEqual([]);
}

// Holding Down walks focus down the list, which scrolls to keep it on screen.
async function expectDownScrolls(page: Page, list: string, presses: number): Promise<void> {
  const scroller = page.locator(list).first();
  await expect(scroller).toBeVisible();
  const before = await scroller.evaluate((el) => el.scrollTop);
  for (let i = 0; i < presses; i++) await page.keyboard.press('ArrowDown');
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop), { message: `${list} scrolls` })
    .toBeGreaterThan(before);
  await expect.poll(() => scroller.evaluate((el) => {
    const focused = el.querySelector('.focused');
    if (!focused) return 'no focused row';
    const box = el.getBoundingClientRect();
    const row = focused.getBoundingClientRect();
    // Mostly in view: the sidebar's reveal leaves its last row a few px low.
    return row.top >= box.top - 1 && row.bottom - row.height / 2 <= box.bottom ? 'visible'
      : `${focused.className} at ${String(row.top)}-${String(row.bottom)} in ${String(box.top)}-${String(box.bottom)}`;
  }), { message: `${list} keeps the focused row on screen` }).toBe('visible');
}

test('live list, groups, and player sidebar scroll without a scrollbar', async ({ page }) => {
  await seedLongXtream(page);
  await page.goto('/');
  await expect(page.locator('.channel-main .channel-item')).not.toHaveCount(0);
  await expect(page.locator('.channel-main .channel-item.focused')).toBeVisible();
  await expectNoScrollbars(page, 'live list');
  await expectDownScrolls(page, '.channel-main', 30);
  await expectNoScrollbars(page, 'scrolled live list');

  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#player-sidebar .sidebar-channel-list')).toBeVisible();
  await expectNoScrollbars(page, 'player sidebar');
  await expectDownScrolls(page, '#player-sidebar .sidebar-channel-list', 30);
  await expectNoScrollbars(page, 'scrolled player sidebar');
});

test('guide scrolls without a scrollbar', async ({ page }) => {
  await seedLongXtream(page);
  await page.goto('/');
  await expect(page.locator('.channel-main .channel-item')).not.toHaveCount(0);
  await openGuide(page);
  await page.keyboard.press('ArrowDown');
  await expectNoScrollbars(page, 'guide');
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowDown');
  await expect(page.locator('#live-guide .guide-cell.focused')).toHaveAttribute('data-row', '31');
  await expectNoScrollbars(page, 'scrolled guide');
});

test('catalog, settings, and search show no scrollbar', async ({ page }) => {
  await seedLongXtream(page);
  await page.goto('/');
  await expect(page.locator('.channel-main .channel-item')).not.toHaveCount(0);

  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies .catalog-rail-track').first()).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expectNoScrollbars(page, 'movies');
  const rails = page.locator('#view-movies .catalog-rails');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');
  await expect.poll(() => rails.evaluate((el) => el.scrollTop), { message: 'movie rails scroll' })
    .toBeGreaterThan(0);
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.locator('#view-movies .catalog-rail-track')
    .evaluateAll((tracks) => Math.max(...tracks.map((el) => el.scrollLeft))), { message: 'a rail scrolls' })
    .toBeGreaterThan(0);
  await expectNoScrollbars(page, 'scrolled movies');

  await enterTab(page, 'settings');
  await expect(page.locator('#view-settings')).toBeVisible();
  await expectNoScrollbars(page, 'settings');

  await enterTab(page, 'search');
  await page.locator('.search-box-input').fill('channel');
  await expect(page.locator('#view-search .search-channel-card').first()).toBeVisible();
  await expectNoScrollbars(page, 'search');
});
