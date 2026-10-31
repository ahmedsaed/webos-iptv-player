import {
  test,
  expect,
  openGuide,
  pressKeys,
  routeLiveManifest,
  routePlaylist,
  type Page,
} from './helpers';

// Opened from Home's Live card after every load (see `startOn`).
test.use({ startOn: 'live' });

// The Guide inside Live: the groups column, the header, and a time grid of
// two and a half hours; Left and Right move through time, Up and Down
// through channels, and OK watches, reminds, or plays catch-up.

const CHANNELS = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="ch1" group-title="Group 1" catchup="default" '
    + 'catchup-source="http://host/catchup.m3u8?start={utc}&end={utcend}" catchup-days="3",ch1',
  'http://host/ch1.m3u8',
  '#EXTINF:-1 tvg-id="ch2" group-title="Group 1",ch2',
  'http://host/ch2.m3u8',
  '#EXTINF:-1 tvg-id="ch3" group-title="Group 2",ch3',
  'http://host/ch3.m3u8',
].join('\n');
const EPG = `<tv>
  <channel id="ch1"><display-name>ch1</display-name></channel>
  <channel id="ch2"><display-name>ch2</display-name></channel>
  <programme channel="ch1" start="20260915100000 +0000" stop="20260915110000 +0000"><title>Program 0</title></programme>
  <programme channel="ch1" start="20260915110000 +0000" stop="20260915123000 +0000"><title>Program 1</title></programme>
  <programme channel="ch1" start="20260915123000 +0000" stop="20260915130000 +0000"><title>Program 2</title></programme>
  <programme channel="ch1" start="20260915130000 +0000" stop="20260915140000 +0000"><title>Program 3</title></programme>
  <programme channel="ch2" start="20260915113000 +0000" stop="20260915123000 +0000"><title>Program 4</title></programme>
  <programme channel="ch2" start="20260915123000 +0000" stop="20260915133000 +0000"><title>Program 5</title></programme>
</tv>`;
const KEY = { up: 38, down: 40, left: 37, right: 39, ok: 13, back: 461, red: 403 } as const;
const at = (hhmm: string) => Date.parse(`2026-09-15T${hhmm}:00Z`);
const CELL = '#live-guide .guide-cell';

test.use({ timezoneId: 'UTC' });

async function setup(page: Page): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-09-15T12:00:00Z'));
  await routePlaylist(page, CHANNELS);
  await routeLiveManifest(page);
  await page.route('**/catchup.m3u8**', route => route.fulfill({
    contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-ENDLIST\n',
  }));
  await page.route('http://host/guide.xml', route => route.fulfill({
    contentType: 'application/xml', body: EPG,
  }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'p1', name: 'P1', url: 'http://host/playlist.m3u' },
    ]));
    localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/guide.xml', playlistIds: [] }]));
    localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
    const proto = HTMLMediaElement.prototype;
    proto.load = function () { /* no-op */ };
    proto.play = function () { return Promise.resolve(); };
    document.addEventListener('error', event => {
      if (event.isTrusted && event.target instanceof HTMLMediaElement) event.stopImmediatePropagation();
    }, true);
  });
  await page.goto('/');
  await expect(page.locator('#channel-browser .channel-item')).toHaveCount(3);
  await openGuide(page);
}

const press = (page: Page, ...keys: (keyof typeof KEY)[]) => pressKeys(page, ...keys.map(key => KEY[key]));

const focused = (page: Page) => page.evaluate(() =>
  Array.from(document.querySelectorAll<HTMLElement>('.focused'))
    .filter(el => el.getBoundingClientRect().width > 0)
    .map(el => el.dataset.key ?? el.className));

const cellKey = (row: number, hhmm: string) => `cell:${row}:${at(hhmm)}`;
const times = (page: Page) => page.locator('#live-guide .guide-time').allTextContents();

