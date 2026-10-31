import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { test, expect, enterTab, liveAfterSave, type Page, openGuide } from './helpers';

// Opened from Home's Live card after every load (see `startOn`).
test.use({ startOn: 'live' });

// Drives the real app against the demo Xtream server (scripts/xtream-demo-server.mjs)
// with real, locally generated media. Needs ffmpeg; the first run encodes the
// shared clips into .cache/xtream-demo/, so allow it time.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

let demo: ChildProcess | null = null;
let origin = '';

// Start the CLI on an ephemeral port and read the URL it prints.
function startDemo(): Promise<string> {
  const child = spawn(process.execPath, [
    'scripts/xtream-demo-server.mjs', '--port', '0', '--host', '127.0.0.1',
    '--username', 'u1', '--password', 'p1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  demo = child;
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /Server URL: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) resolve(match[1]);
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.once('exit', code => reject(new Error(`demo server exited (${code}): ${output}`)));
  });
}

test.beforeAll(async () => {
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  test.skip(ffmpeg.status !== 0, 'ffmpeg is not installed');
  test.setTimeout(600_000);
  origin = await startDemo();
});

test.afterAll(() => {
  demo?.kill();
  demo = null;
});

async function seedAccount(page: Page): Promise<void> {
  await page.addInitScript((url) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{
      id: 'demo1', name: 'Demo', url, source: 'xtream',
      xtream: { username: 'u1', password: 'p1', liveOutput: 'm3u8' },
    }]));
  }, origin);
}

async function expectPlaying(page: Page): Promise<void> {
  const video = page.locator('#video-player');
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2);
  const before = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime), { timeout: 15_000 })
    .toBeGreaterThan(before + 1);
}

// Open a track picker from its control, which appears once the stream offers
// a choice; the controls show again on Yellow if they hid meanwhile.
async function openPicker(page: Page, control: 'audio' | 'subtitles'): Promise<void> {
  const button = page.locator(`#player-osd [data-dock-action="${control}"]`);
  await expect(async () => {
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })));
    await expect(button).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await button.click();
  await expect(page.locator('#player-menu')).toHaveClass(/visible/);
}

test('adds the demo server in Settings and loads live channels with a guide', async ({ page }) => {
  await page.goto('/');
  // A first run opens Settings on General (see `startOn`); accounts live on
  // the Sources page.
  await page.locator('[data-settings-target="sources"]').click({ timeout: 20_000 });
  await page.waitForSelector('#add-xtream', { timeout: 20_000 });
  await page.click('#add-xtream');
  const card = page.locator('#xtream-entries .xtream-card').first();
  await card.locator('.xtream-url').fill(origin);
  await card.locator('.xtream-username').fill('u1');
  await card.locator('.xtream-password').fill('p1');
  await page.click('#save-settings');

  await liveAfterSave(page);
  const first = page.locator('.channel-main .channel-item').first();
  await expect(first).toContainText('Alpha');
  await expect(first.locator('.channel-now')).toContainText(/Program \d+/);
  await expect(page.locator('[data-group="source:Group 1"]')).toBeVisible();

  await openGuide(page);
  await expect(page.locator('#live-guide')).toContainText(/Program \d+/);
});

test('lists the Movies and Series catalogs', async ({ page }) => {
  await seedAccount(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies .catalog-rail-title').first()).toContainText('Group 1');
  await expect(page.locator('#view-movies .catalog-tile[data-item-id="10001"]')).toContainText('Movie A');

  await enterTab(page, 'series');
  await expect(page.locator('#view-series .catalog-tile[data-item-id="5001"]')).toContainText('Series A');
});

test('plays a movie', async ({ page }) => {
  await seedAccount(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');
  const tile = page.locator('#view-movies .catalog-tile[data-item-id="10002"]');
  await expect(tile).toBeVisible();
  await tile.evaluate(el => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('Movie B');
  await page.locator('[data-action="play"]')
    .evaluate(el => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await expectPlaying(page);
});

test('plays a live channel with audio-track and subtitle options', async ({ page }) => {
  await seedAccount(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await page.locator('.channel-main .channel-item').first().click();
  await expect(page.locator('#view-player')).toBeVisible();
  await expectPlaying(page);

  await openPicker(page, 'audio');
  const audio = page.locator('#player-menu .menu-item[data-menu-action="__audio_track__"]');
  await expect(audio).toHaveText([/Track 1/, /Track 2/]);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#player-menu')).not.toHaveClass(/visible/);

  await openPicker(page, 'subtitles');
  await expect(page.locator('#player-menu .menu-item[data-menu-action="__subs_track__"][data-track-index="0"]'))
    .toContainText('Track 3');
});
