import { test, expect, openGuide, type Page } from './helpers';

// Opened from Home's Live card after every load (see `startOn`).
test.use({ startOn: 'live' });

test.use({ timezoneId: 'UTC' });

const NOW = new Date('2024-03-09T12:00:00Z');

function playlist(name: string, stream: string, epgUrl = '', group = 'News'): string {
  return [
    epgUrl ? `#EXTM3U url-tvg="${epgUrl}"` : '#EXTM3U',
    `#EXTINF:-1 tvg-id="shared" group-title="${group}",${name}`,
    stream,
  ].join('\n');
}

function epg(name: string, title: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="shared"><display-name>${name}</display-name></channel>
<programme channel="shared" start="20240309110000 +0000" stop="20240309130000 +0000">
  <title>${title}</title>
</programme>
</tv>`;
}

async function setup(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.route('**/list.m3u', (route) => route.fulfill({
    status: 200,
    contentType: 'application/x-mpegurl',
    body: playlist('Alpha', 'http://host/a.m3u8', 'http://host/m3u.xml'),
  }));
  await page.route('**/get.php*', (route) => {
    const second = new URL(route.request().url()).port === '8082';
    return route.fulfill({
      status: 200,
      contentType: 'application/x-mpegurl',
      body: second
        ? playlist('Charlie', 'http://host/c.m3u8', '', 'Sports')
        : playlist('Bravo', 'http://host/b.m3u8'),
    });
  });
  await page.route('**/player_api.php*', (route) => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');
    const second = url.port === '8082';
    const body = action === 'get_live_streams'
      ? [{
          stream_id: second ? 102 : 101,
          direct_source: second ? 'http://host/c.m3u8' : 'http://host/b.m3u8',
          tv_archive: 0,
        }]
      : {};
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  await page.route('**/m3u.xml', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: epg('Alpha', 'Alpha Program') }));
  await page.route('**/xmltv.php*', (route) => {
    const second = new URL(route.request().url()).port === '8082';
    return route.fulfill({
      status: 200,
      contentType: 'application/xml',
      body: second ? epg('Charlie', 'Charlie Program') : epg('Bravo', 'Bravo Program'),
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'm3u', name: 'M3U', url: 'http://host/list.m3u', source: 'url' },
      {
        id: 'x1', name: 'Xtream 1', url: 'http://host:8081', source: 'xtream',
        xtream: { username: 'u1', password: 'p1' },
      },
      {
        id: 'x2', name: 'Xtream 2', url: 'http://host:8082', source: 'xtream',
        xtream: { username: 'u2', password: 'p2' },
      },
    ]));
    localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
  });
}

const row = (page: Page, name: string) =>
  page.locator('#live-guide .guide-row').filter({ has: page.locator('.guide-name', { hasText: name }) });

test('each playlist channel uses its own EPG when XMLTV ids collide', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await openGuide(page);
  await expect(page.locator('#live-guide .guide-row')).toHaveCount(3);
  await expect(row(page, 'Alpha')).toContainText('Alpha Program');
  await expect(row(page, 'Bravo')).toContainText('Bravo Program');
  await expect(row(page, 'Bravo')).not.toContainText('Alpha Program');
  await expect(row(page, 'Charlie')).toContainText('Charlie Program');
  await expect(row(page, 'Charlie')).not.toContainText('Bravo Program');
});

test('applies the saved time correction only to its EPG source', async ({ page }) => {
  await setup(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_epg_offsets', JSON.stringify({
      'http://host/m3u.xml': 60,
    }));
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await openGuide(page);
  await expect(row(page, 'Alpha').locator('.guide-cell-time')).toHaveText('12:00–14:00');
  await expect(row(page, 'Bravo').locator('.guide-cell-time')).toHaveText('11:00–13:00');
});
