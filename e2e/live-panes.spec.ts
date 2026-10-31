import {
  test,
  expect,
  routeLiveManifest,
  routePlaylist,
  type Page,
} from './helpers';

// Opened from Home's Live card after every load (see `startOn`).
test.use({ startOn: 'live' });

// Live: a header over three panes (groups | rows | preview), with the Guide
// inside Live behind a List | Guide switch (e2e/live-guide.spec.ts).

const LONG_NAME = 'Channel 3 with an exceptionally long synthetic name that keeps going to test truncation';
const CHANNELS = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="ch1" group-title="Group 1",ch1',
  'http://host/ch1.m3u8',
  '#EXTINF:-1 tvg-id="ch2" group-title="Group 1",ch2',
  'http://host/ch2.m3u8',
  `#EXTINF:-1 tvg-id="ch3" group-title="Group 2",${LONG_NAME}`,
  'http://host/ch3.m3u8',
].join('\n');
const EPG = `<tv>
  <channel id="ch1"><display-name>ch1</display-name></channel>
  <programme channel="ch1" start="20260915110000 +0000" stop="20260915130000 +0000">
    <title>Program 1</title><desc>Synthetic description</desc></programme>
  <programme channel="ch1" start="20260915130000 +0000" stop="20260915140000 +0000">
    <title>Program 2</title></programme>
  <programme channel="ch1" start="20260915140000 +0000" stop="20260915150000 +0000">
    <title>Program 3</title></programme>
</tv>`;
const ROW = '#channel-browser .channel-main .channel-item';
const HEADER = '.live-header';
const PREVIEW_NAME = '#live-preview .live-preview-channel';
const KEY = { up: 38, down: 40, left: 37, right: 39, ok: 13, back: 461, red: 403 } as const;

test.use({ timezoneId: 'UTC' });

async function setup(page: Page): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-09-15T12:00:00Z'));
  await routePlaylist(page, CHANNELS);
  await routeLiveManifest(page);
  await page.route('http://host/guide.xml', route => route.fulfill({
    contentType: 'application/xml', body: EPG,
  }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'p1', name: 'P1', url: 'http://host/playlist.m3u' },
    ]));
    localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/guide.xml', playlistIds: [] }]));
    localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
    // Native Chromium cannot decode the synthetic stream; the preview's
    // retune is what these tests watch, through the DOM.
    const proto = HTMLMediaElement.prototype;
    proto.load = function () { /* no-op */ };
    proto.play = function () {
      Promise.resolve().then(() => this.dispatchEvent(new Event('playing')));
      return Promise.resolve();
    };
    document.addEventListener('error', event => {
      if (event.isTrusted && event.target instanceof HTMLMediaElement) event.stopImmediatePropagation();
    }, true);
  });
  await page.goto('/');
  await expect(page.locator(ROW)).toHaveCount(3);
  await expect(page.locator(`${ROW}[data-channel-index="0"] .channel-now`)).toHaveText('Program 1');
}

async function press(page: Page, ...keys: (keyof typeof KEY)[]): Promise<void> {
  for (const key of keys) {
    await page.evaluate(code => document.dispatchEvent(
      new KeyboardEvent('keydown', { keyCode: code, bubbles: true })), KEY[key]);
  }
}

const focusedKey = (page: Page) => page.evaluate(() =>
  Array.from(document.querySelectorAll<HTMLElement>('.focused'))
    .filter(el => el.getBoundingClientRect().width > 0)
    .map(el => el.dataset.key ?? el.className));

