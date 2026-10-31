import {
  test,
  expect,
  seedPlaylist,
  pressKeys,
  enterTab,
  routeLiveManifest,
  SAMPLE_M3U,
  type Page,
} from './helpers';

// Home loads no channels, so the first open of Live loads them. Live shows at
// once with its header and a loading state where the rows go, as a slow
// provider on a TV takes seconds.

const press = (page: Page, key: string) => page.keyboard.press(key);
const live = (page: Page) => page.locator('#view-channels');
const status = (page: Page) => live(page).locator('.live-load-status');
const rows = (page: Page) => live(page).locator('.channel-main .channel-item');

// The playlist answers only when released; `fail` answers with a 404, which
// fails at once where a 5xx would retry.
function holdPlaylist(page: Page): { release: () => void; fail: boolean; requests: number } {
  const gate = { release: () => {}, fail: false, requests: 0 };
  let held = new Promise<void>((resolve) => { gate.release = resolve; });
  void page.route('**/playlist.m3u', async (route) => {
    gate.requests++;
    await held;
    held = new Promise<void>((resolve) => { gate.release = resolve; });
    if (gate.fail) {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U });
    }
  });
  return gate;
}

async function openHome(page: Page): Promise<void> {
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-home .focused')).toHaveAttribute('data-section', 'live');
}

// Only the surface with the keys shows a ring: `count` rings on screen.
async function expectRings(page: Page, count: number): Promise<void> {
  await expect.poll(() => page.locator('.focused').evaluateAll((els) => els.filter((el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }).length)).toBe(count);
}

test('Live opens at once with its header and a loading state, then the rows', async ({ page }) => {
  const gate = holdPlaylist(page);
  await openHome(page);
  await press(page, 'Enter');

  await expect(live(page)).toBeVisible();
  await expect(page.locator('#view-home')).toBeHidden();
  await expect(live(page).locator('.live-header-title')).toHaveText('Live');
  await expect(live(page).locator('.live-mode-option.active')).toHaveAttribute('data-live-mode', 'list');
  await expect(live(page).locator('.live-header-clock')).toHaveText(/^\d\d:\d\d$/);
  await expect(status(page)).toHaveText('Loading channels…');
  await expect(status(page).locator('.loading-spinner')).toBeVisible();
  // Nothing to focus yet: no count, no Edit, no rows, no ring.
  await expect(live(page).locator('.live-header-count')).toHaveCount(0);
  await expect(live(page).locator('.live-header-edit')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(0);
  await expectRings(page, 0);
  // Keys while loading do nothing, and the header stays out of reach.
  await press(page, 'ArrowUp');
  await press(page, 'ArrowDown');
  await expectRings(page, 0);
  // Centered under the header, in place of the panes.
  const header = (await live(page).locator('.live-header').boundingBox())!;
  const ring = (await status(page).locator('.loading-spinner').boundingBox())!;
  expect(ring.y).toBeGreaterThan(header.y + header.height);
  expect(ring.x + ring.width / 2).toBeCloseTo(960, -1);

  gate.release();
  await expect(rows(page)).toHaveCount(2);
  await expect(status(page)).toHaveCount(0);
  await expect(live(page).locator('.live-header-count')).toHaveText('2 channels');
  // The header stays put, and the first row has focus.
  expect(await live(page).locator('.live-header').boundingBox()).toEqual(header);
  await expect(rows(page).first()).toHaveClass(/\bfocused\b/);
  await expectRings(page, 1);
  // The header count stands in for the old "channels loaded" toast.
  await expect(page.locator('.toast.visible')).toHaveCount(0);
});

test('Back while Live loads goes Home, and the load does not pull Live back', async ({ page }) => {
  const gate = holdPlaylist(page);
  await openHome(page);
  await press(page, 'Enter');
  await expect(status(page)).toBeVisible();

  await press(page, 'Escape');
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(live(page)).toBeHidden();
  await expect(page.locator('#view-home .focused')).toHaveAttribute('data-section', 'live');
  await expectRings(page, 1);

  gate.release();
  await expect.poll(() => gate.requests).toBe(1);
  await page.waitForTimeout(500);
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(live(page)).toBeHidden();
  await expect(page.locator('#view-home .focused')).toHaveAttribute('data-section', 'live');
  await expectRings(page, 1);

  // The channels are in: Live opens straight onto its rows.
  await press(page, 'Enter');
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).first()).toHaveClass(/\bfocused\b/);
  await expectRings(page, 1);
});

