import {
  test,
  expect,
  routeLiveManifest,
  SAMPLE_M3U,
  enterTab,
  readUserDataStore,
  openGuide,
} from './helpers';

// Opened from Home's Live card after every load (see `startOn`).
test.use({ startOn: 'live' });

function xmltvDate(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
}

// Seed one Xtream account (enables the tab bar) and stub the player_api.php
// catalog calls + the get.php/xmltv.php the live path uses. get_vod_streams /
// get_series with no category return the whole catalog Search matches against;
// get_vod_info backs the movie deep-link into the Movies detail. Action names
// that are substrings of others are routed most-specific-first (get_series_*
// before get_series, get_vod_info/get_vod_categories before get_vod_streams).
async function seedSearch(page: import('@playwright/test').Page): Promise<void> {
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const stop = new Date(start.getTime() + 60 * 60 * 1000);
  const epg = `<tv>
    <channel id="one"><display-name>Channel One</display-name></channel>
    <programme channel="one" start="${xmltvDate(start)}" stop="${xmltvDate(stop)}">
      <title>Future Report</title><category>News</category>
    </programme>
  </tv>`;
  await page.route('**/get.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: epg }));
  await page.route('**/player_api.php*', (route) => {
    const url = route.request().url();
    if (url.includes('get_vod_categories')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ category_id: '1', category_name: 'Cat A' }]) });
    }
    if (url.includes('get_vod_info')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ info: { plot: 'Movie plot.', duration_secs: 3600, movie_image: '' } }) });
    }
    if (url.includes('get_vod_streams')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { stream_id: 10, name: 'Movie One', stream_icon: '', container_extension: 'mp4', category_id: '1' },
      ]) });
    }
    if (url.includes('get_series_categories')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ category_id: '1', category_name: 'Cat A' }]) });
    }
    if (url.includes('get_series_info')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ episodes: {} }) });
    }
    if (url.includes('get_series')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { series_id: 1, name: 'Series One', cover: '', category_id: '1' },
      ]) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  // The movie file itself: a small response so play() doesn't hang the test.
  await page.route('**/movie/**', (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'x1', name: 'X Account', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ]));
  });
}

// Open Search with the caret in its box (results appear once a query is typed).
async function enterSearch(page: import('@playwright/test').Page): Promise<void> {
  await enterTab(page, 'search');
  await expect(page.locator('.search-box-input')).toBeFocused();
}

test('M3U channel results sit above matching programmes', async ({ page }) => {
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const stop = new Date(start.getTime() + 60 * 60 * 1000);
  const epg = `<tv>
    <channel id="one"><display-name>Channel One</display-name></channel>
    <programme channel="one" start="${xmltvDate(start)}" stop="${xmltvDate(stop)}">
      <title>Programme One</title>
    </programme>
  </tv>`;
  await page.route('**/playlist.m3u', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/guide.xml', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: epg }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { name: 'P', url: 'http://host/playlist.m3u' },
    ]));
    localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/guide.xml', playlistIds: [] }]));
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);
  await page.locator('.search-box-input').fill('one');

  const channel = page.locator('#view-search .search-channel-card').first();
  const programme = page.locator('#view-search .search-program-card').first();
  await expect(channel).toContainText('Channel One');
  await expect(programme).toContainText('Programme One');
  await expect.poll(async () => {
    const channelBox = await channel.boundingBox();
    const programmeBox = await programme.boundingBox();
    if (!channelBox || !programmeBox) return false;
    return channelBox.height >= 80
      && channelBox.y + channelBox.height <= programmeBox.y;
  }).toBe(true);
});

test('unified search matches channels, movies, and series; a channel result plays', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);

  // One query matches "Channel One" (live, from SAMPLE_M3U), "Movie One", and
  // "Series One". The catalogs load asynchronously on open, so the movie/series
  // groups appear once loaded; the assertions retry until then.
  await page.locator('.search-box-input').fill('one');
  await expect(page.locator('#view-search .search-channel-card[data-channel-index="0"]')).toContainText('Channel One');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toContainText('Movie One');
  await expect(page.locator('#view-search .catalog-tile[data-series-id="1"]')).toContainText('Series One');

  // Hand off from the box to the results (Down), then focus the channel
  // tile via a bubbling nav:hover before OK.
  await page.locator('.search-box-input').press('ArrowDown');
  await page.locator('#view-search .search-channel-card[data-channel-index="0"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
});

