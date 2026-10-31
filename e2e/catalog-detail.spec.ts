import { test, expect, enterTab, routeLiveManifest, neuterVideo, SAMPLE_M3U, type Page } from './helpers';

// Opened from Home's Live card after every load (see `startOn`).
test.use({ startOn: 'live' });

// The movie and series detail pages: a hero whose blocks keep their place
// whatever text arrives, an actions row, and rows for episodes, cast, and
// titles like this one.

const SHORT = 'A short plot.';
const LONG = Array.from({ length: 12 }, (_, i) =>
  `Sentence ${String(i + 1)} of a long synthetic plot that runs well past three lines.`).join(' ');
const TMDB_KEY = '0123456789abcdef0123456789abcdef';
const FACE = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#468"/></svg>';

interface Seed {
  locale?: string;
  interfaceSize?: string;
  tmdbKey?: string;
  resume?: Record<string, unknown>;
}

async function seed(page: Page, opts: Seed = {}): Promise<{ releaseInfo: () => void; tmdbRequests: string[] }> {
  let releaseInfo = (): void => {};
  const held = new Promise<void>((resolve) => { releaseInfo = resolve; });
  const tmdbRequests: string[] = [];
  await page.route('**/get.php*', route =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/xmltv.php*', route =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', async (route) => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (action === 'get_vod_categories') return json([{ category_id: '1', category_name: 'Cat A' }]);
    if (action === 'get_series_categories') return json([{ category_id: '2', category_name: 'Cat B' }]);
    if (action === 'get_vod_streams') {
      return json([
        { stream_id: 10, name: 'Movie One', stream_icon: '', container_extension: 'mp4', category_id: '1', rating: '6' },
        { stream_id: 11, name: 'Movie Two', stream_icon: '', container_extension: 'mp4', category_id: '1', rating: '8' },
        { stream_id: 12, name: 'Movie Three', stream_icon: '', container_extension: 'mp4', category_id: '1', rating: '0' },
      ]);
    }
    if (action === 'get_series') {
      return json([
        { series_id: 1, name: 'Series One', cover: '', category_id: '2', rating: '7', genre: 'Drama' },
        { series_id: 2, name: 'Series Two', cover: '', category_id: '2', rating: '5', genre: 'Drama' },
      ]);
    }
    if (action === 'get_vod_info') {
      const id = url.searchParams.get('vod_id');
      if (id === '12') {
        await held;
        if (page.isClosed()) return undefined;
      }
      return json({ info: {
        plot: id === '11' ? LONG : SHORT,
        cast: 'Actor A, Actor B, Actor C',
        director: 'Director G',
        genre: 'Drama',
        releasedate: '2021-04-01',
        duration_secs: 6720,
        rating: '7.4',
        tmdb_id: '123',
      } }).catch(() => undefined);
    }
    if (action === 'get_series_info') {
      const episode = (id: string, season: number, n: number) => ({
        id, title: `Episode ${String(n)}`, season, episode_num: n, container_extension: 'mp4',
        info: { duration_secs: 2520 },
      });
      return json({
        info: { name: 'Series One', plot: SHORT, cast: 'Actor A', director: '', genre: 'Drama', releaseDate: '2019-01-01', rating: '8.1' },
        episodes: {
          1: [episode('101', 1, 1), episode('102', 1, 2), episode('103', 1, 3)],
          2: [episode('201', 2, 1), episode('202', 2, 2)],
        },
      });
    }
    return json({});
  });
  await page.route('https://api.themoviedb.org/**', (route) => {
    tmdbRequests.push(route.request().url());
    return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({
      cast: [
        { name: 'Actor A', profile_path: '/a.jpg', character: 'Role 1' },
        { name: 'Actor B', profile_path: '/b.jpg', character: 'Role 2' },
      ],
      crew: [{ name: 'Director G', job: 'Director', profile_path: '/g.jpg' }],
    }) });
  });
  await page.route('https://image.tmdb.org/**', route => route.fulfill({ contentType: 'image/svg+xml', body: FACE }));
  await page.route('http://host.example.com:8080/movie/**', route => route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.addInitScript((o: Seed) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'x1', name: 'X Account', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ]));
    if (o.locale) localStorage.setItem('iptv_locale', JSON.stringify(o.locale));
    if (o.interfaceSize) localStorage.setItem('iptv_interface_size', JSON.stringify(o.interfaceSize));
    if (o.tmdbKey) localStorage.setItem('iptv_tmdb_api_key', JSON.stringify(o.tmdbKey));
    if (o.resume) localStorage.setItem('iptv_resume', JSON.stringify(o.resume));
  }, opts);
  return { releaseInfo: () => releaseInfo(), tmdbRequests };
}

