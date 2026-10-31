import {
  liveAfterSave,
  test,
  expect,
  enterTab,
  LIVE_MANIFEST,
  routeLiveManifest,
  routePlaylist,
  type Page,
} from './helpers';
import { THEMES, TEXT_SIZES } from '../src/config/themes';

// Opened from Home's Live card after every load (see `startOn`).
test.use({ startOn: 'live' });

const CHANNELS = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="ch1" group-title="Group 1",ch1',
  'http://host/ch1.m3u8',
  '#EXTINF:-1 tvg-id="ch2" group-title="Group 1",ch2',
  'http://host/ch2.m3u8',
].join('\n');
const EPG = `<tv>
  <channel id="ch1"><display-name>ch1</display-name></channel>
  ${[11, 13, 14, 15, 16].map((hour, index) =>
    `<programme channel="ch1" start="20260915${hour}0000 +0000"
      stop="20260915${index === 0 ? 13 : hour + 1}0000 +0000">
      <title>Program ${index + 1}</title></programme>`).join('')}
</tv>`;
const LONG_TITLE = 'Program 1: A long journey across quiet valleys and distant hills';
const LAYOUT_EPG = `<tv>
  <channel id="ch1"><display-name>ch1</display-name></channel>
  <programme channel="ch1" start="20260915231500 +0000" stop="20260916001500 +0000">
    <title>${LONG_TITLE}</title></programme>
  ${[0, 1, 2, 3].map(hour =>
    `<programme channel="ch1" start="202609160${hour}1500 +0000" stop="202609160${hour + 1}1500 +0000">
      <title>Program ${hour + 2}: A long exploration of winding paths beyond the distant hills and valleys</title>
    </programme>`).join('')}
</tv>`;
const PANEL = '#view-channels #live-preview';
const ROW = '#channel-browser .channel-main .channel-item';

interface MediaProbe {
  video: HTMLMediaElement | null;
  loads: number;
  pauses: number;
  plays: number;
}
type ProbeWindow = Window & { previewProbe: MediaProbe };

test.use({ timezoneId: 'UTC' });

async function setup(
  page: Page,
  options: {
    stub?: boolean; epg?: boolean | string; now?: string; playlist?: string;
    // Routes that take precedence over the default manifest route.
    routes?: () => Promise<void>;
  } = {},
): Promise<void> {
  await page.clock.setFixedTime(new Date(options.now || '2026-09-15T12:00:00Z'));
  await routePlaylist(page, options.playlist ?? CHANNELS);
  await routeLiveManifest(page);
  await options.routes?.();
  await page.route('http://host/guide.xml', route => route.fulfill({
    contentType: 'application/xml',
    body: typeof options.epg === 'string' ? options.epg : options.epg ? EPG : '<tv></tv>',
  }));
  await page.addInitScript(({ stub }) => {
    if (!sessionStorage.getItem('preview-seeded')) {
      localStorage.setItem('iptv_playlists', JSON.stringify([
        { id: 'p1', name: 'P1', url: 'http://host/playlist.m3u' },
      ]));
      localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/guide.xml', playlistIds: [] }]));
      localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
      sessionStorage.setItem('preview-seeded', 'true');
    }
    const probe: MediaProbe = { video: null, loads: 0, pauses: 0, plays: 0 };
    (window as unknown as ProbeWindow).previewProbe = probe;
    const proto = HTMLMediaElement.prototype;
    const nativeLoad = proto.load;
    const nativePause = proto.pause;
    const nativePlay = proto.play;
    let paused = true;
    proto.load = function () {
      probe.video = probe.video || this;
      probe.loads++;
      if (!stub) nativeLoad.call(this);
    };
    proto.pause = function () {
      probe.pauses++;
      paused = true;
      if (!stub) nativePause.call(this);
    };
    proto.play = function () {
      probe.plays++;
      if (!stub) return nativePlay.call(this);
      paused = false;
      Promise.resolve().then(() => {
        this.dispatchEvent(new Event('loadedmetadata'));
        this.dispatchEvent(new Event('playing'));
      });
      return Promise.resolve();
    };
    if (!stub) return;
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true, value: 'Web0S Chrome/53.0',
    });
    Object.defineProperty(proto, 'readyState', { configurable: true, get: () => 4 });
    Object.defineProperty(proto, 'paused', { configurable: true, get: () => paused });
    // Native Chromium cannot decode the synthetic HLS source; keep its DOM/source real.
    document.addEventListener('error', event => {
      if (event.isTrusted && event.target instanceof HTMLMediaElement) event.stopImmediatePropagation();
    }, true);
  }, { stub: options.stub !== false });
  await page.goto('/');
  if (options.playlist) await expect(page.locator(ROW).first()).toBeVisible();
  else await expect(page.locator(ROW)).toHaveCount(2);
}