test('a query typed while the index prepares shows a spinner with a hint, then its results', async ({ page }) => {
  await seedSearch(page);
  let releaseCatalog!: () => void;
  const catalogHeld = new Promise<void>((resolve) => { releaseCatalog = resolve; });
  await page.route(/get_vod_streams/, async (route) => {
    await catalogHeld;
    await route.fallback();
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);

  await page.locator('.search-box-input').fill('one');
  const busy = page.locator('#view-search .search-results .search-busy');
  await expect(busy).toHaveText('Preparing search…');
  await expect(busy.locator('.search-busy-spinner')).toBeVisible();
  await expect(page.locator('#view-search .catalog-tile')).toHaveCount(0);
  await page.locator('.search-box-input').fill('zzz');
  await expect(busy).toHaveText('Preparing search…');
  await page.locator('.search-box-input').fill('one');

  releaseCatalog();
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toContainText('Movie One');
  await expect(page.locator('#view-search .search-channel-card[data-channel-index="0"]')).toContainText('Channel One');
  await expect(page.locator('#view-search .search-busy')).toHaveCount(0);
});

test('OK in the box closes the keyboard and rings the first result; Up returns to the box', async ({ page }) => {
  await seedSearch(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);
  const input = page.locator('.search-box-input');
  await input.fill('one');
  const first = page.locator('#view-search .search-channel-card[data-channel-index="0"]');
  await expect(first).toContainText('Channel One');

  await input.press('Enter');
  await expect(input).not.toBeFocused();
  await expect(first).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
  await expect(page.locator('.search-box.active')).toHaveCount(0);

  await page.keyboard.press('ArrowUp');
  await expect(input).toBeFocused();
  await expect(page.locator('#view-search .focused')).toHaveCount(0);
});

test('OK while the index prepares closes the keyboard, then rings the first result', async ({ page }) => {
  await seedSearch(page);
  let releaseCatalog!: () => void;
  const catalogHeld = new Promise<void>((resolve) => { releaseCatalog = resolve; });
  await page.route(/get_vod_streams/, async (route) => {
    await catalogHeld;
    await route.fallback();
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);
  const input = page.locator('.search-box-input');
  await input.fill('one');
  await expect(page.locator('#view-search .search-busy')).toBeVisible();

  await input.press('Enter');
  // The box keeps the keys, with no caret, so the on-screen keyboard closes.
  await expect(input).not.toBeFocused();
  await expect(page.locator('.search-box.active')).toHaveCount(1);
  await expect(page.locator('#view-search .focused')).toHaveCount(0);

  releaseCatalog();
  const first = page.locator('#view-search .search-channel-card[data-channel-index="0"]');
  await expect(first).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.search-box.active')).toHaveCount(0);
  await expect(input).not.toBeFocused();
  await expect(page.locator('.focused:visible')).toHaveCount(1);
});

test('a wide virtual search rail keeps its full scrollable width', async ({ page }) => {
  await seedSearch(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);
  await page.locator('.search-box-input').fill('one');

  const rail = page.locator('[data-search-virtual="movies"]');
  await expect(rail.locator('.search-rail-spacer')).toBeVisible();
  const metrics = await rail.evaluate((element) => {
    const spacer = element.querySelector<HTMLElement>('.search-rail-spacer');
    if (!spacer) throw new Error('virtual rail spacer not found');
    spacer.style.width = '12000000px';
    element.scrollLeft = element.scrollWidth;
    return {
      flexShrink: getComputedStyle(spacer).flexShrink,
      spacerWidth: spacer.getBoundingClientRect().width,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      scrollLeft: element.scrollLeft,
    };
  });

  expect(metrics.flexShrink).toBe('0');
  expect(metrics.spacerWidth).toBe(12_000_000);
  expect(metrics.scrollWidth).toBeGreaterThanOrEqual(12_000_000);
  // Past 2^23px a scroll offset is float-rounded, so allow 1px either way.
  expect(Math.abs(metrics.scrollLeft - (metrics.scrollWidth - metrics.clientWidth)))
    .toBeLessThanOrEqual(1);
});

test('program search shows XMLTV metadata and toggles a future reminder', async ({ page }) => {
  await seedSearch(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);

  await page.locator('.search-box-input').fill('report');
  const result = page.locator('#view-search .search-program-card');
  await expect(result).toContainText('Future Report');
  await expect(result).toContainText('Channel One');
  await expect(result).toContainText('Set reminder');
  await expect(page.locator('#view-search .search-section-programmes .search-section-count')).toHaveText('1');
  // Every rail starts on the screen's 80px gutter.
  const box = await result.boundingBox();
  expect(Math.round(box!.x)).toBe(80);

  await result.click();
  await expect(result).toContainText('Reminder set');
  await expect.poll(async () =>
    (await readUserDataStore(page, 'reminders')).length).toBe(1);
});

test('a movie search result deep-links into its Movies detail and Back returns to Search', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);

  await page.locator('.search-box-input').fill('one');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toContainText('Movie One');

  // Hand off to the results (Down), then open the movie result (deep-links into
  // the Movies detail).
  await page.locator('.search-box-input').press('ArrowDown');
  await page.locator('#view-search .catalog-tile[data-stream-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies')).toBeVisible();
  await expect(page.locator('#view-movies .detail-plot')).toContainText('Movie plot.');

  // Back from the deep-linked detail returns to Search (CONFIG.KEYS.BACK = 461;
  // dispatch a raw keydown like the other section specs do).
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-search')).toBeVisible();
});