test('Live shows the header, the groups, rich rows, and the preview in three panes', async ({ page }) => {
  await setup(page);
  const header = page.locator(`#view-channels ${HEADER}`);
  await expect(header.locator('.live-header-title')).toHaveText('Live');
  await expect(header.locator('.live-header-count')).toHaveText('3 channels');
  await expect(header.locator('[data-live-mode="list"]')).toHaveClass(/active/);
  await expect(header.locator('.live-header-clock')).toHaveText('12:00');

  const first = page.locator(`${ROW}[data-channel-index="0"]`);
  await expect(first.locator('.live-row-progress > div')).toHaveAttribute('style', /width:50%/);
  await expect(first.locator('.live-row-next')).toHaveText(/13:00\s*Program 2/);
  await expect(page.locator('#channel-browser .group-item .group-icon svg').first()).toBeVisible();
  await expect(page.locator('.live-legend')).toContainText('Watch');
  // The preview has no controls, so the legend offers none.
  await expect(page.locator('.live-legend')).not.toContainText('Preview controls');
  await expect(page.locator('#live-preview [data-focusable], #live-preview button')).toHaveCount(0);

  // The preview follows focus once it rests: three panes left to right, inside the gutters.
  await expect(page.locator(PREVIEW_NAME)).toHaveText('ch1');
  const boxes = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return {
      group: box('#channel-browser .group-item'),
      row: box('#channel-browser .channel-item'),
      slot: box('#live-preview .live-preview-slot'),
      title: box('.live-header-title'),
      clock: box('.live-header-clock'),
    };
  });
  expect(boxes.group.left).toBeGreaterThanOrEqual(80);
  expect(boxes.title.left).toBe(80);
  expect(boxes.clock.right).toBeCloseTo(1840, 0);
  expect(boxes.group.right).toBeLessThanOrEqual(boxes.row.left);
  expect(boxes.row.right).toBeLessThanOrEqual(boxes.slot.left);
  expect(boxes.slot.right).toBeCloseTo(1840, 0);
  expect(boxes.slot.height / boxes.slot.width).toBeCloseTo(9 / 16, 2);
});

test('the preview retunes only after focus rests on a row', async ({ page }) => {
  await setup(page);
  await expect(page.locator(PREVIEW_NAME)).toHaveText('ch1');
  await press(page, 'down', 'down');
  // Passing through ch2 never tunes it.
  await page.waitForTimeout(300);
  await expect(page.locator(PREVIEW_NAME)).toHaveText('ch1');
  await expect(page.locator(PREVIEW_NAME)).toHaveText(LONG_NAME);
});

test('the D-pad crosses groups, rows, and the header with one ring at a time', async ({ page }) => {
  await setup(page);
  await expect(page.locator(PREVIEW_NAME)).toHaveText('ch1');
  expect(await focusedKey(page)).toEqual(['ch:0']);
  await press(page, 'left');
  expect(await focusedKey(page)).toEqual(['g:builtin:all']);
  await press(page, 'right');
  expect(await focusedKey(page)).toEqual(['ch:0']);
  // The preview takes no focus: Right from a row stays on it.
  await press(page, 'right');
  expect(await focusedKey(page)).toEqual(['ch:0']);
  // Up from the top row and from the top group reach the switch.
  await press(page, 'up');
  expect(await focusedKey(page)).toEqual(['live-mode:list']);
  await press(page, 'down');
  expect(await focusedKey(page)).toEqual(['ch:0']);
  await press(page, 'up');
  expect(await focusedKey(page)).toEqual(['live-mode:list']);
  await press(page, 'down', 'left', 'up');
  expect(await focusedKey(page)).toEqual(['live-mode:list']);
  await press(page, 'left');
  expect(await focusedKey(page)).toEqual(['live-edit']);
  await press(page, 'back');
  expect((await focusedKey(page))[0]).toMatch(/^g:/);
});

test('OK watches full screen and Back returns to Live with the row marked', async ({ page }) => {
  await setup(page);
  await expect(page.locator(PREVIEW_NAME)).toHaveText('ch1');
  await press(page, 'down', 'ok');
  await expect(page.locator('#view-player')).toBeVisible();
  await press(page, 'back');
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator(`${ROW}[data-channel-index="1"] .live-badge-watching`)).toBeVisible();
  await expect(page.locator(PREVIEW_NAME)).toHaveText('ch2');
  await expect(page.locator(`${ROW} .live-badge-watching`)).toHaveCount(1);
});

