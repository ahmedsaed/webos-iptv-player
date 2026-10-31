import { enterTab, openGuide, openLive, pressKeys, test, expect, isChromium53, neuterVideo, routeLiveManifest, routePlaylist, type Page } from './helpers';
import { type Browser } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { findGappedLooseText, measureLooseText, newLegacyPage, pixelDiff } from './pixel-parity';
import { seedXtream } from './fixtures/xtream';
import { channelKey } from '../src/utils/channel';
import { type Channel } from '../src/types';

// webOS 4/5/6 lack flex `gap`, CSS Grid and backdrop-filter, so the app ships a
// second layout built from `> * + *` margins and float/inline-block fallbacks.
// Those fallbacks are meant to *reproduce* the modern layout, not merely to
// avoid collapsing — but nothing checked that they land in the same place.
//
// Both engines here are the same headless Chromium with the same fonts, so text
// rasterizes identically and every differing pixel is a layout difference. That
// makes this the one comparison that is trustworthy pixel-wise: the real TV
// ships a wider font, which shifts glyphs on its own and drowns the signal.

// Rendered frames land here so a run can be eyeballed, not just read as
// percentages.
const DIFF_DIR = 'test-output/legacy-parity';

// A fixed clock keeps the EPG's "now" marker, the header time and every
// relative timestamp identical between the two pages.
const NOW = new Date('2024-03-05T12:00:00.000Z');

const at = (hours: number): string =>
  new Date(NOW.getTime() + hours * 3600_000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';

const EPG = `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="one"><display-name>Channel One</display-name></channel>
<channel id="two"><display-name>Channel Two</display-name></channel>
<programme channel="one" start="${at(-2)}" stop="${at(-1)}"><title>Earlier Show</title><desc>An earlier description.</desc></programme>
<programme channel="one" start="${at(-1)}" stop="${at(1)}"><title>Current Show</title><desc>A current description.</desc></programme>
<programme channel="one" start="${at(1)}" stop="${at(3)}"><title>Later Show</title><desc>A later description.</desc></programme>
<programme channel="two" start="${at(-1)}" stop="${at(2)}"><title>Other Current</title><desc>Another description.</desc></programme>
</tv>`;

// The audio and subtitle pickers fall back to the parsed master manifest when
// the pipeline exposes no native track, so renditions alone populate them.
const MASTER_MANIFEST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Track 1",LANGUAGE="l1",DEFAULT=YES',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Track 2",LANGUAGE="l2"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Sub 1",LANGUAGE="l1",URI="http://host/s1.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Sub 2",LANGUAGE="l2",URI="http://host/s2.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a",SUBTITLES="s"',
  'http://host/v.m3u8',
  '',
].join('\n');

// The desktop preview has no LAN service, so the device-setup panel in the
// general pane renders a placeholder and its QR and instructions are never
// compared. Answer the calls the app makes at boot so it renders for real.
async function stubLanService(page: Page): Promise<void> {
  await page.route('http://127.0.0.1:9999/info', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ip: '192.168.1.2',
      port: 9999,
      setupUrl: 'http://192.168.1.2:9999/setup?token=abc123',
      manualUrl: 'http://192.168.1.2:9999',
      pairingCode: '1234',
    }),
  }));
  await page.route('http://127.0.0.1:9999/uploads', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('http://127.0.0.1:9999/setup-state', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: '{"updated":true}' }));
  await page.addInitScript(() => {
    class FakePalmServiceBridge {
      onservicecallback: ((message: string) => void) | null = null;

      call(uri: string): void {
        const method = uri.slice(uri.lastIndexOf('/') + 1);
        const response = method === 'start'
          ? { running: true, port: 9999 }
          : method === 'serviceEvents'
            ? { subscribed: true }
            : { returnValue: false, errorText: 'unmocked: ' + method };
        setTimeout(() => this.onservicecallback?.(JSON.stringify(response)), 0);
      }

      cancel(): void {
        this.onservicecallback = null;
      }
    }
    (window as unknown as {
      PalmServiceBridge?: unknown;
    }).PalmServiceBridge = FakePalmServiceBridge;
  });
}