// Open the movie result for the query, deep-linking into the Movies detail.
async function openMovieResult(page: import('@playwright/test').Page, query: string): Promise<void> {
  const input = page.locator('.search-box-input');
  await input.fill(query);
  const tile = page.locator('#view-search .catalog-tile[data-stream-id="10"]');
  await expect(tile).toContainText('Movie One');
  await input.press('ArrowDown');
  await tile.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('Movie plot.');
}

test('opening Movies reloads a browse a Search deep link interrupted', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  // Hold the first Movies category load so the deep link interrupts it.
  let held = false;
  await page.route('**/player_api.php*', (route) => {
    if (!held && route.request().url().includes('get_vod_categories')) {
      held = true;
      return;
    }
    return route.fallback();
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies .catalog-loading')).toBeVisible();
  await enterSearch(page);

  await openMovieResult(page, 'one');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-search')).toBeVisible();

  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies')).toBeVisible();
  await expect(page.locator('#view-movies .catalog-browse .catalog-tile[data-item-id="10"]'))
    .toContainText('Movie One');
});

test('a movie result opened by POINTER can then be played by pointer (the box lets the keys go)', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);

  await page.locator('.search-box-input').fill('one');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toContainText('Movie One');

  // Open the movie by a POINTER click on the result — no ArrowDown hand-off, so
  // the search box keeps its scope (the pointer path) until the result opens.
  await page.locator('#view-search .catalog-tile[data-stream-id="10"]').click();
  await expect(page.locator('#view-movies .detail-btn-primary')).toBeVisible();

  // Play by a POINTER click on the detail button. Regression guard: a stale
  // search focus once swallowed this select. We assert the movie
  // stream is actually requested — proof the select reached play() — rather than
  // the player view staying up (the stubbed empty video errors back to Movies).
  const streamRequested = page.waitForRequest('**/movie/**', { timeout: 5000 });
  await page.locator('#view-movies .detail-btn-primary').click();
  await streamRequested;
});

const BACK = 461;
async function pressBack(page: import('@playwright/test').Page): Promise<void> {
  // Back reaches the app even from the search box (an input passthrough key).
  await page.evaluate((code) => {
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { keyCode: code, bubbles: true }));
  }, BACK);
}

