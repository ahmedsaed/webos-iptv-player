import { test, expect, enterTab, openGuide, routePlaylist, type Page } from './helpers';
import { seedXtream } from './fixtures/xtream';

// Every page without artwork or video sits on Pleione's shared backdrop:
// one layer on the view itself, with the section's tint, and nothing in the
// page painting over it.

type Section = 'home' | 'live' | 'epg' | 'movies' | 'series' | 'search' | 'settings';

async function expectBackdrop(page: Page, view: string, section: Section, clear: string[]): Promise<void> {
  const viewEl = page.locator(view);
  await expect(viewEl).toBeVisible();
  await expect(viewEl).toHaveAttribute('data-backdrop', section);
  // Strings, since the launch splash is checked before app.js brings the
  // polyfills the simulation needs to return an object.
  const paint = JSON.parse(await viewEl.evaluate((el, name) => {
    const root = getComputedStyle(document.documentElement);
    const token = (prop: string) => root.getPropertyValue(prop).trim();
    return JSON.stringify({
      image: getComputedStyle(el).backgroundImage,
      glow: token('--backdrop-glow'),
      tint: name === 'home' ? '' : token(`--backdrop-tint-${name}`),
    });
  }, section)) as { image: string; glow: string; tint: string };
  expect(paint.glow).not.toBe('');
  expect(paint.image).toContain(paint.glow);
  // Search centers the glow behind its query box; every other page keeps it top left.
  expect(paint.image).toContain(section === 'search'
    ? `radial-gradient(1100px 600px at 50% -10%, ${paint.glow}`
    : `radial-gradient(1200px 700px at 15% 10%, ${paint.glow}`);
  if (section !== 'home') {
    expect(paint.tint).not.toBe('');
    expect(paint.image).toContain(paint.tint);
  }
  for (const selector of clear) {
    const target = page.locator(`${view} ${selector}`).first();
    await expect(target).toBeVisible();
    const fill = JSON.parse(await target.evaluate((el) => {
      const cs = getComputedStyle(el);
      return JSON.stringify({ color: cs.backgroundColor, image: cs.backgroundImage });
    })) as { color: string; image: string };
    expect(fill, `${selector} paints over the backdrop`).toEqual({ color: 'rgba(0, 0, 0, 0)', image: 'none' });
  }
}

async function seedResume(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (localStorage.getItem('backdrop_fixture')) return;
    localStorage.setItem('backdrop_fixture', '1');
    const resume: Record<string, unknown> = {};
    for (const kind of ['vod', 'episode']) {
      for (let i = 0; i < 3; i++) {
        resume[`x1|${kind}|${kind}${i}`] = {
          accountId: 'x1', kind, itemId: `${kind}${i}`, name: `Title ${i}`, poster: '', ext: 'mp4',
          categoryId: '1', position: 100, duration: 600, updatedAt: 10 - i,
        };
      }
    }
    localStorage.setItem('iptv_resume', JSON.stringify(resume));
  });
}

test('Home, Search, Live, and the Guide sit on the shared backdrop', async ({ page }) => {
  await seedXtream(page);
  await page.goto('/');
  await expectBackdrop(page, '#view-home', 'home', ['.home-view']);

  await enterTab(page, 'search');
  await expectBackdrop(page, '#view-search', 'search', ['.search-layout']);

  // Live's list in the Live card's tint, and its Guide in the Guide card's.
  await enterTab(page, 'live');
  await expect(page.locator('#channel-browser .channel-item').first()).toBeVisible();
  await expectBackdrop(page, '#view-channels', 'live', ['.channel-view', '.sidebar', '.channel-main']);
  await openGuide(page);
  await expectBackdrop(page, '#view-channels', 'epg', ['#live-guide', '.guide', '.guide-body']);
});

test('the launch splash sits on Home\'s backdrop, and later loads drop it', async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await routePlaylist(page);
  // The splash shows until the app boots onto Home.
  await page.route('**/js/app.js', async (route) => {
    await held;
    await route.fallback();
  });
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ name: 'Test', url: 'http://host/playlist.m3u' }]));
  });
  await page.goto('/', { waitUntil: 'commit' });
  await expectBackdrop(page, '#view-loading', 'home', ['.loading-container']);
  release();
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(page.locator('#view-loading')).not.toHaveAttribute('data-backdrop', /./);
});

test('Settings, every Settings page, Reminders, and Parental controls sit on the shared backdrop', async ({ page }) => {
  await seedXtream(page);
  await page.goto('/');
  await enterTab(page, 'settings');
  const categories = await page.locator('.settings-nav-item').evaluateAll(
    (items) => items.map((item) => (item as HTMLElement).dataset.settingsTarget!));
  expect(categories.length).toBeGreaterThan(1);
  for (const category of categories) {
    await page.locator(`[data-settings-target="${category}"]`).click();
    await expectBackdrop(page, '#view-settings', 'settings',
      ['.settings-view', `#settings-${category}`, '.settings-actions']);
  }

  await page.locator('[data-settings-target="guide"]').click();
  await page.locator('#manage-reminders').click();
  await expectBackdrop(page, '#view-reminders', 'settings', ['.reminder-manager-view']);
  await page.locator('.reminder-manager-back').click();

  await page.locator('[data-settings-target="general"]').click();
  await page.locator('#manage-parental-controls').click();
  const prompt = page.locator('.parental-pin-prompt');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(prompt.locator('h2')).toContainText('Confirm');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expectBackdrop(page, '#view-parental-controls', 'settings', ['.parental-view']);
});

test('Movies grids, Continue Watching, and the space around artwork sit on the shared backdrop', async ({ page }) => {
  await seedXtream(page, { catalog: 'large' });
  await seedResume(page);
  await page.goto('/');
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies .catalog-hero')).toBeVisible();
  await expectBackdrop(page, '#view-movies', 'movies', ['.catalog-rails']);

  await page.locator('#view-movies .catalog-see-all[data-category-id="1"]').click();
  await expectBackdrop(page, '#view-movies', 'movies', ['.catalog-layer-grid .catalog-view']);
  await page.keyboard.press('Escape');
  await expect(page.locator('#view-movies .catalog-layer-browse')).not.toHaveClass(/catalog-layer-hidden/);

  await page.locator('#view-movies [data-collection-manage="continue"]').click();
  await expect(page.locator('#view-movies [data-collection-action="remove"]').first()).toBeVisible();
  await expectBackdrop(page, '#view-movies', 'movies', ['.catalog-layer-grid .catalog-view']);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('#view-movies .catalog-layer-browse')).not.toHaveClass(/catalog-layer-hidden/);

  await page.locator('#view-movies .catalog-tile[data-item-id="10"]').first().click();
  await expectBackdrop(page, '#view-movies', 'movies', ['.catalog-detail']);
});

test('Series browse and detail sit on the shared backdrop around their artwork', async ({ page }) => {
  await seedXtream(page);
  await page.goto('/');
  await enterTab(page, 'series');
  await expect(page.locator('#view-series .catalog-hero')).toBeVisible();
  await expectBackdrop(page, '#view-series', 'series', ['.catalog-rails']);

  await page.locator('#view-series .catalog-tile[data-item-id="20"]').first().click();
  await expectBackdrop(page, '#view-series', 'series', ['.catalog-detail']);
});