async function openTitle(page: Page, section: 'movies' | 'series', id: string): Promise<void> {
  await page.locator(`#view-${section} .catalog-layer-browse .catalog-tile[data-item-id="${id}"]`).first()
    .evaluate(el => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator(`#view-${section} .catalog-layer-detail .detail-title`)).toBeVisible();
}

const back = (page: Page) => page.evaluate(() =>
  document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));

const actionsTop = (page: Page, section = 'movies') => page.locator(`#view-${section} .detail-actions`)
  .evaluate(el => el.getBoundingClientRect().top);

const focusedKey = (page: Page, section = 'movies') =>
  page.locator(`#view-${section} .catalog-layer-detail .focused`).getAttribute('data-key');

test('keeps the actions in place for a short, a long, and a pending description', async ({ page }) => {
  const { releaseInfo } = await seed(page);
  await page.goto('/');
  await enterTab(page, 'movies');
  const detail = page.locator('#view-movies .catalog-layer-detail');

  await openTitle(page, 'movies', '10');
  await expect(detail.locator('.detail-plot')).toHaveText(SHORT);
  const short = await actionsTop(page);
  await back(page);

  await openTitle(page, 'movies', '11');
  await expect(detail.locator('.detail-plot')).toContainText('Sentence 1 ');
  const long = await actionsTop(page);
  const clamp = await detail.locator('.detail-plot-box').evaluate(box => ({
    box: box.getBoundingClientRect().height,
    lines: parseFloat(getComputedStyle(box).lineHeight),
  }));
  expect(Math.round(clamp.box / clamp.lines)).toBe(3);
  await back(page);

  await openTitle(page, 'movies', '12');
  await expect(detail.locator('.detail-plot')).toHaveText('');
  const pending = await actionsTop(page);
  releaseInfo();
  await expect(detail.locator('.detail-plot')).toHaveText(SHORT);
  const arrived = await actionsTop(page);

  expect(new Set([short, long, pending, arrived]).size).toBe(1);
});