test('Red opens the Guide beside the groups, on the current time', async ({ page }) => {
  await setup(page);
  await expect(page.locator('.live-header [data-live-mode="guide"]')).toHaveClass(/active/);
  await expect(page.locator('#view-channels')).toHaveAttribute('data-backdrop', 'epg');
  await expect(page.locator('#channel-browser .group-item').first()).toBeVisible();
  await expect(page.locator('#live-preview')).toBeHidden();
  expect(await times(page)).toEqual(['11:30', '12:00', '12:30', '13:00', '13:30']);
  await expect(page.locator('#live-guide .guide-now-pill')).toHaveText('12:00');
  expect(await focused(page)).toEqual([cellKey(0, '11:00')]);
  await expect(page.locator('#live-guide .guide-legend')).toContainText('Earlier and later');

  // The grid keeps the gutters and sits right of the groups.
  const boxes = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return { group: box('#channel-browser .group-item'), guide: box('#live-guide .guide'), first: box('#live-guide .guide-cells') };
  });
  expect(boxes.group.left).toBeGreaterThanOrEqual(80);
  expect(boxes.guide.left).toBeGreaterThanOrEqual(boxes.group.right);
  expect(boxes.first.right).toBeCloseTo(1840, 0);

  await press(page, 'red');
  await expect(page.locator('#channel-browser .channel-main .channel-item')).toHaveCount(3);
  await expect(page.locator('#view-channels')).toHaveAttribute('data-backdrop', 'live');
});

// Regression: a solid now line hid the letters of the titles it crossed.
test('the now line runs over the cells, dimmed, under a solid time pill', async ({ page }) => {
  await setup(page);
  const line = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#live-guide .guide-now-line i')!;
    const box = el.getBoundingClientRect();
    const host = document.querySelector<HTMLElement>('#live-guide .guide-now-line')!;
    el.style.pointerEvents = 'auto';
    host.style.pointerEvents = 'auto';
    const onTop: boolean[] = [];
    // The focused cell keeps its ring above the line.
    for (const cell of Array.from(document.querySelectorAll<HTMLElement>('#live-guide .guide-cell:not(.focused)'))) {
      const c = cell.getBoundingClientRect();
      if (c.left > box.left || c.right < box.right) continue;
      const hit = document.elementFromPoint(box.left + 1, c.top + c.height / 2);
      onTop.push(hit === el);
    }
    el.style.pointerEvents = '';
    host.style.pointerEvents = '';
    // How opaque the line paints: its own opacity times its color's alpha.
    const alpha = (node: Element) => {
      const color = getComputedStyle(node).backgroundColor;
      const parts = color.match(/[\d.]+/g) ?? [];
      return parts.length === 4 ? parseFloat(parts[3]) : 1;
    };
    let opacity = alpha(el);
    for (let node: Element | null = el; node; node = node.parentElement) {
      opacity *= parseFloat(getComputedStyle(node).opacity);
    }
    const pill = document.querySelector<HTMLElement>('#live-guide .guide-now-pill')!;
    let pillOpacity = alpha(pill);
    for (let node: Element | null = pill; node; node = node.parentElement) {
      pillOpacity *= parseFloat(getComputedStyle(node).opacity);
    }
    return { onTop, opacity, pillOpacity };
  });
  expect(line.onTop.length).toBeGreaterThan(0);
  expect(line.onTop.every(Boolean)).toBe(true);
  expect(line.opacity).toBeGreaterThan(0.3);
  expect(line.opacity).toBeLessThanOrEqual(0.6);
  expect(line.pillOpacity).toBe(1);
});

test('the D-pad moves through time and channels with one ring per step', async ({ page }) => {
  await setup(page);
  await press(page, 'right');
  expect(await focused(page)).toEqual([cellKey(0, '12:30')]);
  await press(page, 'right');
  expect(await focused(page)).toEqual([cellKey(0, '13:00')]);
  await press(page, 'down');
  expect(await focused(page)).toEqual([cellKey(1, '12:30')]);
  await press(page, 'up');
  expect(await focused(page)).toEqual([cellKey(0, '13:00')]);
  // Past the window's end, focus pages it on by half hours.
  await press(page, 'right');
  expect(await focused(page)).toEqual([`cell:0:e${at('14:00')}`]);
  expect((await times(page))[0]).toBe('13:30');
  await press(page, 'left', 'left', 'left');
  expect(await focused(page)).toEqual([cellKey(0, '11:00')]);
  // Up from the first row reaches the header; Down comes back.
  await press(page, 'up');
  expect(await focused(page)).toEqual(['live-mode:guide']);
  await press(page, 'down');
  expect(await focused(page)).toEqual([cellKey(0, '11:00')]);
});