test('recent searches show as chips under the box, run on OK, and clear without confirming', async ({ page }) => {
  await seedSearch(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_search_history', JSON.stringify(['one', 'Movie']));
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);

  const chips = page.locator('#view-search .search-recent-chip');
  const clear = page.locator('#view-search [data-history-clear]');
  const input = page.locator('.search-box-input');
  await expect(page.locator('#view-search .search-recent .search-section-title')).toHaveText('Recent searches');
  await expect(chips).toHaveText(['one', 'Movie']);
  await expect(chips.first().locator('svg')).toBeVisible();

  // Down from the box focuses the first chip; Up from the top row goes
  // straight back to the box, past the clear button, which Right reaches.
  await input.press('ArrowDown');
  await expect(chips.first()).toHaveClass(/focused/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
  await page.keyboard.press('ArrowUp');
  await expect(input).toBeFocused();
  await expect(page.locator('.focused:visible')).toHaveCount(0);
  await input.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(chips.nth(1)).toHaveClass(/focused/);
  await page.keyboard.press('ArrowRight');
  await expect(clear).toHaveClass(/focused/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
  await page.keyboard.press('ArrowUp');
  await expect(input).toBeFocused();

  // OK on a chip runs that search: the box takes the query and the results
  // replace the chips.
  await input.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('one');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toContainText('Movie One');
  await expect(chips).toHaveCount(0);
  await expect(page.locator('.focused:visible')).toHaveCount(1);

  // Emptying the box brings the chips back; clearing them puts the caret back.
  await input.fill('');
  await expect(chips).toHaveCount(2);
  await clear.click();
  await expect(page.locator('.confirmation-overlay')).toHaveCount(0);
  await expect(chips).toHaveCount(0);
  await expect(page.locator('#view-search')).toBeVisible();
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem('iptv_search_history'))).toBeNull();

  // With nothing left below, Down and OK keep the remote in the box.
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(input).toBeFocused();
  await page.keyboard.type('one');
  await expect(input).toHaveValue('one');
});

test('a pointer click on a recent search runs it', async ({ page }) => {
  await seedSearch(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_search_history', JSON.stringify(['one']));
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);
  await page.locator('#view-search .search-recent-chip').click();
  await expect(page.locator('.search-box-input')).toHaveValue('one');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toContainText('Movie One');
});

