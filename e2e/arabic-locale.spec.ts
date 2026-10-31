import { seedXtream } from './fixtures/xtream';
import {
  test,
  expect,
  enterTab,
  openGuide,
  neuterVideo,
  routeLiveManifest,
  routePlaylist,
  type Page,
} from './helpers';

// Opened from Home's Live card after every load (see `startOn`).
test.use({ startOn: 'live' });

const PLAYLIST_URL = 'http://host/playlist.m3u';
const GUIDE_URL = 'http://host/guide.xml';
const CHANNELS = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="ch1" group-title="Group 1",ch1',
  'http://host/ch1.m3u8',
  '#EXTINF:-1 tvg-id="ch2" group-title="Group 1",ch2',
  'http://host/ch2.m3u8',
].join('\n');
const EPG = `<tv>
  <channel id="ch1"><display-name>ch1</display-name></channel>
  <programme channel="ch1" start="20260915110000 +0000" stop="20260915130000 +0000">
    <title>Program 1</title></programme>
  <programme channel="ch1" start="20260915130000 +0000" stop="20260915140000 +0000">
    <title>Program 2</title></programme>
</tv>`;
const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/;

test.use({ timezoneId: 'UTC' });

async function setup(page: Page, options: { offset?: number } = {}): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-09-15T12:00:00Z'));
  await routePlaylist(page, CHANNELS);
  await routeLiveManifest(page);
  await page.route(GUIDE_URL, route => route.fulfill({ contentType: 'application/xml', body: EPG }));
  await page.addInitScript(({ playlist, guide, offset }) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ id: 'p1', name: 'P1', url: playlist }]));
    localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: guide, playlistIds: [] }]));
    localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
    localStorage.setItem('iptv_locale', JSON.stringify('ar'));
    if (offset) localStorage.setItem('iptv_epg_offsets', JSON.stringify({ [guide]: offset }));
  }, { playlist: PLAYLIST_URL, guide: GUIDE_URL, offset: options.offset ?? 0 });
}

// Left edge of the first visible glyph of each substring inside the element, so a
// test can compare the on-screen order of runs the bidi algorithm could reorder.
async function glyphLefts(page: Page, selector: string, parts: string[]): Promise<number[]> {
  return page.locator(selector).first().evaluate((element, wanted) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    return wanted.map((part) => {
      for (const node of nodes) {
        const index = node.data.indexOf(part);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        return range.getBoundingClientRect().left;
      }
      throw new Error(`"${part}" not found in ${element.textContent ?? ''}`);
    });
  }, parts);
}

async function expectLeftToRight(page: Page, selector: string, parts: string[]): Promise<void> {
  const lefts = await glyphLefts(page, selector, parts);
  expect(lefts, `${parts.join(' | ')} in ${selector}`).toEqual([...lefts].sort((a, b) => a - b));
}

test('Arabic keeps the LTR layout with Arabic labels and Western digits', async ({ page }) => {
  await setup(page);
  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  expect(await page.evaluate(() => ({
    dir: document.documentElement.getAttribute('dir'),
    direction: getComputedStyle(document.body).direction,
  }))).toEqual({ dir: null, direction: 'ltr' });

  await expect(page.locator('#view-channels .live-header-count')).toHaveText('2 قناة');

  // The preview follows the first row once focus rests on it.
  const range = '#live-preview .live-preview-time-range';
  await expect(page.locator(range)).toHaveText('11:00–13:00');
  await expectLeftToRight(page, range, ['11', '–', '13']);
  await expectLeftToRight(page, '#live-preview .live-preview-program time', ['13', '–', '14']);
  // An Arabic sentence reads right to left: the count sits right of its unit.
  const left = '#live-preview .live-preview-remaining';
  await expect(page.locator(left)).toHaveText('متبقٍ 60 د');
  const [unit, count, word] = await glyphLefts(page, left, ['د', '60', 'م']);
  expect(unit).toBeLessThan(count);
  expect(count).toBeLessThan(word);

  expect(await page.locator('body').innerText()).not.toMatch(ARABIC_INDIC_DIGITS);
});

test('Arabic channel info keeps time ranges and positions in order', async ({ page }) => {
  await neuterVideo(page);
  await setup(page);
  await page.goto('/');
  await expect(page.locator('#channel-browser .channel-main .channel-item').first())
    .toContainText('Program 1');

  await page.keyboard.press('Enter');
  const time = '#player-osd .osd-programme-time span';
  await expect(page.locator(time).first()).toHaveText('11:00 - 13:00');
  await expectLeftToRight(page, time, ['11', '-', '13']);
  await expect(page.locator('#player-osd .osd-remaining')).toHaveText('متبقٍ 1 س 0 د');

  // A signed position with no Arabic letters stays left to right.
  expect(await page.locator('#player-osd').evaluate((osd) => {
    const probe = document.createElement('span');
    probe.className = 'osd-time-current';
    probe.textContent = '-2:00';
    osd.appendChild(probe);
    const range = document.createRange();
    range.setStart(probe.firstChild!, 0);
    range.setEnd(probe.firstChild!, 1);
    const sign = range.getBoundingClientRect().left;
    range.setStart(probe.firstChild!, 1);
    range.setEnd(probe.firstChild!, 2);
    const digit = range.getBoundingClientRect().left;
    probe.remove();
    return sign < digit;
  })).toBe(true);
});

test('Arabic guide keeps its times in reading order', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await expect(page.locator('#channel-browser .channel-main .channel-item').first())
    .toContainText('Program 1');
  await openGuide(page);
  const time = '#live-guide .guide-cell.live .guide-cell-time';
  await expect(page.locator(time).first()).toHaveText('11:00–13:00');
  await expectLeftToRight(page, time, ['11', '–', '13']);
  expect(await page.locator('body').innerText()).not.toMatch(ARABIC_INDIC_DIGITS);
});

test('Arabic EPG time correction keeps its sign with the number', async ({ page }) => {
  await setup(page, { offset: 30 });
  await page.goto('/');
  await enterTab(page, 'settings');
  const guide = page.locator('[data-settings-target="guide"]');
  await expect(guide).toHaveText('دليل البرامج');
  await guide.click();

  const value = '#view-settings .epg-offset-value';
  await expect(page.locator(value)).toContainText('+30');
  await expect(page.locator(value)).toContainText('د');
  const [unit, sign, digit] = await glyphLefts(page, value, ['د', '+', '3']);
  expect(unit).toBeLessThan(sign);
  expect(sign).toBeLessThan(digit);
});

test('Arabic rail titles keep the screen gutter on the right', async ({ page }) => {
  await seedXtream(page, { catalog: 'large' });
  await page.addInitScript(() => localStorage.setItem('iptv_locale', JSON.stringify('ar')));
  await page.goto('/');
  await enterTab(page, 'movies');
  const titles = page.locator('#view-movies .catalog-layer-browse .catalog-rail-title');
  await expect(titles.first()).toBeVisible();
  const rights = await titles.evaluateAll((els) => els
    .filter((el) => el.getBoundingClientRect().width > 0)
    .map((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().right;
    }));
  expect(rights.length).toBeGreaterThan(0);
  for (const right of rights) expect(right).toBeLessThanOrEqual(1920 - 80 + 1);
});