test('a long channel name ellipsizes inside its row', async ({ page }) => {
  await setup(page);
  const name = page.locator(`${ROW}[data-channel-index="2"] .channel-name`);
  const fit = await name.evaluate(el => ({
    clipped: el.scrollWidth > el.clientWidth,
    overflow: getComputedStyle(el).textOverflow,
    rowRight: el.closest('.channel-item')!.getBoundingClientRect().right,
    right: el.getBoundingClientRect().right,
  }));
  expect(fit.clipped).toBe(true);
  expect(fit.overflow).toBe('ellipsis');
  expect(fit.right).toBeLessThanOrEqual(fit.rowRight);
});

// Flex gap is missing on webOS 4: its generated margins must space the
// header, the rows, and the legend as the modern engine does.
test('the header, the rows, and the legend keep their spacing on every engine', async ({ page }) => {
  await setup(page);
  await expect(page.locator(PREVIEW_NAME)).toHaveText('ch1');
  const gaps = await page.evaluate(() => {
    const between = (a: Element | null, b: Element | null) =>
      Math.round(b!.getBoundingClientRect().left - a!.getBoundingClientRect().right);
    const hints = document.querySelectorAll('.live-legend .edit-hint');
    const row = document.querySelector('.channel-item[data-channel-index="0"]');
    return {
      legend: between(hints[0], hints[1]),
      toggleToClock: between(document.querySelector('.live-mode-toggle'), document.querySelector('.live-header-clock')),
      editToToggle: between(document.querySelector('.live-header-edit'), document.querySelector('.live-mode-toggle')),
      numberToLogo: between(row?.querySelector('.channel-number') ?? null, row?.querySelector('.channel-logo-wrap') ?? null),
      logoToInfo: between(row?.querySelector('.channel-logo-wrap') ?? null, row?.querySelector('.channel-info') ?? null),
    };
  });
  expect(gaps).toEqual({ legend: 36, toggleToClock: 40, editToToggle: 20, numberToLogo: 18, logoToInfo: 18 });
});

test('editing from the header closes the preview without marking a row watched', async ({ page }) => {
  await setup(page);
  await expect(page.locator(PREVIEW_NAME)).toHaveText('ch1');
  await press(page, 'up', 'left');
  expect(await focusedKey(page)).toEqual(['live-edit']);
  await press(page, 'ok');
  await expect(page.locator('#channel-browser .channel-view.editing')).toHaveCount(1);
  await expect(page.locator(`${ROW} .live-badge-watching`)).toHaveCount(0);
});

// Regression: a click on the header left its lit button and the content's
// ring both on screen.
test('a header click leaves one ring, and the first key shows the content', async ({ page }) => {
  await setup(page);
  await page.locator(`${HEADER} [data-edit-channels]`).click();
  await expect(page.locator('#channel-browser .channel-view.editing')).toHaveCount(1);
  expect((await focusedKey(page)).length).toBeLessThanOrEqual(1);
  await page.keyboard.press('ArrowDown');
  const rings = await focusedKey(page);
  expect(rings).toHaveLength(1);
  expect(rings[0]).not.toBe('live-edit');
  await page.keyboard.press('Escape');
  await expect(page.locator('#channel-browser .channel-view.editing')).toHaveCount(0);

  await page.locator(`${HEADER} [data-live-mode="guide"]`).click();
  await expect(page.locator('#view-channels.live-guide-mode #live-guide .guide-cell').first()).toBeVisible();
  const guideRings = await focusedKey(page);
  expect(guideRings.length).toBeLessThanOrEqual(1);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#live-guide .guide-cell.focused')).toHaveCount(1);
  expect(await focusedKey(page)).toHaveLength(1);
});