// Live previews the row focus rests on: the first row after launch.
async function selectFirst(page: Page): Promise<void> {
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(page.locator(`${PANEL} .live-preview-channel`)).toHaveText('ch1');
  await expect(page.locator('#view-player')).toBeHidden();
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#video-player')!;
    const probe = (window as unknown as ProbeWindow).previewProbe;
    if (!probe.video) probe.video = video;
    return {
      sameNode: probe.video === video,
      src: video.getAttribute('src'),
      source: video.querySelector('source')?.getAttribute('src') || '',
      loads: probe.loads,
      pauses: probe.pauses,
      plays: probe.plays,
      muted: video.muted,
      currentTime: video.currentTime,
    };
  });
}

async function expectPreviewGeometry(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const slot = document.querySelector('.live-preview-slot')!.getBoundingClientRect();
    const video = document.querySelector('#video-player')!.getBoundingClientRect();
    return Math.max(
      Math.abs(video.x - slot.x), Math.abs(video.y - slot.y),
      Math.abs(video.width - slot.width), Math.abs(video.height - slot.height),
    );
  })).toBeLessThan(3);
  const geometry = await page.evaluate(() => {
    const row = document.querySelector('#channel-browser .channel-main .channel-item')!
      .getBoundingClientRect();
    const slot = document.querySelector('.live-preview-slot')!.getBoundingClientRect();
    return { rowRight: row.right, left: slot.left, width: slot.width, height: slot.height };
  });
  expect(geometry.rowRight).toBeLessThanOrEqual(geometry.left);
  expect(geometry.width).toBeGreaterThan(200);
  expect(Math.abs(geometry.width / geometry.height - 16 / 9)).toBeLessThan(0.05);
}

async function stop(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(
    new KeyboardEvent('keydown', { keyCode: 413, bubbles: true }),
  ));
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate(value => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true, get: () => value ? 'hidden' : 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('the preview follows the focused row on the same video node', async ({ page }) => {
  await setup(page);
  await selectFirst(page);
  const first = await snapshot(page);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(`${PANEL} .live-preview-channel`)).toHaveText('ch2');
  await expect(page.locator('#view-player')).toBeHidden();
  const second = await snapshot(page);
  expect(second.sameNode).toBe(true);
  expect(second.source).toBe('http://host/ch2.m3u8');
  expect(second.loads - first.loads).toBe(1);
  // The preview keeps the player's audio: it plays with sound.
  expect(second.muted).toBe(false);
});

test('OK on the previewed channel opens it full screen', async ({ page }) => {
  await setup(page);
  await selectFirst(page);
  const before = await snapshot(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator(PANEL)).toBeHidden();
  expect((await snapshot(page)).loads).toBe(before.loads);
});

test('Back from full screen focuses the channel changed in the player', async ({ page }) => {
  await setup(page);
  await selectFirst(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.evaluate(() => document.documentElement.dispatchEvent(
    new MouseEvent('mouseleave', { bubbles: true }),
  ));

  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#video-player source')).toHaveAttribute(
    'src',
    'http://host/ch2.m3u8',
  );
  await page.keyboard.press('Escape');

  await expect(page.locator(PANEL)).toBeVisible();
  await expect(page.locator(`${PANEL} .live-preview-channel`)).toHaveText('ch2');
  await expect(page.locator(`${ROW}.focused`)).toContainText('ch2');
});