test('picking a recent search that matches nothing keeps the remote in the box', async ({ page }) => {
  await seedSearch(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_search_history', JSON.stringify(['zzz']));
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);
  const input = page.locator('.search-box-input');
  await expect(page.locator('.search-recent-chip')).toHaveText(['zzz']);
  await input.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('zzz');
  await expect(page.locator('#view-search')).toBeVisible();
  // The box holds the keys with the keyboard shut; OK puts the caret back.
  await expect(page.locator('.search-box.active')).toHaveCount(1);
  await expect(input).not.toBeFocused();
  await expect(page.locator('.focused:visible')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(input).toBeFocused();
});

test('the search box is a wide pill centered on the screen, with recent searches under it', async ({ page }) => {
  await seedSearch(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_search_history', JSON.stringify(['one']));
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);
  const box = (await page.locator('.search-box').boundingBox())!;
  expect(Math.round(box.width)).toBe(1100);
  expect(Math.round(box.height)).toBe(84);
  expect(Math.abs(box.x + box.width / 2 - 960)).toBeLessThanOrEqual(1);
  expect(Math.round(box.y)).toBe(72);
  await expect(page.locator('.search-box')).toHaveClass(/\bactive\b/);
  const recent = (await page.locator('#view-search .search-recent').boundingBox())!;
  expect(Math.abs(recent.x - box.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(recent.width - box.width)).toBeLessThanOrEqual(1);
  expect(recent.y).toBeGreaterThan(box.y + box.height);
});

test('typed results start right under the box at the screen gutter, counted and highlighted', async ({ page }) => {
  await seedSearch(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);
  await page.locator('.search-box-input').fill('one');
  const titles = page.locator('#view-search .search-section-title');
  await expect(page.locator('#view-search .search-section-series')).toBeVisible();
  await expect(titles).toHaveText(['Channels1', 'Programs1', 'Movies1', 'Series1']);
  const box = (await page.locator('.search-box').boundingBox())!;
  const first = (await titles.first().boundingBox())!;
  expect(Math.round(await titles.first().evaluate((el) =>
    el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft)))).toBe(80);
  // Clear of the box, and well above the system keyboard (the bottom 45%).
  expect(first.y).toBeGreaterThan(box.y + box.height);
  expect(first.y - (box.y + box.height)).toBeLessThan(80);
  const card = (await page.locator('#view-search .search-channel-card').boundingBox())!;
  expect(Math.round(card.x)).toBe(80);
  expect(card.y + card.height).toBeLessThan(1080 * 0.55);
  await expect(page.locator('#view-search .search-channel-card .search-match')).toHaveText('One');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"] .search-match')).toHaveText('One');
  const color = await page.locator('#view-search .search-channel-card .search-match')
    .evaluate((el) => getComputedStyle(el).color);
  const accent = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  expect(color).toBe(accent);
});

test('a highlighted match in an untrusted name stays text', async ({ page }) => {
  await seedSearch(page);
  await page.route(/get_vod_streams/, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{
      stream_id: 66, name: '<img src=x onerror="window.__xss=1">Alpha', stream_icon: '',
      container_extension: 'mp4', category_id: '1',
    }]),
  }));
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);
  await page.locator('.search-box-input').fill('alp');
  const name = page.locator('#view-search .catalog-tile[data-stream-id="66"] .catalog-tile-name');
  await expect(name).toHaveText('<img src=x onerror="window.__xss=1">Alpha');
  await expect(name.locator('.search-match')).toHaveText('Alp');
  await expect(name.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test('an Arabic query finds a title written with another alef form', async ({ page }) => {
  await seedSearch(page);
  await page.route(/get_vod_streams/, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([
      { stream_id: 71, name: 'فيلم أحمد', stream_icon: '', container_extension: 'mp4', category_id: '1' },
      { stream_id: 72, name: 'Bravo', stream_icon: '', container_extension: 'mp4', category_id: '1' },
    ]),
  }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_locale', JSON.stringify('ar'));
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);
  await page.locator('.search-box-input').fill('احمد');
  const tiles = page.locator('#view-search .catalog-tile[data-stream-id]');
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toHaveAttribute('data-stream-id', '71');
  await expect(tiles.first().locator('.search-match')).toHaveText('أحمد');
  // Arabic UI: the box stays centered and the rails keep the 80px gutter.
  const box = (await page.locator('.search-box').boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - 960)).toBeLessThanOrEqual(1);
  expect(Math.round((await tiles.first().boundingBox())!.x)).toBe(80);
  await page.locator('.search-box-input').press('ArrowDown');
  await expect(tiles.first()).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
});

test('at Interface size 130 the box and rails scale and one ring shows', async ({ page }) => {
  await seedSearch(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_interface_size', JSON.stringify('130'));
    localStorage.setItem('iptv_search_history', JSON.stringify(['one']));
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);
  const box = (await page.locator('.search-box').boundingBox())!;
  expect(Math.round(box.width)).toBe(1430);
  expect(Math.abs(box.x + box.width / 2 - 960)).toBeLessThanOrEqual(1);
  const input = page.locator('.search-box-input');
  await input.press('ArrowDown');
  await expect(page.locator('#view-search .search-recent-chip')).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toBeVisible();
  const card = (await page.locator('#view-search .search-channel-card').boundingBox())!;
  expect(Math.round(card.x)).toBe(104);
  expect(Math.round(card.width)).toBe(390);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.focused:visible')).toHaveCount(1);
});