async function prepareM3U(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await routePlaylist(page, [
    '#EXTM3U url-tvg="http://epg.example.com/guide.xml"',
    '#EXTINF:-1 tvg-id="one" group-title="News" catchup="default" catchup-source="http://streams.example.com/one.m3u8?start=${start}",Channel One',
    'http://streams.example.com/one.m3u8',
    '#EXTINF:-1 tvg-id="two" group-title="Movies",Channel Two',
    'http://streams.example.com/two.m3u8',
  ].join('\n'));
  await routeLiveManifest(page);
  await page.route('**/one.m3u8', (r) => r.fulfill({
    status: 200, contentType: 'application/vnd.apple.mpegurl', body: MASTER_MANIFEST }));
  await neuterVideo(page);
  await page.route('**/guide.xml', (r) =>
    r.fulfill({ status: 200, contentType: 'application/xml', body: EPG }));
  await stubLanService(page);
  await page.addInitScript((key) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { name: 'Source 1', url: 'http://host/playlist.m3u' },
      {
        id: 'p2', name: 'Source 2', url: 'http://host/secondary.m3u',
        enabled: false,
      },
    ]));
    localStorage.setItem('iptv_reminders', JSON.stringify([{
      channelKey: key,
      channelName: 'Channel One',
      title: 'Later Show',
      startMs: Date.now() + 3600_000,
      stopMs: Date.now() + 7200_000,
    }]));
    localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://epg.example.com/guide.xml', playlistIds: [] }]));
    localStorage.setItem('iptv_favorites', JSON.stringify([key]));
    // A half-watched past program, so the EPG offers to resume it.
    const start = Date.now() - 2 * 3600_000;
    const end = start + 3600_000;
    localStorage.setItem('iptv_catchup_progress', JSON.stringify({
      [`${key}|${start}`]: {
        channelKey: key, progStart: start, progEnd: end,
        position: 1800, duration: 3600, updatedAt: start,
        completed: false, expiresAt: end + 7 * 86400_000,
      },
    }));
  }, channelKey({ url: 'http://streams.example.com/one.m3u8' } as Channel));
  await page.goto('/');
  await openLive(page);
  await expect(page.locator('.channel-item')).toHaveCount(2);
}

async function prepareXtream(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await seedXtream(page, { catalog: 'large' });
  await page.goto('/');
  await openLive(page);
}

// Wait out a smooth scroll so both engines are sampled at rest.
async function railAtRest(p: Page, selector: string): Promise<void> {
  let last = '';
  await expect.poll(async () => {
    const now = await p.locator(selector).evaluate((el) => `${String(el.scrollLeft)},${String(el.scrollTop)}`);
    const settled = now === last;
    last = now;
    return settled;
  }, { intervals: [100] }).toBe(true);
}

interface Screen {
  name: string;
  /** Budget as a fraction of the viewport; see the calibration note below. */
  budget: number;
  go: (page: Page) => Promise<void>;
}

// Back out of the player and its panels to Live.
async function backToLive(p: Page): Promise<void> {
  for (let i = 0; i < 4 && !(await p.locator('#view-channels').isVisible()); i++) {
    await p.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
    await p.waitForTimeout(100);
  }
  await expect(p.locator('#view-channels')).toBeVisible();
}

async function openSettingsPane(p: Page, pane: string): Promise<void> {
  await enterTab(p, 'settings');
  // The stubbed service makes the setup panel render for real and refreshes
  // the upload list; both land after the view opens, so wait for them on
  // their own pages before showing the one to compare.
  await p.locator('[data-settings-target="general"]').click();
  await expect(p.locator('.setup-qr')).toBeVisible();
  await p.locator('[data-settings-target="sources"]').click();
  await expect(p.locator('#upload-entries .empty-hint')).toBeVisible();
  await p.locator(`[data-settings-target="${pane}"]`).click();
  await expect(p.locator(`#settings-${pane}`)).toBeVisible();
  await expect(p.locator(`.settings-nav-item.active[data-settings-target="${pane}"]`))
    .toBeVisible();
}

// Turning parental controls on persists across reloads, so these screens run
// after every screen that would otherwise meet a PIN prompt.
const PIN = '1234';

async function enterPin(p: Page): Promise<void> {
  await p.locator('.parental-pin-prompt .parental-pin-input').fill(PIN);
}

/** Leave the manager with an unlock duration of "Once", so locks apply. */
async function leaveParentalLocked(p: Page): Promise<void> {
  await p.locator('[data-parental-tab="options"]').click();
  await p.locator('#parental-duration [data-value="once"]').click();
  await expect(p.locator('#parental-duration .active')).toHaveAttribute('data-value', 'once');
  await p.locator('[data-parental-back]').click();
  await expect(p.locator('#view-parental-controls')).toBeHidden();
}