test('late manifest results from an old selection cannot replace the active preview', async ({ page }) => {
  const epg = `<tv>
    <channel id="ch1"><display-name>ch1</display-name></channel>
    <channel id="ch2"><display-name>ch2</display-name></channel>
    <programme channel="ch1" start="20260915110000 +0000" stop="20260915130000 +0000">
      <title>Program A</title></programme>
    <programme channel="ch2" start="20260915110000 +0000" stop="20260915130000 +0000">
      <title>Program B</title></programme>
  </tv>`;
  let releaseCh1!: () => Promise<void>;
  let releaseCh2!: () => Promise<void>;
  const hold = (url: string, set: (release: () => Promise<void>) => void) => page.route(url, route =>
    new Promise<void>(resolve => {
      set(async () => {
        await route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: LIVE_MANIFEST });
        resolve();
      });
    }));
  const ch1Response = page.waitForResponse('http://host/ch1.m3u8');
  const ch2Response = page.waitForResponse('http://host/ch2.m3u8');
  await setup(page, {
    epg,
    routes: async () => {
      await hold('http://host/ch1.m3u8', release => { releaseCh1 = release; });
      await hold('http://host/ch2.m3u8', release => { releaseCh2 = release; });
    },
  });

  // The preview tunes ch1 once focus rests on it, then ch2.
  await expect.poll(() => typeof releaseCh1).toBe('function');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => typeof releaseCh2).toBe('function');

  await releaseCh2();
  await ch2Response;
  await releaseCh1();
  await ch1Response;

  await expect(page.locator(`${PANEL} .live-preview-channel`)).toHaveText('ch2');
  await expect(page.locator(`${PANEL} .live-preview-title`)).toHaveText('Program B');
  await expect(page.locator('#video-player source')).toHaveAttribute('src', 'http://host/ch2.m3u8');
});

test('Back from Live stops the preview and goes Home', async ({ page }) => {
  await setup(page);
  await selectFirst(page);
  await expect(page.locator(PANEL)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(page.locator('#view-channels')).toBeHidden();
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator('#view-home .focused')).toHaveAttribute('data-section', 'live');
});

test('committed numeric channel entry opens full screen directly', async ({ page }) => {
  await setup(page);
  await page.keyboard.press('2');
  await expect(page.locator('.number-entry')).not.toHaveClass(/visible/);
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator('#video-player source')).toHaveAttribute(
    'src',
    'http://host/ch2.m3u8',
  );
});

test('numeric channel entry during a preview opens full screen', async ({ page }) => {
  await setup(page);
  await selectFirst(page);
  await page.keyboard.press('2');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator('#video-player source')).toHaveAttribute(
    'src',
    'http://host/ch2.m3u8',
  );
});

test('the preview takes no focus: Right from a row stays in the list', async ({ page }) => {
  await setup(page);
  await selectFirst(page);
  await page.mouse.move(0, 0);
  // The pointer left the list, so the first key only shows the focused row.
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(`${ROW}.focused`)).toContainText('ch1');
  const before = await snapshot(page);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(`${ROW}.focused`)).toContainText('ch1');
  await expect(page.locator(`${PANEL} .focused, ${PANEL} [data-focusable], ${PANEL} button`)).toHaveCount(0);
  expect(await snapshot(page)).toEqual(before);
});

test('entering channel edit mode closes the active preview', async ({ page }) => {
  await setup(page);
  await selectFirst(page);
  await page.evaluate(() => document.dispatchEvent(
    new KeyboardEvent('keydown', { keyCode: 405, bubbles: true }),
  ));
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator('#view-channels')).not.toHaveClass(/has-live-preview/);
  await expect(page.locator('.channel-view')).toHaveClass(/editing/);
});

