import { test, expect, routeLiveManifest, neuterVideo, SAMPLE_M3U, enterTab } from './helpers';
import { seedXtream } from './fixtures/xtream';

// Opened from Home's Live card after every load (see `startOn`).
test.use({ startOn: 'live' });

// Seed one Xtream account (enables Movies and Series) and stub the player_api.php
// series calls + the get.php/xmltv.php the live path uses.
async function seedSeries(
  page: import('@playwright/test').Page,
  episodes: Record<string, { id: number; title: string; episode_num: number }[]> = {
    '1': [{ id: 10, title: 'Episode One', episode_num: 1 }],
  },
): Promise<void> {
  await page.route('**/get.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', (route) => {
    const url = route.request().url();
    if (url.includes('get_series_categories')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ category_id: '1', category_name: 'Cat A' }]) });
    }
    if (url.includes('get_series_info')) {
      const bySeason: Record<string, unknown[]> = {};
      for (const [season, list] of Object.entries(episodes)) {
        bySeason[season] = list.map((ep) => ({
          ...ep, season: Number(season), container_extension: 'mp4',
          info: { plot: 'Ep plot.', duration_secs: 1500, movie_image: '' },
        }));
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        episodes: bySeason,
      }) });
    }
    if (url.includes('get_series')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { series_id: 1, name: 'Series One', cover: '', category_id: '1' },
      ]) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  // The episode file itself: a small response so play() doesn't hang the test.
  await page.route('**/series/**', (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'x1', name: 'X Account', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ]));
  });
}

test('Continue Watching updates the hero from saved episodes by pointer and remote without loading details', async ({ page }) => {
  await seedSeries(page);
  const details: string[] = [];
  page.on('request', request => {
    if (request.url().includes('action=get_series_info')) details.push(request.url());
  });
  await page.route('http://host/hero/**', route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#468"/></svg>',
  }));
  await page.addInitScript(() => {
    const resume: Record<string, unknown> = {};
    for (const n of [1, 2]) {
      resume[`x1|episode|e${n}`] = {
        accountId: 'x1', kind: 'episode', itemId: `e${n}`, name: `Episode ${n}`,
        poster: `http://host/hero/${n}.svg`, ext: 'mp4',
        position: 100, duration: 600, updatedAt: 3 - n,
      };
    }
    localStorage.setItem('iptv_resume', JSON.stringify(resume));
  });
  await page.goto('/');
  await enterTab(page, 'series');
  const view = page.locator('#view-series');
  const hero = view.locator('.catalog-hero-art');
  const first = view.locator('[data-resume-episode="e1"]');
  const second = view.locator('[data-resume-episode="e2"]');
  await first.hover();
  await expect(view.locator('.catalog-hero-title')).toHaveText('Episode 1');
  await expect(hero).toHaveCSS('background-image', /\/hero\/1\.svg/);
  await second.hover();
  await expect(view.locator('.catalog-hero-title')).toHaveText('Episode 2');
  await expect(hero).toHaveCSS('background-image', /\/hero\/2\.svg/);
  await page.keyboard.press('ArrowLeft');
  await expect(first).toHaveClass(/focused/);
  await expect(view.locator('.catalog-hero-title')).toHaveText('Episode 1');
  await expect(hero).toHaveCSS('background-image', /\/hero\/1\.svg/);
  expect(details).toEqual([]);
});