test('a failed load shows the error in Live, and Try again recovers', async ({ page }) => {
  const gate = holdPlaylist(page);
  gate.fail = true;
  await openHome(page);
  await press(page, 'Enter');
  await expect(status(page)).toHaveText('Loading channels…');
  gate.release();

  const retry = status(page).locator('[data-key="live-retry"]');
  await expect(status(page)).toContainText('Unable to load the playlist. Check the URL and try again.');
  await expect(retry).toHaveText('Try again');
  await expect(live(page)).toBeVisible();
  await expect(page.locator('#view-settings')).toBeHidden();
  await expect(retry).toHaveClass(/\bfocused\b/);
  await expectRings(page, 1);
  await press(page, 'ArrowUp');
  await expect(retry).toHaveClass(/\bfocused\b/);
  await expectRings(page, 1);

  gate.fail = false;
  await press(page, 'Enter');
  await expect(status(page)).toHaveText('Loading channels…');
  await expectRings(page, 0);
  gate.release();
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).first()).toHaveClass(/\bfocused\b/);
  await expectRings(page, 1);
});

test('Back from the error goes Home, and Live tries again on the next open', async ({ page }) => {
  const gate = holdPlaylist(page);
  gate.fail = true;
  await openHome(page);
  await press(page, 'Enter');
  gate.release();
  await expect(status(page).locator('[data-key="live-retry"]')).toBeVisible();

  await press(page, 'Escape');
  await expect(page.locator('#view-home .focused')).toHaveAttribute('data-section', 'live');
  await expectRings(page, 1);

  gate.fail = false;
  await press(page, 'Enter');
  await expect(status(page)).toHaveText('Loading channels…');
  gate.release();
  await expect(rows(page)).toHaveCount(2);
  expect(gate.requests).toBe(2);
});

test('the Guide opened from Home with Red shows the same loading state', async ({ page }) => {
  const gate = holdPlaylist(page);
  await openHome(page);
  await pressKeys(page, 403);

  await expect(live(page)).toBeVisible();
  await expect(live(page).locator('.live-mode-option.active')).toHaveAttribute('data-live-mode', 'guide');
  await expect(status(page)).toHaveText('Loading channels…');
  await expectRings(page, 0);

  gate.release();
  await expect(page.locator('#view-channels.live-guide-mode #live-guide .guide-cell').first()).toBeVisible();
  await expect(status(page)).toHaveCount(0);
  await expectRings(page, 1);
});

test('a channel number typed on Home shows Live loading, then plays the channel', async ({ page }) => {
  const gate = holdPlaylist(page);
  await routeLiveManifest(page);
  await openHome(page);
  await press(page, '2');

  await expect(status(page)).toHaveText('Loading channels…');
  gate.release();
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#player-osd .osd-channel-name')).toContainText('Channel Two');
  // Playback typed on Home still returns there.
  await press(page, 'Escape');
  if (await page.locator('#view-player').isVisible()) await press(page, 'Escape');
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(live(page)).toBeHidden();
});

test('a click on the Live card shows the loading state, and the first key shows the ring', async ({ page }) => {
  const gate = holdPlaylist(page);
  await openHome(page);
  await enterTab(page, 'live');
  await expect(status(page)).toHaveText('Loading channels…');

  gate.release();
  await expect(rows(page)).toHaveCount(2);
  await expectRings(page, 0);
  await press(page, 'ArrowDown');
  await expect(rows(page).first()).toHaveClass(/\bfocused\b/);
  await expectRings(page, 1);
});

// Search and Settings opened before the channels load show at once, like
// Live, rather than waiting behind Home with the load out of sight.

const search = (page: Page) => page.locator('#view-search');
const searchLoading = (page: Page) => search(page).locator('[data-search-busy="channels"]');
const settings = (page: Page) => page.locator('#view-settings');

test('Search opens at once while the channels load, and searches them once they do', async ({ page }) => {
  const gate = holdPlaylist(page);
  await openHome(page);
  await enterTab(page, 'search');

  await expect(search(page)).toBeVisible();
  await expect(page.locator('#view-loading')).toBeHidden();
  await expect(searchLoading(page)).toHaveText('Loading channels…');
  await expect(page.locator('.search-box-input')).toBeFocused();
  await page.locator('.search-box-input').fill('two');
  await expect(searchLoading(page)).toBeVisible();

  gate.release();
  await expect(searchLoading(page)).toHaveCount(0);
  await expect(search(page).locator('.search-results')).toContainText('Channel Two');
});