test('entering favorite management closes the active preview', async ({ page }) => {
  await setup(page);
  await selectFirst(page);
  await page.evaluate(() => document.dispatchEvent(
    new KeyboardEvent('keydown', { keyCode: 404, bubbles: true }),
  ));
  await page.locator('[data-group="builtin:favorites"]').click();
  await page.locator('[data-favorite-manage]').click();
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator('#view-channels')).not.toHaveClass(/has-live-preview/);
  await expect(page.locator('.favorite-hints')).toBeVisible();
});

test('expand keeps the video identity, source, time, audio and loading counters', async ({ page }) => {
  await setup(page);
  await selectFirst(page);
  await expectPreviewGeometry(page);
  await page.locator('#video-player').evaluate(video => {
    let position = 37;
    Object.defineProperty(video, 'currentTime', {
      configurable: true, get: () => position, set: (value: number) => { position = value; },
    });
  });
  const before = await snapshot(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect.poll(() => page.locator('#video-player').evaluate(
    video => video.getBoundingClientRect().width,
  )).toBe(1920);
  const expanded = await snapshot(page);
  expect(expanded).toEqual(before);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#player-sidebar')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#player-sidebar')).toBeHidden();
  await expect(page.locator('#view-player')).toBeVisible();
  expect(await snapshot(page)).toEqual(expanded);
  await page.keyboard.press('Escape');
  await expect(page.locator(PANEL)).toBeVisible();
  await expectPreviewGeometry(page);
  expect(await snapshot(page)).toEqual(expanded);

  // The pointer's click on the video watches it full screen too.
  await page.locator('.live-preview-slot').click({ position: { x: 30, y: 80 } });
  await expect(page.locator('#view-player')).toBeVisible();
  expect(await snapshot(page)).toEqual(expanded);
});

test('real desktop MSE attachment survives expand and minimize without reload', async ({ page }) => {
  await setup(page, { stub: false });
  await selectFirst(page);
  await expect.poll(() => page.locator('#video-player').getAttribute('src')).toMatch(/^blob:/);
  await expect.poll(async () => (await snapshot(page)).plays).toBeGreaterThan(0);
  const before = await snapshot(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(PANEL)).toBeVisible();
  await expectPreviewGeometry(page);
  expect(await snapshot(page)).toEqual(before);
});

// A layout change (as a theme or text size makes) refits the upcoming rows.
async function relayout(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
}

test('complete future rows fit every theme and text scale without touching the footer', async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page, { epg: LAYOUT_EPG, now: '2026-09-15T23:30:00Z' });
  await selectFirst(page);
  await expect(page.locator(`${PANEL} .live-preview-title`)).toHaveText(LONG_TITLE);
  await expect(page.locator(`${PANEL} .live-preview-time-range`))
    .toHaveText('23:15–00:15');
  await expect(page.locator(`${PANEL} .live-preview-day-separator`)).toContainText('09/16');
  await expect(page.locator(`${PANEL} .live-preview-program time`).first())
    .toHaveText('00:15–01:15');
  const sizes = TEXT_SIZES.filter(size => Number(size) >= 100);
  for (const theme of THEMES) {
    for (const size of sizes) {
      await test.step(`${theme.id} at ${size}%`, async () => {
        await page.evaluate(({ themeId, textSize }) => {
          document.documentElement.dataset.theme = themeId;
          document.documentElement.dataset.textSize = textSize;
        }, { themeId: theme.id, textSize: size });
        await relayout(page);
        await expectPreviewGeometry(page);
        const layout = await page.locator(PANEL).evaluate(panel => {
          const details = panel.querySelector('.live-preview-details')!.getBoundingClientRect();
          const title = panel.querySelector('.live-preview-title')!;
          const lineHeight = parseFloat(getComputedStyle(title).lineHeight);
          const rows = Array.from(panel.querySelectorAll<HTMLElement>('.live-preview-program'))
            .filter(row => row.getBoundingClientRect().height > 0);
          return {
            titleLines: title.getBoundingClientRect().height / lineHeight,
            count: rows.length,
            rows: rows.map(row => {
              const box = row.getBoundingClientRect();
              return {
                insideDetails: box.top >= details.top && box.bottom <= details.bottom + 0.5,
                top: box.top,
                completeHeight: box.height,
                children: Array.from(row.children).map(child => {
                  const content = child.getBoundingClientRect();
                  return { top: content.top, bottom: content.bottom };
                }),
              };
            }),
          };
        });
        expect(layout.titleLines).toBeGreaterThanOrEqual(0.9);
        expect(layout.titleLines).toBeLessThanOrEqual(2.1);
        expect(layout.count).toBeLessThanOrEqual(4);
        if (size === '100') expect(layout.count).toBeGreaterThan(0);
        for (const row of layout.rows) {
          expect(row.insideDetails).toBe(true);
          expect(row.completeHeight).toBeGreaterThanOrEqual(68);
          expect(
            row.children.every(child =>
              child.top >= row.top - 0.5
              && child.bottom <= row.top + row.completeHeight + 0.5),
            JSON.stringify(row),
          ).toBe(true);
        }
      });
    }
  }
});