const M3U_SCREENS: Screen[] = [
  {
    // The landing view, once the preview has followed the focused row: its
    // dwell would otherwise land between the two engines' shots.
    name: 'live',
    budget: 0,
    go: async (p) => {
      await expect(p.locator('#live-preview .live-preview-channel')).toHaveText('Channel One');
    },
  },
  { name: 'guide', budget: 0, go: (p) => openGuide(p) },
  {
    // Back hands the Guide's keys to the groups column; Red then returns to the list.
    name: 'guide-groups',
    budget: 0,
    go: async (p) => {
      await pressKeys(p, 461);
      await expect(p.locator('#channel-browser .group-item.focused')).toHaveCount(1);
    },
  },
  ...(['general', 'sources', 'guide', 'appearance', 'playback', 'subtitles', 'advanced', 'data']
    .map((pane) => ({
      name: `settings-${pane}`,
      // The data pane prints a storage quota, and `navigator.storage` is
      // Chromium 55 — so webOS 4 estimates it another way. Environment, not
      // layout.
      budget: pane === 'data' ? 0.0005 : 0,
      go: (p: Page) => openSettingsPane(p, pane),
    }))),
  {
    name: 'settings-dropdown-open',
    budget: 0,
    go: async (p) => {
      await openSettingsPane(p, 'appearance');
      await p.locator('#text-size [data-dropdown-trigger]').click();
      await expect(p.locator('#text-size.open .dropdown-menu')).toBeVisible();
    },
  },
  {
    name: 'settings-guide-multi-source',
    budget: 0,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await expect(p.locator('#text-size.open')).toHaveCount(0);
      await enterTab(p, 'settings');
      await p.locator('[data-settings-target="guide"]').click();
      await p.locator('#add-epg-source').click();
      const sources = p.locator('[data-manual-epg-source]');
      await expect(sources).toHaveCount(2);
      await sources.nth(1).locator('.manual-epg-url').fill('http://host/guide-2.xml');
      const firstScope = sources.nth(0).locator('[data-playlist-id]').first();
      const secondScope = sources.nth(1).locator('[data-playlist-id]').nth(1);
      await firstScope.click();
      await secondScope.click();
      await expect(firstScope).toHaveClass(/active/);
      await expect(secondScope).toHaveClass(/active/);
      await p.locator('.epg-scope-option.focused').evaluateAll((options) => {
        options.forEach(option => option.classList.remove('focused'));
      });
      await expect(sources.nth(1).locator('.manual-epg-scope-options')).toBeVisible();
    },
  },
  {
    name: 'search',
    budget: 0,
    go: async (p) => {
      await enterTab(p, 'search');
      // The results view only covers the current one once a query is typed.
      await p.locator('.search-box-input').fill('channel');
      await expect(p.locator('#view-search')).toBeVisible();
    },
  },
  {
    name: 'favorites-manage',
    budget: 0,
    go: async (p) => {
      await enterTab(p, 'live');
      if (await p.locator('#view-channels.live-guide-mode').count()) await pressKeys(p, 403);
      await p.locator('[data-group="builtin:favorites"]').click();
      await p.locator('[data-favorite-manage]').click();
      await expect(p.locator('.edit-hints.favorite-hints')).toBeVisible();
      await p.keyboard.press('Escape');
      await expect(p.locator('.edit-hints.favorite-hints')).toHaveCount(0);
      await p.locator('[data-group="builtin:all"]').click();
    },
  },
  {
    name: 'channel-editor',
    budget: 0,
    go: async (p) => {
      await enterTab(p, 'live');
      await p.locator('[data-edit-channels]').click();
      await expect(p.locator('.channel-view.editing .edit-hints')).toBeVisible();
    },
  },
  {
    name: 'player-osd',
    budget: 0,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await p.locator('.channel-item').first().click();
      await expect(p.locator('#player-osd')).toBeVisible();
    },
  },
  {
    // Geometry matches exactly; the residue is the backdrop-filter fallback's
    // opaque panel, which shifts glyph antialiasing against the video plane.
    name: 'player-controls',
    budget: 0.001,
    go: async (p) => {
      await p.keyboard.press('Enter');
      await expect(p.locator('#player-osd [data-dock-action="favorite"].focused')).toBeVisible();
    },
  },
  {
    name: 'menu-audio',
    budget: 0.001,
    go: async (p) => {
      await p.locator('#player-osd [data-dock-action="audio"]').click();
      await expect(p.locator('[data-menu-action="__audio_track__"]').first()).toBeVisible();
    },
  },
  {
    name: 'menu-subtitles',
    budget: 0.001,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await p.locator('#player-osd [data-dock-action="subtitles"]').click();
      await expect(p.locator('[data-menu-action="__subs_track__"]').first()).toBeVisible();
    },
  },
  {
    name: 'player-sidebar',
    budget: 0.001, // same opaque-panel residue as the picker
    go: async (p) => {
      await p.keyboard.press('Escape'); // the picker
      await p.keyboard.press('Escape'); // the controls
      await p.keyboard.press('ArrowLeft');
      await p.keyboard.press('ArrowLeft');
      await expect(p.locator('#player-sidebar')).toBeVisible();
    },
  },
  {
    name: 'sidebar-search',
    budget: 0.001,
    go: async (p) => {
      await p.locator('.sidebar-search-input').fill('one');
      await expect(p.locator('#player-sidebar .sidebar-ch-item')).toHaveCount(1);
    },
  },
  {
    name: 'sidebar-groups',
    budget: 0.001,
    go: async (p) => {
      await p.locator('[data-open-groups]').click();
      await expect(p.locator('#player-sidebar .sidebar-group-item').first()).toBeVisible();
    },
  },
  {
    name: 'number-entry',
    budget: 0.001,
    go: async (p) => {
      await backToLive(p);
      await p.keyboard.press('2');
      await p.keyboard.press('4');
      await expect(p.locator('.number-entry.visible')).toBeVisible();
    },
  },
  {
    name: 'search-empty',
    budget: 0,
    go: async (p) => {
      // A key abandons the typed digits, unless they already tuned a channel
      // full screen.
      await p.keyboard.press('ArrowUp');
      await backToLive(p);
      await enterTab(p, 'search');
      await p.locator('.search-box-input').fill('zzqqxx');
      await expect(p.locator('#view-search')).toBeVisible();
      await expect(p.locator('#view-search [data-focusable]')).toHaveCount(0);
    },
  },
  {
    name: 'reminders',
    budget: 0,
    go: async (p) => {
      await enterTab(p, 'settings');
      await p.locator('[data-settings-target="guide"]').click();
      await p.locator('#manage-reminders').click();
      await expect(p.locator('.reminder-manager-view')).toBeVisible();
    },
  },
  {
    name: 'confirm-clear-reminders',
    budget: 0,
    go: async (p) => {
      await p.locator('.reminder-manager-clear').click();
      await expect(p.locator('.confirmation-prompt')).toBeVisible();
    },
  },
  {
    // A past program only offers to resume when a checkpoint exists for it;
    // prepareM3U seeds one. The Guide opens on the current show; LEFT steps
    // back to the past one, and ENTER activates it.
    name: 'catchup-resume',
    budget: 0,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await p.keyboard.press('Escape');
      await enterTab(p, 'live');
      await openGuide(p);
      await pressKeys(p, 37, 13);
      await expect(p.locator('.catchup-resume-prompt')).toBeVisible();
    },
  },
  {
    // Reload onto the list, wait for the preview to follow the focused row,
    // then advance the neutered video to a stable playing frame so the
    // layout stays put in the shot.
    name: 'live-preview',
    budget: 0,
    go: async (p) => {
      await p.reload();
      await openLive(p);
      await expect(p.locator('.channel-item')).toHaveCount(2);
      await expect(p.locator('#live-preview .live-preview-channel')).toHaveText('Channel One');
      await p.locator('#video-player').evaluate((video) => {
        video.dispatchEvent(new Event('loadedmetadata'));
        video.dispatchEvent(new Event('playing'));
      });
      await expect(p.locator('#live-preview')).toBeVisible();
      await expect(p.locator('.live-preview-title')).toHaveText('Current Show');
      await expect(p.locator('.live-preview-message')).toHaveCount(0);
    },
  },
  {
    // A due reminder prompts at boot, over Home, so this one arrives
    // through a reload.
    name: 'reminder-prompt',
    budget: 0,
    go: async (p) => {
      await p.addInitScript((k) => {
        localStorage.setItem('iptv_reminders', JSON.stringify([{
          channelKey: k, channelName: 'Channel One', title: 'Later Show',
          startMs: Date.now() - 60_000, stopMs: Date.now() + 3600_000,
        }]));
      }, channelKey({ url: 'http://streams.example.com/one.m3u8' } as Channel));
      await p.reload();
      await expect(p.locator('.reminder-prompt:not(.hidden)')).toBeVisible();
    },
  },
  {
    name: 'parental-pin-create',
    budget: 0,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await expect(p.locator('.reminder-prompt:not(.hidden)')).toHaveCount(0);
      await openSettingsPane(p, 'general');
      await p.locator('#manage-parental-controls').click();
      await expect(p.locator('.parental-pin-prompt .parental-pin-dialog')).toBeVisible();
    },
  },
  {
    name: 'parental-controls',
    budget: 0,
    go: async (p) => {
      await enterPin(p);
      await expect(p.locator('.parental-pin-prompt h2')).toContainText('Confirm');
      await enterPin(p);
      await expect(p.locator('#view-parental-controls')).toBeVisible();
      const news = p.locator('[data-parental-group]').filter({ hasText: 'News' });
      await news.click();
      await expect(news.locator('.lock-badge.is-locked')).toBeVisible();
    },
  },
  {
    name: 'parental-options',
    budget: 0,
    go: async (p) => {
      await p.locator('[data-parental-tab="options"]').click();
      await expect(p.locator('#parental-duration')).toBeVisible();
    },
  },
  {
    name: 'settings-parental-on',
    budget: 0,
    go: async (p) => {
      await leaveParentalLocked(p);
      await openSettingsPane(p, 'general');
      await expect(p.locator('.parental-entry-status.is-on')).toBeVisible();
    },
  },
  {
    name: 'live-locked',
    budget: 0,
    go: async (p) => {
      await enterTab(p, 'live');
      await expect(p.locator('#view-channels .group-item .lock-badge.is-locked').first()).toBeVisible();
      await expect(p.locator('#view-channels .channel-item .lock-badge.is-locked').first()).toBeVisible();
    },
  },
  {
    name: 'parental-pin-challenge',
    budget: 0,
    go: async (p) => {
      await p.locator('#view-channels .channel-main .channel-item').filter({ hasText: 'Channel One' }).click();
      await expect(p.locator('.parental-pin-prompt .parental-pin-dialog')).toBeVisible();
    },
  },
  {
    // Last two: both reload with the playlist state rewritten.
    // Live loads its channels when it opens from Home.
    name: 'live-loading',
    budget: 0,
    go: async (p) => {
      await p.route('**/playlist.m3u', (r) => new Promise(() => { void r; }));
      await p.reload();
      await expect(p.locator('#view-home [data-key="section:live"]')).toHaveClass(/\bfocused\b/);
      await p.keyboard.press('Enter');
      await expect(p.locator('#view-channels .live-load-status')).toBeVisible();
    },
  },
  {
    name: 'first-run',
    budget: 0,
    go: async (p) => {
      // prepareM3U's init script re-seeds the playlist on every navigation, so
      // drop it from a later one, which runs after it.
      await p.addInitScript(() => localStorage.removeItem('iptv_playlists'));
      await p.reload();
      await expect(p.locator('#view-home .home-view-first-run')).toBeVisible();
    },
  },
];