test('browse Series, open a detail, and play an episode', async ({ page }) => {
  await seedSeries(page);
  await routeLiveManifest(page);
  // Keep VOD alive so the empty mock episode file doesn't fire `error` and
  // auto-eject the player, which would race this test's own Back navigation.
  await neuterVideo(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterTab(page, 'series');
  await expect(page.locator('#view-series')).toBeVisible();

  await expect(page.locator('#view-series .catalog-rail-title')).toContainText('Cat A');
  await expect(page.locator('.catalog-tile[data-item-id="1"]')).toContainText('Series One');

  // Open the series detail. Dispatch an explicit bubbling nav:hover so
  // SpatialNav's container-bound listener focuses the tile before OK.
  await page.locator('.catalog-tile[data-item-id="1"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-series .series-season-btn[data-season="1"]')).toContainText('Season 1');
  await expect(page.locator('#view-series .episode-card[data-episode-id="10"]')).toContainText('Episode One');

  // Play the episode, then Back hides the controls and a second Back returns
  // to the Series view.
  await page.locator('.episode-card[data-episode-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  // Back key (CONFIG.KEYS.BACK = 461; Backspace is unmapped); dispatch a raw
  // keydown like the other specs do.
  await expect(page.locator('#player-osd')).toBeVisible();
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#player-osd')).toBeHidden();
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-series')).toBeVisible();
  // The detail survives the player round-trip (Series isn't re-rendered on return).
  await expect(page.locator('#view-series .episode-card[data-episode-id="10"]')).toContainText('Episode One');
});

test('Back walks Series detail -> browse -> Home instead of ejecting', async ({ page }) => {
  await seedSeries(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterTab(page, 'series');
  await expect(page.locator('#view-series')).toBeVisible();

  await expect(page.locator('.catalog-tile[data-item-id="1"]')).toContainText('Series One');

  // Open the series detail.
  await page.locator('.catalog-tile[data-item-id="1"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-series .series-season-btn[data-season="1"]')).toContainText('Season 1');

  // First Back steps detail -> browse: still inside Series, not ejected to Live.
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-series')).toBeVisible();
  await expect(page.locator('#view-series .catalog-rail-title')).toContainText('Cat A');
  await expect(page.locator('#view-channels')).toBeHidden();

  // Second Back from the browse top level goes Home, on the Series card.
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(page.locator('#view-series')).toBeHidden();
  await expect(page.locator('#view-home .focused')).toHaveAttribute('data-section', 'series');
});

test('episode playback suppresses the live channel sidebar and opens nothing at the right edge', async ({ page }) => {
  await seedSeries(page);
  await routeLiveManifest(page);
  // Keep VOD alive in the player: neuter the <video> so the empty mock episode
  // file doesn't fire `error` and eject back to Series before we probe the edges.
  await neuterVideo(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  // Enter Series, open a detail, and play an episode (VOD mode).
  await enterTab(page, 'series');
  await page.locator('.catalog-tile[data-item-id="1"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await page.locator('.episode-card[data-episode-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#player-osd .osd-channel-name')).toBeVisible();

  // An episode has no channels, so the left edge must not summon the
  // switcher. Check once — the sidebar auto-hides, which would mask a wrong show.
  await page.mouse.move(10, 540);
  await page.waitForTimeout(200);
  expect(await page.locator('#player-sidebar.visible').count()).toBe(0);

  await page.mouse.move(1900, 540);
  await page.waitForTimeout(300);
  expect(await page.locator('#player-menu.visible').count()).toBe(0);
  // The only episode of the show: both episode buttons are disabled.
  await expect(page.locator('#player-osd [data-dock-action="previous"]')).toBeDisabled();
  await expect(page.locator('#player-osd [data-dock-action="next"]')).toBeDisabled();
});

// Three episodes across two seasons, with a settable position on every
// <video> the player creates (an episode switch swaps the element).
async function startEpisode(page: import('@playwright/test').Page, id: number): Promise<void> {
  await seedSeries(page, {
    '1': [{ id: 10, title: 'Episode One', episode_num: 1 }, { id: 11, title: 'Episode Two', episode_num: 2 }],
    '2': [{ id: 20, title: 'Episode Three', episode_num: 1 }],
  });
  await routeLiveManifest(page);
  await page.addInitScript(() => {
    const P = HTMLMediaElement.prototype;
    // The controls stay up through each step instead of hiding mid-test.
    localStorage.setItem('iptv_player_osd_timeout_ms', '12000');
    const times = new WeakMap<HTMLMediaElement, number>();
    P.load = function () { /* no-op */ };
    P.play = function () { return Promise.resolve(); };
    Object.defineProperty(P, 'src', { configurable: true, set() { /* no-op */ }, get() { return ''; } });
    Object.defineProperty(P, 'duration', { configurable: true, get: () => 1500 });
    Object.defineProperty(P, 'paused', { configurable: true, get: () => false });
    Object.defineProperty(P, 'currentTime', {
      configurable: true,
      get(this: HTMLMediaElement) { return times.get(this) ?? 0; },
      set(this: HTMLMediaElement, t: number) { times.set(this, t); },
    });
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'series');
  await page.locator('.catalog-tile[data-item-id="1"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  if (id === 20) {
    await page.locator('.series-season-btn[data-season="2"]')
      .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
    await page.keyboard.press('Enter');
  }
  await page.locator(`.episode-card[data-episode-id="${id}"]`)
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#player-osd .osd-channel-name')).toBeVisible();
}

const episodeTitle = (page: import('@playwright/test').Page) =>
  page.locator('#player-osd .osd-channel-name');
const setPosition = (page: import('@playwright/test').Page, seconds: number) =>
  page.locator('#video-player').evaluate((v: HTMLVideoElement, t) => { v.currentTime = t; }, seconds);

test('Previous restarts the episode, or within its first minute plays the one before', async ({ page }) => {
  await startEpisode(page, 20);
  await expect(episodeTitle(page)).toContainText('S2E1');
  const previous = page.locator('#player-osd [data-dock-action="previous"]');
  const next = page.locator('#player-osd [data-dock-action="next"]');
  await expect(next).toBeDisabled(); // the last episode
  await expect(previous).toBeEnabled();

  // Past the first minute: Previous restarts this episode.
  await setPosition(page, 300);
  await page.keyboard.press('ArrowDown'); // seek bar -> buttons (Play/Pause)
  await page.keyboard.press('ArrowLeft'); // -> Previous
  await expect(previous).toHaveClass(/focused/);
  await expect(page.locator('#player-osd .osd-control-caption')).toHaveText('Previous episode');
  await page.keyboard.press('Enter');
  await expect(episodeTitle(page)).toContainText('S2E1');
  await expect.poll(() => page.locator('#video-player')
    .evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(0);

  // Within the first minute: Previous plays the episode before, across seasons.
  await setPosition(page, 30);
  await page.keyboard.press('Enter');
  await expect(episodeTitle(page)).toContainText('S1E2');
  await expect(next).toBeEnabled();
  await expect(previous).toBeEnabled();

  // A pointer click works the same way; the first episode disables Previous.
  await page.keyboard.press('ArrowUp');
  await previous.click();
  await expect(episodeTitle(page)).toContainText('S1E1');
  await expect(previous).toBeDisabled();
});

test('Next plays the next episode at once and is disabled on the last', async ({ page }) => {
  await startEpisode(page, 10);
  const previous = page.locator('#player-osd [data-dock-action="previous"]');
  const next = page.locator('#player-osd [data-dock-action="next"]');
  await expect(previous).toBeDisabled(); // the first episode
  await expect(next).toBeEnabled();

  await setPosition(page, 300);
  await page.keyboard.press('ArrowDown'); // -> Play/Pause
  await page.keyboard.press('ArrowRight'); // -> Next
  await expect(next).toHaveClass(/focused/);
  await page.keyboard.press('Enter');
  await expect(episodeTitle(page)).toContainText('S1E2');
  await expect.poll(() => page.locator('#video-player')
    .evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(0);

  await next.click();
  await expect(episodeTitle(page)).toContainText('S2E1');
  await expect(next).toBeDisabled();
  await expect(previous).toBeEnabled();
});

const settled = (page: import('@playwright/test').Page) => page.evaluate(() =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

test('opening the section with the pointer leaves the catalog where it loads', async ({ page }) => {
  await seedXtream(page, { catalog: 'large' });
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'series');
  const first = page.locator('#view-series .catalog-tile').first();
  await expect(first).toBeVisible();
  await settled(page);
  await settled(page);

  expect(await page.locator('#view-series .catalog-rails').evaluate((el) => el.scrollTop)).toBe(0);
  // Focus waits on the first tile, without a ring, for the first key.
  await expect(page.locator('#view-series .focused')).toHaveCount(0);
  const parked = page.locator('#view-series .focused-parked');
  await expect(parked).toHaveCount(1);
  expect(await parked.getAttribute('data-key')).toBe(await first.getAttribute('data-key'));
});