test('Back while Search loads goes Home, and the load does not pull Search back', async ({ page }) => {
  const gate = holdPlaylist(page);
  await openHome(page);
  await enterTab(page, 'search');
  await expect(searchLoading(page)).toBeVisible();

  await pressKeys(page, 461);
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(search(page)).toBeHidden();

  gate.release();
  await expect.poll(() => gate.requests).toBe(1);
  await page.waitForTimeout(500);
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(search(page)).toBeHidden();
});

test('Settings opens at once while the channels load; only what needs them waits', async ({ page }) => {
  const gate = holdPlaylist(page);
  await openHome(page);
  await enterTab(page, 'settings');

  await expect(settings(page)).toBeVisible();
  await expect(page.locator('#view-home')).toBeHidden();
  await expect(page.locator('#view-loading')).toBeHidden();
  await expect(settings(page).locator('#app-language')).toBeVisible();
  // The playlist's own guide source and the health check need the channels.
  await settings(page).locator('[data-settings-target="guide"]').click();
  const editor = settings(page).locator('.epg-offset-editor');
  await expect(editor.locator('.settings-channels-loading')).toHaveText('Loading channels…');
  await settings(page).locator('[data-settings-target="sources"]').click();
  const health = settings(page).locator('.channel-health-panel');
  await expect(health.locator('.settings-channels-loading')).toHaveText('Loading channels…');
  await expect(health.locator('#check-channel-health')).toHaveCount(0);

  gate.release();
  await expect(health.locator('#check-channel-health')).toBeVisible();
  await settings(page).locator('[data-settings-target="guide"]').click();
  await expect(editor.locator('.settings-channels-loading')).toHaveCount(0);
  await expect(editor.locator('#epg-offset-source')).toBeVisible();
});

// Before its channels load every reminder looks orphaned; counting them then
// would prune them all.
test('Settings keeps reminders while its channels load, then counts them', async ({ page }) => {
  const gate = holdPlaylist(page);
  await page.addInitScript(() => {
    const url = 'http://streams.example.com/one.m3u8';
    let h = 0x811c9dc5;
    for (let i = 0; i < url.length; i++) { h ^= url.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    const now = Date.now();
    localStorage.setItem('iptv_reminders', JSON.stringify([{
      // No padStart: the init script runs with Chromium 53's APIs in the simulation.
      channelKey: `0000000${(h >>> 0).toString(16)}`.slice(-8), channelName: 'Channel One',
      title: 'Alpha', startMs: now + 3600_000, stopMs: now + 7200_000,
    }]));
  });
  await openHome(page);
  await enterTab(page, 'settings');
  await settings(page).locator('[data-settings-target="guide"]').click();
  const entry = settings(page).locator('.reminders-item');
  await expect(entry.locator('.settings-channels-loading')).toHaveText('Loading channels…');
  await expect(entry.locator('#manage-reminders')).toHaveCount(0);

  gate.release();
  await expect(entry.locator('#manage-reminders')).toContainText('(1)');
});

test('Save while Settings waits for the channels saves once they load', async ({ page }) => {
  const gate = holdPlaylist(page);
  await openHome(page);
  await enterTab(page, 'settings');
  await settings(page).locator('[data-settings-target="appearance"]').click();
  await settings(page).locator('.theme-swatch[data-theme-id="arctic"]').click();
  await settings(page).locator('#save-settings').click();
  await expect(page.locator('.toast.visible')).toContainText('Loading channels…');
  await expect(settings(page)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('iptv_theme'))).not.toBe('"arctic"');

  gate.release();
  await expect(page.locator('#view-home')).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('iptv_theme'))).toBe('"arctic"');
});

test('Back while Settings loads goes Home, and the load does not pull Settings back', async ({ page }) => {
  const gate = holdPlaylist(page);
  await openHome(page);
  await pressKeys(page, 406);
  await expect(settings(page)).toBeVisible();
  await expect(page.locator('#view-home')).toBeHidden();

  await pressKeys(page, 461);
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(settings(page)).toBeHidden();

  gate.release();
  await expect.poll(() => gate.requests).toBe(1);
  await page.waitForTimeout(500);
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(settings(page)).toBeHidden();
});