const XTREAM_SCREENS: Screen[] = [
  {
    name: 'home',
    budget: 0,
    go: async (p) => {
      await enterTab(p, 'home');
      await expect(p.locator('.home-card').first()).toBeVisible();
      await p.mouse.move(960, 1000);
    },
  },
  {
    name: 'account-switcher',
    budget: 0,
    go: async (p) => {
      const avatar = p.locator('.home-account .account-avatar');
      await avatar.click();
      await expect(p.locator('.home-account .account-menu-item').first()).toBeVisible();
      await avatar.click();
      await expect(p.locator('.account-menu-item')).toHaveCount(0);
    },
  },
  {
    name: 'movies',
    budget: 0,
    go: async (p) => {
      await enterTab(p, 'movies');
      await expect(p.locator('#view-movies .catalog-tile[data-item-id="10"]').first()).toBeVisible();
      await heroAtRest(p);
    },
  },
  {
    // The rail's last tile, focused from the D-pad: its ring and the end
    // gutter beside it.
    name: 'movies-see-all',
    budget: 0,
    go: async (p) => {
      await enterTab(p, 'movies');
      const first = p.locator('#view-movies [data-rail-key="cat:1"] .catalog-tile').first();
      await expect(first).toBeVisible();
      await first.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
      for (let i = 0; i < 10; i++) await p.keyboard.press('ArrowRight');
      await expect(p.locator('#view-movies .catalog-see-all[data-category-id="1"]')).toHaveClass(/focused/);
      await railAtRest(p, '#view-movies [data-rail-key="cat:1"] .catalog-rail-track');
      await heroAtRest(p);
    },
  },
  {
    name: 'movies-all-categories',
    budget: 0,
    go: async (p) => {
      const cat = p.locator('#view-movies .catalog-cat[data-category-id="1"]');
      await cat.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
      await p.keyboard.press('ArrowRight');
      await expect(p.locator('#view-movies .catalog-cat[data-category-id="2"]')).toHaveClass(/focused/);
      await railAtRest(p, '#view-movies .catalog-rails');
      await railAtRest(p, '#view-movies .catalog-category-rail');
      await heroAtRest(p);
    },
  },
  {
    name: 'movie-detail',
    budget: 0,
    go: async (p) => {
      await p.locator('#view-movies .catalog-tile[data-item-id="10"]').first().click();
      await expect(p.locator('#view-movies .detail-plot')).toContainText('A plot.');
    },
  },
  {
    name: 'watchlist-toast',
    budget: 0,
    go: async (p) => {
      await p.locator('#view-movies [data-action="watchlist"]').click();
      await expect(p.locator('.toast.visible')).toBeVisible();
    },
  },
  {
    name: 'series',
    budget: 0,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await enterTab(p, 'series');
      await expect(p.locator('#view-series .catalog-tile[data-item-id="20"]').first()).toBeVisible();
    },
  },
  {
    name: 'series-detail',
    budget: 0,
    go: async (p) => {
      await p.locator('#view-series .catalog-tile[data-item-id="20"]').first().click();
      await expect(p.locator('#view-series .episode-card')).toBeVisible();
    },
  },
  {
    name: 'vod-osd',
    budget: 0.001, // opaque-panel residue, as on the live player
    go: async (p) => {
      await p.keyboard.press('Escape');
      await enterTab(p, 'movies');
      await p.locator('#view-movies .catalog-tile[data-item-id="10"]').first().click();
      await expect(p.locator('#view-movies .detail-plot')).toContainText('A plot.');
      await p.locator('#view-movies .detail-btn').first().click();
      await expect(p.locator('#player-osd')).toBeVisible();
    },
  },
  {
    name: 'vod-menu-subtitles',
    budget: 0.001,
    go: async (p) => {
      await p.locator('#player-osd [data-dock-action="subtitles"]').click();
      await expect(p.locator('[data-menu-action="__subs_search__"]')).toBeVisible();
    },
  },
  {
    // Subtitle Sync only lists once a shiftable subtitle is on, so the pane has
    // to be reopened after picking the sidecar.
    name: 'vod-subtitle-offset',
    budget: 0.001,
    go: async (p) => {
      await p.locator('[data-menu-action="__subs_track__"][data-track-index="2000"]').click();
      await p.locator('#player-osd [data-dock-action="subtitles"]').click();
      await p.locator('[data-menu-action="__subs_offset__"]').click();
      await expect(p.locator('#subtitle-offset:not(.hidden)')).toBeVisible();
    },
  },
  {
    // The live player's subtitle offset stays uncovered: the desktop preview
    // drives HLS through hls.js, whose subtitle track can't activate while the
    // neutered <video> keeps the media from ever attaching.
    name: 'vod-subtitle-search',
    budget: 0.001,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await p.locator('#player-osd [data-dock-action="subtitles"]').click();
      await p.locator('[data-menu-action="__subs_search__"]').click();
      await expect(p.locator('#subtitle-search .subs-count').first()).toBeVisible();
    },
  },
  {
    name: 'movies-continue-watching',
    budget: 0,
    go: async (p) => {
      await seedUserData(p, 'playback-progress', [{
        key: 'resume:x1|vod|10',
        value: {
          accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One',
          poster: '', ext: 'mp4', position: 600, duration: 3600, updatedAt: Date.now(),
        },
        updatedAt: Date.now(),
      }]);
      await enterTab(p, 'movies');
      await expect(p.locator('#view-movies .catalog-tile').first()).toBeVisible();
      await expect(p.locator('#view-movies .catalog-rail-title').first())
        .toHaveText('Continue Watching');
      await heroAtRest(p);
    },
  },
  {
    name: 'movies-continue-management',
    budget: 0,
    go: async p => {
      await p.locator('#view-movies [data-collection-manage="continue"]').click();
      await expect(p.locator('#view-movies .catalog-managing')).toBeVisible();
      await p.locator('#view-movies .catalog-remove-mark').hover();
      await expect(p.locator('#view-movies .catalog-remove-mark')).toHaveClass(/focused/);
    },
  },
  {
    // The Movies kind drops the playlist column and docks the account slot.
    name: 'parental-controls-movies',
    budget: 0,
    go: async (p) => {
      // The Xtream setup has no LAN stub, and the entry sits at the top of
      // the first pane anyway.
      await enterTab(p, 'settings');
      await p.locator('#manage-parental-controls').click();
      await enterPin(p);
      await expect(p.locator('.parental-pin-prompt h2')).toContainText('Confirm');
      await enterPin(p);
      const view = p.locator('#view-parental-controls');
      await view.locator('#parental-kind [data-value="vod"]').click();
      const category = view.locator('[data-parental-group]').filter({ hasText: 'Cat A' });
      await category.click();
      await expect(category.locator('.lock-badge.is-locked')).toBeVisible();
      await expect(view.locator('[data-parental-item]').filter({ hasText: 'Movie One' })).toBeVisible();
    },
  },
  {
    name: 'movies-locked',
    budget: 0,
    go: async (p) => {
      await leaveParentalLocked(p);
      await enterTab(p, 'movies');
      await expect(p.locator('#view-movies .catalog-tile .lock-badge.is-locked').first()).toBeVisible();
      await heroAtRest(p);
    },
  },
  {
    name: 'movies-sort-directions',
    budget: 0,
    go: async (p) => {
      // Sorting lives on the category page.
      await p.locator('#view-movies .catalog-layer-browse .catalog-see-all[data-category-id="1"]').click();
      const row = p.locator('#view-movies .catalog-layer-grid .catalog-sort');
      await row.locator('.dropdown-trigger').click();
      await row.locator('[data-dropdown-value="name"]').click();
      await row.locator('[data-sort-direction="desc"]').hover();
      await expect(row.locator('[data-sort-direction="asc"]')).toHaveAttribute('aria-checked', 'true');
    },
  },
  {
    name: 'movies-sort-menu',
    budget: 0,
    go: async (p) => {
      await p.locator('#view-movies .catalog-layer-grid .dropdown-trigger').click();
      await p.mouse.move(1850, 1040);
      await expect(p.locator('#view-movies .dropdown.open')).toBeVisible();
    },
  },
];