test('Left goes into the past on a catch-up channel, and to the groups on others', async ({ page }) => {
  await setup(page);
  await press(page, 'down');
  expect(await focused(page)).toEqual([cellKey(1, '11:30')]);
  await press(page, 'left');
  expect(await focused(page)).toEqual(['g:builtin:all']);
  await press(page, 'right');
  expect(await focused(page)).toEqual([cellKey(1, '11:30')]);
  await press(page, 'up', 'left');
  expect(await focused(page)).toEqual([cellKey(0, '10:00')]);
  expect((await times(page))[0]).toBe('10:00');
  // Back is a shortcut to the groups too.
  await press(page, 'back');
  expect(await focused(page)).toEqual(['g:builtin:all']);
});

test('the groups column picks the channels the Guide shows', async ({ page }) => {
  await setup(page);
  await press(page, 'back', 'down', 'down', 'down', 'down', 'ok');
  await expect(page.locator('#live-guide .guide-row')).toHaveCount(1);
  await expect(page.locator('#live-guide .guide-name')).toHaveText('ch3');
  await expect(page.locator(`${CELL}`).first()).toContainText('No program information available.');
  await press(page, 'right');
  expect((await focused(page))[0]).toMatch(/^cell:2:e/);
  // The list keeps the group when Live switches back.
  await press(page, 'red');
  await expect(page.locator('#channel-browser .channel-main .channel-item')).toHaveCount(1);
});

test('OK on a live program watches it, and Back returns to the Guide', async ({ page }) => {
  await setup(page);
  await press(page, 'down', 'ok');
  await expect(page.locator('#view-player')).toBeVisible();
  await press(page, 'back');
  await expect(page.locator('#view-channels.live-guide-mode')).toBeVisible();
  await expect(page.locator('#live-guide .guide-channel.watching .guide-name')).toHaveText('ch2');
  await expect(page.locator('#live-preview')).toBeHidden();
  expect(await focused(page)).toEqual([cellKey(1, '11:30')]);
});

test('OK on a future program sets its reminder, and OK again clears it', async ({ page }) => {
  await setup(page);
  await press(page, 'right', 'ok');
  await expect(page.locator('.toast')).toContainText('Reminder set');
  await expect(page.locator(`${CELL}[data-key="${cellKey(0, '12:30')}"]`)).toHaveClass(/reminder/);
  await expect(page.locator(`${CELL}[data-key="${cellKey(0, '12:30')}"] .epg-bell-glyph`)).toBeVisible();
  await press(page, 'ok');
  await expect(page.locator('.toast')).toContainText('Reminder removed');
  await expect(page.locator(`${CELL}[data-key="${cellKey(0, '12:30')}"]`)).not.toHaveClass(/reminder/);
  await expect(page.locator('#view-player')).toBeHidden();
});

test('OK on a past program plays its catch-up', async ({ page }) => {
  await setup(page);
  const catchup = page.waitForRequest(request => request.url().includes('catchup.m3u8'));
  await press(page, 'left', 'ok');
  await expect(page.locator('#view-player')).toBeVisible();
  expect((await catchup).url()).toContain(`start=${at('10:00') / 1000}`);
});

test('the pointer lights a cell and a click acts on it', async ({ page }) => {
  await setup(page);
  const future = page.locator(`${CELL}[data-key="${cellKey(1, '12:30')}"]`);
  const box = (await future.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(future).toHaveClass(/focused/);
  await future.click();
  await expect(page.locator('.toast')).toContainText('Reminder set');
});