test('opens the full description over the page; Back closes it and the focus stays', async ({ page }) => {
  await seed(page);
  await page.goto('/');
  await enterTab(page, 'movies');
  await openTitle(page, 'movies', '11');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('Sentence 1 ');
  expect(await focusedKey(page)).toBe('play');
  await page.keyboard.press('ArrowUp');
  expect(await focusedKey(page)).toBe('plot');
  await page.keyboard.press('Enter');
  const overlay = page.locator('.detail-text-prompt');
  await expect(overlay).toBeVisible();
  await expect(overlay.locator('.detail-text-title')).toHaveText('Movie Two');
  await expect(overlay.locator('.detail-text-body')).toContainText('Sentence 12 ');
  // The overlay holds the keys: Down scrolls the text instead of moving focus.
  await page.keyboard.press('ArrowDown');
  await expect(overlay).toBeVisible();
  await back(page);
  await expect(overlay).toBeHidden();
  await expect(page.locator('#view-movies .catalog-layer-detail')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  expect(await focusedKey(page)).toBe('play');
});

test('toggles the Watchlist and shows the meta line, then Resume and Play from start', async ({ page }) => {
  await seed(page, { resume: { 'x1|vod|10': {
    accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '', ext: 'mp4',
    categoryId: '1', position: 2530, duration: 6720, updatedAt: 1,
  } } });
  await page.goto('/');
  await enterTab(page, 'movies');
  await openTitle(page, 'movies', '10');
  const detail = page.locator('#view-movies .catalog-layer-detail');
  await expect(detail.locator('.detail-meta-part')).toHaveText(['2021', '1h 52m', 'Drama', '7.4']);
  const resume = detail.locator('[data-action="resume"]');
  await expect(resume).toContainText('Resume 42:10');
  await expect(resume.locator('.detail-btn-progress')).toHaveCount(0);
  expect(await focusedKey(page)).toBe('resume');
  await expect(detail.locator('.detail-actions [data-action]'))
    .toHaveText(['Resume 42:10', 'Play from start', 'Watchlist']);
  await page.keyboard.press('ArrowRight');
  expect(await focusedKey(page)).toBe('play');
  await expect(page.locator('.focused:visible')).toHaveCount(1);

  const watchlist = detail.locator('[data-action="watchlist"]');
  await expect(watchlist).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('ArrowRight');
  expect(await focusedKey(page)).toBe('watchlist');
  await page.keyboard.press('Enter');
  await expect(watchlist).toHaveAttribute('aria-pressed', 'true');
  expect(await focusedKey(page)).toBe('watchlist');
  await watchlist.click();
  await expect(watchlist).toHaveAttribute('aria-pressed', 'false');
});

test('shows cast initials and makes no TMDB request without a key', async ({ page }) => {
  const { tmdbRequests } = await seed(page);
  await page.goto('/');
  await enterTab(page, 'movies');
  await openTitle(page, 'movies', '10');
  const cast = page.locator('#view-movies [data-rail-key="cast"]');
  await expect(cast.locator('.detail-person-name')).toHaveText(['Actor A', 'Actor B', 'Actor C', 'Director G']);
  await expect(cast.locator('.detail-person-initials')).toHaveText(['AA', 'AB', 'AC', 'DG']);
  await expect(cast.locator('.detail-person-role')).toHaveText(['Director']);
  await expect(cast.locator('.detail-person-photo')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(tmdbRequests).toEqual([]);
});

test('shows TMDB photos and roles for matching cast with the user key', async ({ page }) => {
  const { tmdbRequests } = await seed(page, { tmdbKey: TMDB_KEY });
  await page.goto('/');
  await enterTab(page, 'movies');
  await openTitle(page, 'movies', '10');
  const cast = page.locator('#view-movies [data-rail-key="cast"]');
  await expect(cast.locator('.detail-person-photo')).toHaveCount(3);
  await expect(cast.locator('.detail-person-photo').first())
    .toHaveAttribute('src', 'https://image.tmdb.org/t/p/w185/a.jpg');
  await expect(cast.locator('.detail-person-role')).toHaveText(['Role 1', 'Role 2', 'Director']);
  expect(tmdbRequests).toEqual([`https://api.themoviedb.org/3/movie/123/credits?api_key=${TMDB_KEY}`]);

  // Down walks the rows; OK on a person does nothing.
  await page.keyboard.press('ArrowDown');
  expect(await focusedKey(page)).toBe('person:0');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .catalog-layer-detail .detail-title')).toHaveText('Movie One');
});

test('More like this ranks the category and opens a title; Back returns to browse', async ({ page }) => {
  await seed(page);
  await page.goto('/');
  await enterTab(page, 'movies');
  await openTitle(page, 'movies', '10');
  const similar = page.locator('#view-movies [data-rail-key="similar"]');
  await expect(similar.locator('.catalog-tile')).toHaveCount(2);
  await expect(similar.locator('.catalog-tile-name')).toHaveText(['Movie Two', 'Movie Three']);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(similar.locator('.focused')).toHaveAttribute('data-item-id', '11');
  // The row snaps to the top of the rail area.
  const rails = await page.locator('#view-movies .detail-rails').evaluate(el => el.getBoundingClientRect().top);
  await expect.poll(() => similar.evaluate(el => Math.round(el.getBoundingClientRect().top))).toBe(Math.round(rails));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-title')).toHaveText('Movie Two');
  expect(await focusedKey(page)).toBe('play');
  await back(page);
  await expect(page.locator('#view-movies .catalog-layer-browse')).toBeVisible();
  await expect(page.locator('#view-movies .catalog-layer-browse .focused')).toHaveAttribute('data-item-id', '10');
});

test('series: season tabs, episode cards, and Resume on the last-watched episode', async ({ page }) => {
  await routeLiveManifest(page);
  await neuterVideo(page);
  await seed(page, { resume: { 'x1|episode|202': {
    accountId: 'x1', kind: 'episode', itemId: '202', name: 'Series One — S2E2 — Episode 2', poster: '',
    ext: 'mp4', categoryId: '2', position: 630, duration: 2520, updatedAt: 1,
    watchlistOwner: { kind: 'series', itemId: '1' },
  } } });
  await page.goto('/');
  await enterTab(page, 'series');
  await openTitle(page, 'series', '1');
  const detail = page.locator('#view-series .catalog-layer-detail');
  await expect(detail.locator('[data-action="resume"]')).toContainText('Resume S2 · E2');
  await expect(detail.locator('.detail-meta-part')).toHaveText(['2019', '2 seasons', 'Drama', '8.1']);
  await expect(detail.locator('.series-season-btn')).toHaveText(['Season 1', 'Season 2']);
  await expect(detail.locator('.series-season-btn.active')).toHaveText('Season 2');
  await expect(detail.locator('.episode-card .episode-title')).toHaveText(['E1 · Episode 1', 'E2 · Episode 2']);
  await expect(detail.locator('.episode-card[data-episode-id="202"] .catalog-progress-fill')).toHaveCount(1);
  await expect(detail.locator('.episode-card .episode-meta').first()).toHaveText('42 min');
  expect(await focusedKey(page, 'series')).toBe('resume');
  await expect(detail.locator('[data-action="resume"] .detail-btn-progress')).toHaveCount(0);
  await expect(detail.locator('.detail-actions [data-action]'))
    .toHaveText(['Resume S2 · E2', 'Play from start', 'Watchlist']);
  await page.keyboard.press('ArrowRight');
  expect(await focusedKey(page, 'series')).toBe('restart');
  await expect(page.locator('.focused:visible')).toHaveCount(1);
  await page.keyboard.press('ArrowLeft');
  expect(await focusedKey(page, 'series')).toBe('resume');

  // Down walks line by line: season tabs, then the cards.
  await page.keyboard.press('ArrowDown');
  expect(await focusedKey(page, 'series')).toBe('season:1');
  await page.keyboard.press('ArrowRight');
  expect(await focusedKey(page, 'series')).toBe('season:2');
  await page.keyboard.press('ArrowLeft');
  expect(await focusedKey(page, 'series')).toBe('season:1');
  await page.keyboard.press('Enter');
  await expect(detail.locator('.episode-card .episode-title')).toHaveText(
    ['E1 · Episode 1', 'E2 · Episode 2', 'E3 · Episode 3']);
  await page.keyboard.press('ArrowDown');
  expect(await focusedKey(page, 'series')).toBe('ep:101');
  await page.keyboard.press('ArrowRight');
  expect(await focusedKey(page, 'series')).toBe('ep:102');
  await page.keyboard.press('ArrowDown');
  expect(await focusedKey(page, 'series')).toBe('person:0');

  // Up walks back the same lines, though the rails clipped the episodes away.
  const path: (string | null)[] = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('ArrowUp');
    path.push(await focusedKey(page, 'series'));
  }
  expect(path).toEqual(['ep:101', 'season:1', 'resume']);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#player-osd .osd-channel-name')).toContainText('S2E2');
});

for (const variant of [
  { name: 'Interface size 130', opts: { interfaceSize: '130' } },
  { name: 'Arabic', opts: { locale: 'ar' } },
]) {
  test(`keeps the detail inside the screen at ${variant.name}`, async ({ page }) => {
    await seed(page, { ...variant.opts, resume: { 'x1|vod|11': {
      accountId: 'x1', kind: 'vod', itemId: '11', name: 'Movie Two', poster: '', ext: 'mp4',
      categoryId: '1', position: 60, duration: 600, updatedAt: 1,
    } } });
    await page.goto('/');
    await enterTab(page, 'movies');
    await openTitle(page, 'movies', '11');
    const box = await page.locator('#view-movies .catalog-detail').evaluate((root) => {
      const rect = (sel: string) => root.querySelector(sel)!.getBoundingClientRect();
      const buttons = Array.from(root.querySelectorAll('.detail-btn')).map(b => b.getBoundingClientRect());
      const poster = root.querySelector<HTMLElement>('.detail-poster-wrap')!;
      return {
        body: rect('.detail-body').bottom,
        rails: rect('.detail-rails').top,
        right: Math.max(...buttons.map(b => b.right)),
        tops: new Set(Array.from(root.querySelectorAll<HTMLElement>('.detail-btn')).map(b => b.offsetTop)).size,
        poster: poster.style.display === 'none' ? null : poster.getBoundingClientRect(),
        clipped: Array.from(root.querySelectorAll<HTMLElement>('.detail-btn'))
          .some(b => b.scrollWidth > b.clientWidth + 1),
      };
    });
    expect(box.body).toBeLessThanOrEqual(box.rails);
    expect(box.right).toBeLessThanOrEqual(1920);
    expect(box.tops).toBe(1);
    expect(box.clipped).toBe(false);
    if (box.poster) expect(box.poster.left).toBeGreaterThan(box.right);
    // The rows snap whole into the rail area.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const similar = page.locator('#view-movies [data-rail-key="similar"]');
    await expect(similar.locator('.focused')).toHaveCount(1);
    await expect.poll(() => similar.evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(1080);
  });
}

test('a movie or episode played to its end shows a full progress bar, also after a relaunch', async ({ page }) => {
  await routeLiveManifest(page);
  await neuterVideo(page);
  await seed(page);
  const finish = () => page.locator('#video-player').evaluate(video => video.dispatchEvent(new Event('ended')));
  const full = /width:\s*100%/;
  await page.goto('/');
  await enterTab(page, 'series');
  await openTitle(page, 'series', '1');
  const detail = page.locator('#view-series .catalog-layer-detail');
  await detail.locator('.series-season-btn[data-season="2"]').click();
  await detail.locator('.episode-card[data-episode-id="202"]').click();
  await expect(page.locator('#view-player')).toBeVisible();
  await finish();
  await expect(detail).toBeVisible();
  await expect(detail.locator('.episode-card[data-episode-id="202"] .catalog-progress-fill'))
    .toHaveAttribute('style', full);

  await enterTab(page, 'movies');
  await openTitle(page, 'movies', '10');
  await page.locator('#view-movies [data-action="play"]').click();
  await expect(page.locator('#view-player')).toBeVisible();
  await finish();
  await expect(page.locator('#view-movies .catalog-layer-detail [data-action="play"] .detail-btn-progress-fill'))
    .toHaveAttribute('style', full);

  // The flag lives in user data, so it survives a relaunch.
  await page.reload();
  await enterTab(page, 'series');
  await openTitle(page, 'series', '1');
  await detail.locator('.series-season-btn[data-season="2"]').click();
  await expect(detail.locator('.episode-card[data-episode-id="202"] .catalog-progress-fill'))
    .toHaveAttribute('style', full);
});

// Left and Right stay in the action row while a neighbor exists (Arabic
// keeps the row's left-to-right layout); Down and Up move between the rows,
// and Up returns to the action Down left.
for (const locale of ['en', 'ar'] as const) {
  const next = 'ArrowRight';
  const previous = 'ArrowLeft';
  const resume = {
    'x1|vod|10': {
      accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '', ext: 'mp4',
      categoryId: '1', position: 2530, duration: 6720, updatedAt: 1,
    },
    'x1|episode|202': {
      accountId: 'x1', kind: 'episode', itemId: '202', name: 'Series One — S2E2 — Episode 2', poster: '',
      ext: 'mp4', categoryId: '2', position: 630, duration: 2520, updatedAt: 1,
      watchlistOwner: { kind: 'series', itemId: '1' },
    },
  };

  const walkRow = async (page: Page, section: 'movies' | 'series', keys: string[]): Promise<void> => {
    expect(await focusedKey(page, section)).toBe(keys[0]);
    for (const key of keys.slice(1)) {
      await page.keyboard.press(next);
      expect(await focusedKey(page, section)).toBe(key);
      await expect(page.locator('.focused:visible')).toHaveCount(1);
    }
    // The row's end holds; the way back walks the same buttons.
    await page.keyboard.press(next);
    expect(await focusedKey(page, section)).toBe(keys[keys.length - 1]);
    for (const key of keys.slice(0, -1).reverse()) {
      await page.keyboard.press(previous);
      expect(await focusedKey(page, section)).toBe(key);
      await expect(page.locator('.focused:visible')).toHaveCount(1);
    }
  };

  test(`${locale}: series detail actions walk along their row, then Down to the seasons and Up`, async ({ page }) => {
    await routeLiveManifest(page);
    await neuterVideo(page);
    await seed(page, { locale });
    await page.goto('/');
    await enterTab(page, 'series');
    await openTitle(page, 'series', '2');
    await expect(page.locator('#view-series .series-season-btn').first()).toBeVisible();
    await walkRow(page, 'series', ['play', 'watchlist']);

    await page.keyboard.press('ArrowDown');
    expect(await focusedKey(page, 'series')).toBe('season:1');
    await expect(page.locator('.focused:visible')).toHaveCount(1);
    await page.keyboard.press('ArrowUp');
    expect(await focusedKey(page, 'series')).toBe('play');
    await expect(page.locator('.focused:visible')).toHaveCount(1);

    await page.keyboard.press(next);
    expect(await focusedKey(page, 'series')).toBe('watchlist');
    await page.keyboard.press('ArrowDown');
    expect(await focusedKey(page, 'series')).toMatch(/^season:/);
    await page.keyboard.press('ArrowUp');
    expect(await focusedKey(page, 'series')).toBe('watchlist');
    await expect(page.locator('.focused:visible')).toHaveCount(1);
  });

  test(`${locale}: resumed series and movie actions walk along their row`, async ({ page }) => {
    await routeLiveManifest(page);
    await neuterVideo(page);
    await seed(page, { locale, resume });
    await page.goto('/');
    await enterTab(page, 'series');
    await openTitle(page, 'series', '1');
    await expect(page.locator('#view-series .series-season-btn').first()).toBeVisible();
    await walkRow(page, 'series', ['resume', 'restart', 'watchlist']);
    await page.keyboard.press('ArrowDown');
    expect(await focusedKey(page, 'series')).toBe('season:1');
    await page.keyboard.press('ArrowUp');
    expect(await focusedKey(page, 'series')).toBe('resume');
    await expect(page.locator('.focused:visible')).toHaveCount(1);

    await enterTab(page, 'movies');
    await openTitle(page, 'movies', '10');
    await walkRow(page, 'movies', ['resume', 'play', 'watchlist']);
    await page.keyboard.press('ArrowDown');
    expect(await focusedKey(page, 'movies')).toBe('person:0');
    await page.keyboard.press('ArrowUp');
    expect(await focusedKey(page, 'movies')).toBe('resume');
    await expect(page.locator('.focused:visible')).toHaveCount(1);
  });
}