// Regression: Back from a recent search or a result used to jump to Live.
test('Back steps from recent searches and results to the box, then Home', async ({ page }) => {
  await seedSearch(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_search_history', JSON.stringify(['one']));
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await openGuide(page);
  await enterSearch(page);

  const input = page.locator('.search-box-input');
  await input.press('ArrowDown');
  await expect(page.locator('#view-search .search-recent-chip').first()).toHaveClass(/focused/);
  await pressBack(page);
  await expect(input).toBeFocused();
  await expect(page.locator('.focused:visible')).toHaveCount(0);
  await expect(page.locator('#view-search')).toBeVisible();

  await input.fill('one');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toContainText('Movie One');
  await input.press('ArrowDown');
  await expect(page.locator('#view-search .focused')).toHaveCount(1);
  await pressBack(page);
  await expect(input).toBeFocused();
  await expect(page.locator('#view-search')).toBeVisible();
  await expect(page.locator('#view-search .focused')).toHaveCount(0);

  await pressBack(page);
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(page.locator('#view-search')).toBeHidden();
  await expect(page.locator('#view-home .focused')).toHaveAttribute('data-section', 'search');
  await expect(input).not.toBeFocused();
  await expect(page.locator('.focused:visible')).toHaveCount(1);
});

test('Back from a channel played from Search returns to Search', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);
  const input = page.locator('.search-box-input');
  await input.fill('one');
  const channel = page.locator('#view-search .search-channel-card[data-channel-index="0"]');
  await expect(channel).toContainText('Channel One');
  await input.press('ArrowDown');
  await channel.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();

  await pressBack(page);
  await expect(page.locator('#view-search')).toBeVisible();
  await expect(page.locator('#view-player')).toBeHidden();
  await expect(page.locator('#view-channels')).toBeHidden();
  await expect(channel).toBeVisible();
  await pressBack(page);
  await expect(input).toBeFocused();
  await pressBack(page);
  await expect(page.locator('#view-home')).toBeVisible();
});

test('opening a search result records the query as a recent search', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);
  await page.locator('.search-box-input').fill('one');
  const channel = page.locator('#view-search .search-channel-card[data-channel-index="0"]');
  await expect(channel).toContainText('Channel One');
  await page.locator('.search-box-input').press('ArrowDown');
  await channel.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('iptv_search_history'))).toBe('["one"]');
});

// Hover a row, then let the pointer leave it: the highlight hides but focus stays.
async function hoverThenLeave(el: import('@playwright/test').Locator): Promise<void> {
  await el.evaluate((node) => {
    node.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    node.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
  });
}

test('after the pointer leaves a result, the first key shows it and the next one moves', async ({ page }) => {
  await seedSearch(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);
  await page.locator('.search-box-input').fill('channel');
  const tile = (index: number) => page.locator(`#view-search .search-channel-card[data-channel-index="${String(index)}"]`);
  await expect(tile(1)).toBeVisible();
  await page.locator('.search-box-input').press('ArrowDown');
  // Step along the channel results, which search moves through by itself.
  const along = 'ArrowRight';
  await hoverThenLeave(tile(0));
  await expect(page.locator('#view-search .focused')).toHaveCount(0);

  await page.keyboard.press(along);
  await expect(tile(0)).toHaveClass(/\bfocused\b/);
  await page.keyboard.press(along);
  await expect(tile(1)).toHaveClass(/\bfocused\b/);
});

test('Up back to the box leaves no ring on a result, while typing too', async ({ page }) => {
  await seedSearch(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);
  const input = page.locator('.search-box-input');
  await input.fill('on');
  const tile = page.locator('#view-search .search-channel-card[data-channel-index="0"]');
  await expect(tile).toContainText('Channel One');
  await input.press('ArrowDown');
  await expect(page.locator('#view-search .focused')).toHaveCount(1);

  for (let i = 0; i < 4; i++) {
    if (await input.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press('ArrowUp');
  }
  await expect(input).toBeFocused();
  await expect(page.locator('#view-search .focused')).toHaveCount(0);
  await page.keyboard.type('e');
  await expect(page.locator('#view-search [data-search-query]')).toHaveAttribute('data-search-query', 'one');
  await expect(tile).toBeVisible();
  await expect(page.locator('#view-search .focused')).toHaveCount(0);
});

test('Down from the box after Up rings a result at once, and one Right moves', async ({ page }) => {
  await seedSearch(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);
  const input = page.locator('.search-box-input');
  await input.fill('one');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toContainText('Movie One');
  await input.press('ArrowDown');
  const focused = page.locator('#view-search .focused');
  await expect(focused).toHaveCount(1);
  const first = await focused.getAttribute('data-key');

  for (let i = 0; i < 4; i++) {
    if (await input.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press('ArrowUp');
  }
  await expect(input).toBeFocused();
  await expect(focused).toHaveCount(0);

  await input.press('ArrowDown');
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveAttribute('data-key', first ?? '');
  await page.keyboard.press('ArrowRight');
  await expect(focused).toHaveCount(1);
  await expect(focused).not.toHaveAttribute('data-key', first ?? '');
});