test('keeps long cross-midnight EPG aligned at default and large text sizes', async ({ page }) => {
  await setup(page, { epg: LAYOUT_EPG, now: '2026-09-15T23:30:00Z' });
  await expect(page.locator(ROW).first()).toContainText(LONG_TITLE);
  await selectFirst(page);
  await expect(page.locator(`${PANEL} .live-preview-message`)).toHaveCount(0);
  await page.mouse.move(0, 0);
  await expectPreviewGeometry(page);

  await page.evaluate(() => { document.documentElement.dataset.textSize = '150'; });
  await relayout(page);
  await page.mouse.move(0, 0);
  await expectPreviewGeometry(page);
  await expect.poll(() => page.locator('#video-player').evaluate((video: HTMLVideoElement) =>
    getComputedStyle(video).zIndex,
  )).toBe('1');
});

test('waiting or a failed manifest retains the preview slot and channel identity', async ({ page }) => {
  await setup(page);
  await selectFirst(page);
  const before = await page.locator('.live-preview-slot').boundingBox();
  await page.locator('#video-player').evaluate(video => video.dispatchEvent(new Event('waiting')));
  await expect(page.locator(PANEL)).toBeVisible();
  await expectPreviewGeometry(page);
  expect(await page.locator('.live-preview-slot').boundingBox()).toEqual(before);
  await page.route('http://host/ch2.m3u8', route => route.fulfill({ status: 503, body: '' }));
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(`${PANEL} .live-preview-channel`)).toHaveText('ch2');
  await expectPreviewGeometry(page);
  expect(await page.locator('.live-preview-slot').boundingBox()).toEqual(before);
});

// Regression: once live recovery ran out, the preview zapped to the next
// channel while focus stayed on the dead row. On the TV a dead stream
// reaches the player as the native <video> error event.
test('a dead previewed channel shows its failure on its row instead of zapping', async ({ page }) => {
  const events: string[] = [];
  page.on('console', (msg) => events.push(msg.text()));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_live_reconnect_attempts', JSON.stringify(0));
  });
  await setup(page);
  await selectFirst(page);
  await expect.poll(async () => (await snapshot(page)).source).toBe('http://host/ch1.m3u8');

  await page.locator('#video-player').evaluate(video => video.dispatchEvent(new Event('error')));
  // One reconnect at most, then recovery runs out: the row keeps its channel.
  await expect(page.locator(`${PANEL} .live-preview-message`)).toHaveText('Unavailable', { timeout: 10_000 });
  await expect.poll(() => events.some(text => text.includes('event=playback.recovery.exhausted')
    && text.includes('outcome=preview-failed'))).toBe(true);
  // Well past the error's 2 s advance: nothing zaps.
  await page.waitForTimeout(3000);
  await expect(page.locator(`${PANEL} .live-preview-channel`)).toHaveText('ch1');
  await expect(page.locator(`${PANEL} .live-preview-message`)).toHaveText('Unavailable');
  await expect(page.locator(`${ROW}.focused`)).toContainText('ch1');
  expect((await snapshot(page)).source).toBe('http://host/ch1.m3u8');
  await expect(page.locator('#view-player')).toBeHidden();
});

