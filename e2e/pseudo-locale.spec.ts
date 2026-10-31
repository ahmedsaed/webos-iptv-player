import {
  test,
  expect,
  enterTab,
  routePlaylist,
  seedPlaylist,
  SEARCH_M3U,
  type Page,
} from './helpers';

// Opened from Home's Live card after every load (see `startOn`).
test.use({ startOn: 'live' });

async function textOverflow(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).evaluateAll((elements) => elements
    .filter((element) => {
      const el = element as HTMLElement;
      const style = getComputedStyle(el);
      return el.getClientRects().length > 0
        && style.visibility !== 'hidden'
        && style.display !== 'none';
    })
    .filter((element) => {
      const el = element as HTMLElement;
      return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
    })
    .map((element) => {
      const el = element as HTMLElement;
      return `${el.className || el.tagName}: ${el.textContent?.trim() ?? ''}`;
    }));
}

test('expands localized channel navigation without clipping', async ({ page }) => {
  await routePlaylist(page, SEARCH_M3U);
  await seedPlaylist(page);
  await page.goto('/?pseudo=1');

  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  await expect(page.locator('.live-header-count')).toContainText('[!!');
  expect(await textOverflow(page, '.live-header-count')).toEqual([]);
  await expect(page.locator('.group-name').first()).toHaveCSS('text-overflow', 'ellipsis');
  await enterTab(page, 'home');
  await expect(page.locator('.home-card[data-section="live"]')).toContainText('[!!');
  expect(await textOverflow(page, '.home-card-label')).toEqual([]);
});

test('keeps pseudo-localized Settings controls within their boxes', async ({ page }) => {
  await routePlaylist(page, SEARCH_M3U);
  await seedPlaylist(page);
  await page.goto('/?pseudo=1');
  await enterTab(page, 'settings');
  await expect(page.locator('#view-settings')).toBeVisible();

  // Each category is its own page, and a hidden one measures nothing.
  for (const category of ['general', 'sources', 'guide', 'appearance', 'playback', 'subtitles', 'advanced', 'data']) {
    await page.locator(`[data-settings-target="${category}"]`).click();
    await expect(page.locator(`#settings-${category}`)).toBeVisible();
    expect(await textOverflow(page, [
      '#view-settings h2',
      '#view-settings h3',
      '#view-settings label',
      '#view-settings .btn',
      '#view-settings .toggle-option',
      '#view-settings .dropdown-trigger',
    ].join(',')), category).toEqual([]);
  }

  await page.locator('[data-settings-target="general"]').click();
  await page.locator('#app-language [data-dropdown-trigger]').click();
  await expect(page.locator('#app-language [data-dropdown-value="en"]')).toBeVisible();
  await expect(page.locator('#app-language [data-dropdown-value="en-XA"]')).toHaveCount(0);
});