/** The Movies hero asks for details once focus rests, so both engines wait
 *  for them before the shot. */
async function heroAtRest(page: Page): Promise<void> {
  await expect(page.locator('#view-movies .catalog-hero-plot')).toHaveText('A plot.');
}

/** Write user-data records straight into the already-created IndexedDB, then
 *  reload — the preview's media pipeline never advances, so nothing the player
 *  would normally persist (resume position, catchup progress) ever appears. */
async function seedUserData(
  page: Page,
  store: string,
  records: { key: string; value: unknown; updatedAt: number }[],
): Promise<void> {
  await page.evaluate(([name, rows]) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('iptv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(name as string, 'readwrite');
      (rows as unknown[]).forEach((row) => tx.objectStore(name as string).put(row));
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), [store, records] as const);
  await page.reload();
}

async function looseTextGaps(modern: Page, legacy: Page): Promise<string[]> {
  return measureLooseText(legacy, await findGappedLooseText(modern));
}

// The generated flex gap margins are scoped to `html.q-no-flex-gap`, which
// makes each one more specific than the component rule it used to yield to —
// a `margin-left: auto` push, most often. Unscope every quirk rule in place
// and report each element whose margins differ from the scoped cascade.
async function quirkScopeMarginShifts(page: Page): Promise<{ rewritten: number; shifts: string[] }> {
  return page.evaluate(() => {
    const QUIRK = 'html.q-no-flex-gap ';
    const sheets = [...document.styleSheets].filter((sheet) => /legacy-webos-/.test(sheet.href || ''));
    const elements = [...document.querySelectorAll<HTMLElement>('body *')];
    const margins = () => elements.map((el) => {
      const style = getComputedStyle(el);
      return `${style.marginTop} ${style.marginRight} ${style.marginBottom} ${style.marginLeft}`;
    });
    const scoped = margins();
    const swapped: [CSSStyleSheet, number, string][] = [];
    for (const sheet of sheets) {
      for (let i = 0; i < sheet.cssRules.length; i++) {
        const rule = sheet.cssRules[i];
        if (!(rule instanceof CSSStyleRule) || rule.selectorText.indexOf(QUIRK) < 0) continue;
        swapped.push([sheet, i, rule.cssText]);
        sheet.deleteRule(i);
        sheet.insertRule(rule.cssText.split(QUIRK).join(''), i);
      }
    }
    const unscoped = margins();
    for (const [sheet, i, text] of swapped) {
      sheet.deleteRule(i);
      sheet.insertRule(text, i);
    }
    // An SVG element's className is an SVGAnimatedString, not its classes.
    const name = (node: Element | null) => node?.getAttribute('class') || node?.tagName.toLowerCase();
    const shifts: string[] = [];
    elements.forEach((el, i) => {
      if (scoped[i] !== unscoped[i]) {
        shifts.push(`.${name(el)} in .${name(el.parentElement)}: ${scoped[i]} vs ${unscoped[i]}`);
      }
    });
    return { rewritten: swapped.length, shifts };
  });
}