test('full screen still moves on from a dead channel once recovery runs out', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('iptv_live_reconnect_attempts', JSON.stringify(0));
  });
  await setup(page);
  await selectFirst(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.locator('#video-player').evaluate(video => video.dispatchEvent(new Event('error')));
  await expect.poll(async () => (await snapshot(page)).source, { timeout: 10_000 })
    .toBe('http://host/ch2.m3u8');
  await expect(page.locator('#view-player')).toBeVisible();
});

test('EPG shows the current program, up to four future rows, and the favorite mark', async ({ page }) => {
  await setup(page, { epg: true });
  await expect(page.locator(ROW).first()).toContainText('Program 1');
  await selectFirst(page);
  await expect(page.locator(`${PANEL} .live-preview-title`)).toHaveText('Program 1');
  await expect(page.locator(`${PANEL} .live-preview-time-range`)).toHaveText('11:00–13:00');
  await expect(page.locator(`${PANEL} .live-preview-program`)).toHaveCount(4);
  await expect(page.locator(`${PANEL} .live-preview-program`)).toHaveText([
    /13:00–14:00.*Program 2/s,
    /14:00–15:00.*Program 3/s,
    /15:00–16:00.*Program 4/s,
    /16:00–17:00.*Program 5/s,
  ]);
  await expect(page.locator(`${PANEL} .live-preview-remaining`)).toHaveText('60 min left');
  await expect(page.locator(`${PANEL} .live-preview-badge`)).toContainText('LIVE');
  await expect(page.locator(`${PANEL} .live-preview-favorite`)).toHaveCount(0);
  const geometry = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const slot = box('.live-preview-slot');
    const badge = box('.live-preview-badge');
    return {
      badgeLeft: badge.left - slot.left, badgeTop: badge.top - slot.top,
      headingBelow: box('.live-preview-heading').top >= slot.bottom,
    };
  });
  expect(geometry.badgeLeft).toBeGreaterThanOrEqual(0);
  expect(geometry.badgeLeft).toBeLessThan(60);
  expect(geometry.badgeTop).toBeGreaterThanOrEqual(0);
  expect(geometry.badgeTop).toBeLessThan(60);
  expect(geometry.headingBelow).toBe(true);

  // Green on the row marks the channel a favorite; the pane shows it.
  await page.evaluate(() => document.dispatchEvent(
    new KeyboardEvent('keydown', { keyCode: 404, bubbles: true }),
  ));
  await expect(page.locator(`${PANEL} .live-preview-favorite .favorite-glyph.set`)).toBeVisible();

  await page.locator(`${PANEL} .live-preview-channel`).evaluate(element => {
    element.textContent = 'Very Long Channel Name '.repeat(20);
  });
  const truncation = await page.evaluate(() => {
    const channel = document.querySelector<HTMLElement>('.live-preview-channel')!;
    return {
      clipped: channel.scrollWidth > channel.clientWidth,
      overflow: getComputedStyle(channel).textOverflow,
      inside: channel.getBoundingClientRect().right
        <= document.querySelector('#live-preview')!.getBoundingClientRect().right,
    };
  });
  expect(truncation).toEqual({ clipped: true, overflow: 'ellipsis', inside: true });
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(`${PANEL} .live-preview-channel`)).toHaveText('ch2');
  await expect(page.locator(`${PANEL} .live-preview-title`)).toHaveCount(0);
  await expect(page.locator(`${PANEL} .live-preview-program`)).toHaveCount(0);
});

