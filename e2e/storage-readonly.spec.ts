import {
  test,
  expect,
  enterTab,
  leaveVod,
  neuterVideo,
  routeLiveManifest,
  SAMPLE_M3U,
  type Page,
} from './helpers';

// Opened from Home's Live card after every load (see `startOn`).
test.use({ startOn: 'live' });

// A TV whose free disk fell below Chromium's system reserve after the app
// was set up: every IndexedDB put aborts with QuotaExceededError once the
// session flag is set, as on each launch from then on.
async function refuseIndexedDbWritesWhenFlagged(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-refuse-idb-writes')) return;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore): IDBRequest {
      this.transaction.abort();
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    };
  });
}

// Every toast text across reloads, so the test can tell none was an error.
async function recordToasts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    new MutationObserver(() => {
      const toast = document.querySelector('.toast');
      if (!toast?.textContent) return;
      const seen = JSON.parse(sessionStorage.getItem('e2e-toasts') || '[]') as string[];
      if (seen[seen.length - 1] === toast.textContent) return;
      seen.push(toast.textContent);
      sessionStorage.setItem('e2e-toasts', JSON.stringify(seen));
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

const STORAGE_NOTE = 'This TV limits how much the app can store.';

async function storageNote(page: Page) {
  await enterTab(page, 'settings');
  await page.locator('[data-settings-target="data"]').click();
  return page.locator('#settings-data #storage-limited-note');
}

async function seedMovieAccount(page: Page): Promise<void> {
  await page.route('**/get.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', (route) => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (action === 'get_vod_categories' || action === 'get_series_categories') {
      return json([{ category_id: '1', category_name: 'Category One' }]);
    }
    if (action === 'get_vod_streams') {
      return json([
        { stream_id: 10, name: 'Movie One', stream_icon: '', container_extension: 'mp4', category_id: '1' },
      ]);
    }
    if (action === 'get_vod_info') {
      return json({ info: { plot: 'Movie plot.', duration_secs: 120 } });
    }
    return json([]);
  });
  await page.route('**/movie/**', (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.addInitScript(() => {
    if (localStorage.getItem('iptv_playlists')) return;
    localStorage.setItem('iptv_playlists', JSON.stringify([{
      id: 'x1',
      name: 'Account One',
      url: 'http://host.example.com:8080',
      source: 'xtream',
      xtream: { username: 'u', password: 'p' },
    }]));
  });
}

test('keeps Continue Watching across a relaunch when IndexedDB refuses writes', async ({ page }) => {
  await refuseIndexedDbWritesWhenFlagged(page);
  await recordToasts(page);
  await seedMovieAccount(page);
  await routeLiveManifest(page);
  await neuterVideo(page);
  // The first launch sets up the database while the disk still has room.
  await page.goto('/');
  await expect(await storageNote(page)).toHaveCount(0);
  await page.evaluate(() => sessionStorage.setItem('e2e-refuse-idb-writes', '1'));
  await page.reload();

  await enterTab(page, 'movies');
  await page.locator('#view-movies .catalog-tile[data-item-id="10"]').first()
    .evaluate((element) => element.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await page.locator('#view-movies [data-action="play"]')
    .evaluate((element) => element.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.locator('#video-player').evaluate((video) => {
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 120 });
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 20 });
  });
  await leaveVod(page);
  await expect(page.locator('#view-movies [data-action="resume"]')).toContainText('Resume 0:20');

  await page.reload();
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies [data-rail-key="continue"] .catalog-tile[data-item-id="10"]'))
    .toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem('iptv_fb_playback-progress')))
    .toContain('resume:x1|vod|10');
  // Settings explains it; nothing raises a toast about it or a save error.
  await expect(await storageNote(page)).toHaveText(new RegExp(`^${STORAGE_NOTE}`));
  const toasts = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('e2e-toasts') || '[]') as string[]);
  expect(toasts.filter(text => text.indexOf('Unable to save') >= 0)).toEqual([]);
  expect(toasts.filter(text => text.indexOf(STORAGE_NOTE) >= 0)).toEqual([]);
});