async function walk(
  page: Page,
  browser: Browser,
  setUp: (p: Page) => Promise<void>,
  screens: Screen[],
): Promise<void> {
  const legacy = await newLegacyPage(browser);
  await mkdir(DIFF_DIR, { recursive: true });
  try {
    await Promise.all([setUp(page), setUp(legacy.page)]);

    const report: string[] = [];
    const failures: string[] = [];

    for (const screen of screens) {
      await screen.go(page);
      await screen.go(legacy.page);
      const quirkScope = await quirkScopeMarginShifts(legacy.page);
      // Zero means the legacy sheets went unmatched, not that nothing moved.
      expect(quirkScope.rewritten, `${screen.name}: quirk rules unscoped`).toBeGreaterThan(0);
      for (const shift of quirkScope.shifts) {
        const entry = `${screen.name}: quirk scope moved ${shift}`;
        if (failures.indexOf(entry) < 0) failures.push(entry);
      }
      // A toast from an earlier screen fades on a schedule the two pages do
      // not share.
      if (screen.name !== 'watchlist-toast') {
        await Promise.all([page, legacy.page].map((p) =>
          p.locator('.toast.visible').evaluateAll((toasts) => {
            toasts.forEach((toast) => toast.classList.remove('visible'));
          })));
      }
      // Let both settle on the same frame before sampling.
      await page.waitForTimeout(250);
      await legacy.page.waitForTimeout(250);

      const shot = (p: Page) => p.screenshot({ animations: 'disabled', caret: 'hide' });
      const [modernPng, legacyPng] = await Promise.all([shot(page), shot(legacy.page)]);
      const diff = await pixelDiff(page, modernPng, legacyPng, { render: true });

      // Keep the rendered diff for every screen so a passing run stays
      // browsable; the two source frames only when something actually moved.
      if (diff.png) await writeFile(`${DIFF_DIR}/${screen.name}-diff.png`, diff.png);
      if (diff.bbox) {
        await writeFile(`${DIFF_DIR}/${screen.name}-modern.png`, modernPng);
        await writeFile(`${DIFF_DIR}/${screen.name}-legacy.png`, legacyPng);
      }

      // The screen budget is a whole-frame ratio, so a single mis-spaced label
      // can hide under it. Measure that one case directly.
      //
      // Under a loaded suite one page can still be settling when the other is
      // read, which reports a gap that isn't there. A real one does not heal, so
      // only a hit that survives a second look counts.
      const tight = await looseTextGaps(page, legacy.page);
      if (tight.length) {
        await page.waitForTimeout(500);
        await legacy.page.waitForTimeout(500);
        const again = await looseTextGaps(page, legacy.page);
        for (const offender of again) {
          const entry = `${screen.name}: ${offender}`;
          if (tight.indexOf(offender) >= 0 && failures.indexOf(entry) < 0) failures.push(entry);
        }
      }

      const pct = (diff.ratio * 100).toFixed(3);
      report.push(`${screen.name}: ${pct}%${diff.bbox ? ` bbox=${JSON.stringify(diff.bbox)}` : ''}`);
      if (diff.ratio <= screen.budget) continue;

      failures.push(`${screen.name}: ${pct}% > ${(screen.budget * 100).toFixed(3)}%`);
      // Attach all three so the report shows what moved, and where.
      await test.info().attach(`${screen.name}-modern`, { body: modernPng, contentType: 'image/png' });
      await test.info().attach(`${screen.name}-legacy`, { body: legacyPng, contentType: 'image/png' });
      if (diff.png) {
        await test.info().attach(`${screen.name}-diff`, { body: diff.png, contentType: 'image/png' });
      }
    }

    console.log(`\nlegacy layout parity:\n  ${report.join('\n  ')}\n  → ${DIFF_DIR}/\n`);
    expect(failures, 'the legacy fallback moved something the modern engine places elsewhere').toEqual([]);
  } finally {
    await legacy.close();
  }
}

test('the webOS 4 fallbacks lay out where the modern engine does, with an M3U playlist only', async ({ page, browser }) => {
  test.skip(isChromium53(), 'this test drives both engines itself, so it runs once');
  test.setTimeout(180_000);
  await walk(page, browser, prepareM3U, M3U_SCREENS);
});

// An Xtream account adds the Movies/Series sections and the account avatar on
// Home.
test('the webOS 4 fallbacks lay out where the modern engine does, with an Xtream account', async ({ page, browser }) => {
  test.skip(isChromium53(), 'this test drives both engines itself, so it runs once');
  test.setTimeout(180_000);
  await walk(page, browser, prepareXtream, XTREAM_SCREENS);
});