test('Stop removes the preview until focus moves on', async ({ page }) => {
  await setup(page);
  await selectFirst(page);
  await stop(page);
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator(`${ROW}.focused`)).toHaveCount(1);
  // Resting on the same row does not restart it.
  await page.waitForTimeout(1500);
  await expect(page.locator(PANEL)).toBeHidden();
  expect((await snapshot(page)).source).toBe('');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(`${PANEL} .live-preview-channel`)).toHaveText('ch2');
});

test('leaving Live stops the preview', async ({ page }) => {
  await setup(page);
  await selectFirst(page);
  await enterTab(page, 'settings');
  await expect(page.locator('#view-settings')).toBeVisible();
  expect((await snapshot(page)).source).toBe('');
});

test('a current program without a following schedule has one concise empty state', async ({ page }) => {
  await setup(page, {
    epg: `<tv><channel id="ch1"><display-name>ch1</display-name></channel>
      <programme channel="ch1" start="20260915110000 +0000" stop="20260915130000 +0000">
        <title>Program 1</title></programme></tv>`,
  });
  await expect(page.locator(ROW).first()).toContainText('Program 1');
  await selectFirst(page);
  await expect(page.locator(`${PANEL} .live-preview-title`)).toHaveText('Program 1');
  await expect(page.locator(`${PANEL} .live-preview-program`)).toHaveCount(0);
  await expect(page.locator(`${PANEL} .live-preview-empty`)).toHaveText('No upcoming programs');
  await expectPreviewGeometry(page);
});

test('background resume restores preview presentation through the normal lifecycle', async ({ page }) => {
  await setup(page);
  await selectFirst(page);
  await setHidden(page, true);
  await setHidden(page, false);
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(page.locator(`${PANEL} .live-preview-channel`)).toHaveText('ch1');
  await expect(page.locator('#view-player')).toBeHidden();
  await expectPreviewGeometry(page);
  expect((await snapshot(page)).source).toBe('http://host/ch1.m3u8');
});

test('disabling the playing source in Settings leaves no preview', async ({ page }) => {
  await setup(page);
  await selectFirst(page);
  await enterTab(page, 'settings');
  await page.locator('[data-settings-target="sources"]').click();
  await page.locator('#playlist-entries .source-toggle').click();
  await page.locator('#save-settings').click();
  await liveAfterSave(page);
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator(ROW)).toHaveCount(0);
  await expect(page.locator('#view-channels')).not.toHaveClass(/has-live-preview/);
  expect((await snapshot(page)).source).toBe('');
});

test.describe('display timezone', () => {
  test.use({ timezoneId: 'Etc/GMT-2' });

  test('future times follow device or feed time without changing current EPG', async ({ page }) => {
    await setup(page, { epg: true });
    await expect(page.locator(ROW).first()).toContainText('Program 1');
    await selectFirst(page);
    await expect(page.locator(`${PANEL} .live-preview-program time`).first())
      .toHaveText('15:00–16:00');
    await expect(page.locator(`${PANEL} .live-preview-title`)).toHaveText('Program 1');
    await expectPreviewGeometry(page);

    await enterTab(page, 'settings');
    await page.locator('[data-settings-target="guide"]').click();
    await page.locator('#tz-mode [data-value="feed"]').click();
    await page.locator('#save-settings').click();
    await liveAfterSave(page);
    await selectFirst(page);
    await expect(page.locator(`${PANEL} .live-preview-program time`).first())
      .toHaveText('13:00–14:00');
    await expect(page.locator(`${PANEL} .live-preview-title`)).toHaveText('Program 1');
    await expect(page.locator(`${PANEL} .live-preview-remaining`)).toHaveText('60 min left');
    await expectPreviewGeometry(page);
  });
});

test('essential animation mode preserves geometry and continuity', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('iptv_animation_mode', JSON.stringify('essential'));
  });
  await setup(page);
  await selectFirst(page);
  await expectPreviewGeometry(page);
  const before = await snapshot(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(PANEL)).toBeVisible();
  await expectPreviewGeometry(page);
  expect(await snapshot(page)).toEqual(before);
});
