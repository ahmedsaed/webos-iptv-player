import { test, expect, enterTab, type Page } from './helpers';
import { seedXtream } from './fixtures/xtream';

// Pleione's TV navigation: Home first, sections full screen, and Back one
// level up, from a section's top level to Home. Back on Home leaves the app.

const press = (page: Page, key: string) => page.keyboard.press(key);
const back = (page: Page) => press(page, 'Escape');
const homeFocus = (page: Page) => page.locator('#view-home .focused');
const card = (page: Page, section: string) => page.locator(`.home-card[data-section="${section}"]`);

// One Xtream account, on Pleione's Home.
async function seedHome(page: Page): Promise<void> {
  await seedXtream(page);
}

// Home is up and Live has the keys.
async function goHome(page: Page): Promise<void> {
  await page.goto('/');
  await expect(homeFocus(page)).toHaveAttribute('data-section', 'live');
}

async function expectFullScreen(page: Page, view: string): Promise<void> {
  const box = await page.locator(`#view-${view}`).boundingBox();
  expect(box).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
}

async function box(page: Page, section: string) {
  return card(page, section).evaluate((el) => {
    const r = el.getBoundingClientRect();
    // Unscaled, so a focused card measures like the rest.
    const e = el as HTMLElement;
    return { x: r.left + (r.width - e.offsetWidth) / 2, y: r.top + (r.height - e.offsetHeight) / 2,
      w: e.offsetWidth, h: e.offsetHeight };
  });
}

test('Home is the first screen: the name, the clock, the account, and the bento of sections', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/get\.php|xmltv\.php|player_api\.php/.test(url)) requests.push(url);
  });
  await seedHome(page);
  await page.goto('/');
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(page.locator('#view-channels')).toBeHidden();
  await expect(page.locator('.home-title')).toHaveText('Pleione');
  await expect(page.locator('.home-logo')).toBeVisible();
  await expect(page.locator('.home-clock')).toHaveText(/^\d\d:\d\d$/);
  await expect(page.locator('.home-account .account-avatar')).toHaveText('X');
  await expect(page.locator('.home-card .home-card-label')).toHaveText(['Live', 'Movies', 'Series', 'Search', 'Settings']);
  await expect(homeFocus(page)).toHaveAttribute('data-section', 'live');
  await expectFullScreen(page, 'home');
  // No rails and no counts: Home loads no channels, guide, or catalog, and
  // only asks the account whether it still signs in.
  await expect(page.locator('#view-home .catalog-rail, #view-home .catalog-tile')).toHaveCount(0);
  for (const section of ['live', 'movies', 'series']) {
    await expect(card(page, section).locator('.home-card-sub')).toHaveCount(0);
  }
  await expect.poll(() => requests.length).toBe(1);
  await page.waitForTimeout(500);
  expect(requests.map((url) => new URL(url).pathname + (new URL(url).searchParams.get('action') ?? '')))
    .toEqual(['/player_api.php']);
  await expect(page.getByText('Unable to connect')).toHaveCount(0);

  // Live spans both rows on the left; the others pair up beside it.
  const [live, movies, series, search, settings] = await Promise.all(
    ['live', 'movies', 'series', 'search', 'settings'].map((s) => box(page, s)));
  expect(live.h).toBeCloseTo(movies.h * 2 + 32, 0);
  expect(movies.y).toBeCloseTo(live.y, 0);
  expect(search.y + search.h).toBeCloseTo(live.y + live.h, 0);
  expect(movies.x).toBeGreaterThan(live.x + live.w);
  expect(series.x).toBeGreaterThan(movies.x + movies.w);
  expect(settings.x).toBeCloseTo(series.x, 0);
  // Centered on the screen.
  expect(live.x + (series.x + series.w - live.x) / 2).toBeCloseTo(960, 0);
});

test('each section loads its own data when opened from Home', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/get\.php|xmltv\.php|player_api\.php\?.*action=/.test(url)) requests.push(url);
  });
  await seedHome(page);
  await goHome(page);
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies .catalog-tile[data-item-id="10"]')).toBeVisible();
  expect(requests.some((url) => url.includes('get_vod'))).toBe(true);
  expect(requests.some((url) => /get\.php|xmltv\.php/.test(url))).toBe(false);
  await enterTab(page, 'home');
  await enterTab(page, 'live');
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect.poll(() => requests.some((url) => /get\.php|get_live_streams/.test(url))).toBe(true);
  // Home still counts nothing once the channels and the catalog are loaded.
  await enterTab(page, 'home');
  for (const section of ['live', 'movies', 'series']) {
    await expect(card(page, section).locator('.home-card-sub')).toHaveCount(0);
  }
});

test('Search opened from Home loads the channels it matches', async ({ page }) => {
  await seedHome(page);
  await goHome(page);
  await enterTab(page, 'search');
  await page.locator('.search-box-input').fill('one');
  await expect(page.locator('#view-search .search-channel-card[data-channel-index="0"]')).toContainText('Channel One');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toBeVisible();
});

test('a channel number typed on Home loads the channels and tunes', async ({ page }) => {
  await seedHome(page);
  await goHome(page);
  await press(page, '2');
  await expect(page.locator('#view-player')).toBeVisible();
});

// The sign-in check answers `auth` until told otherwise; returns how many
// checks the portal saw.
async function routeSignIn(page: Page, auth: { value: number }): Promise<{ count: number }> {
  const seen = { count: 0 };
  await page.route(/player_api\.php\?username=[^&]+&password=[^&]+$/, (route) => {
    seen.count++;
    return route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ user_info: { auth: auth.value } }),
    });
  });
  return seen;
}

const alert = (page: Page) => page.locator('#view-home .home-alert');

test('a failed sign-in on Home shows the connection banner with Try again focused', async ({ page }) => {
  await seedHome(page);
  await routeSignIn(page, { value: 0 });
  await page.goto('/');
  await expect(alert(page)).toBeVisible();
  await expect(alert(page).locator('.home-alert-title')).toHaveText('Can’t connect to X Account');
  await expect(alert(page).locator('.home-alert-body'))
    .toHaveText('The server didn’t accept the username or password.');
  await expect(homeFocus(page)).toHaveAttribute('data-key', 'alert:retry');
  await expect(page.locator('.toast.visible')).toHaveCount(0);
  // Above the bento on its width, inside the gutters.
  const banner = (await alert(page).boundingBox())!;
  const live = await box(page, 'live');
  const settings = await box(page, 'settings');
  expect(banner.x).toBeCloseTo(live.x, 0);
  expect(banner.x + banner.width).toBeCloseTo(settings.x + settings.w, 0);
  expect(banner.y + banner.height).toBeLessThan(live.y);
  expect(live.y + live.h).toBeLessThanOrEqual(1080 - 80);
});

test('the banner is a D-pad row between the header and the bento, and traps nothing', async ({ page }) => {
  await seedHome(page);
  await routeSignIn(page, { value: 0 });
  await page.goto('/');
  await expect(homeFocus(page)).toHaveAttribute('data-key', 'alert:retry');
  await press(page, 'ArrowRight');
  await expect(homeFocus(page)).toHaveAttribute('data-key', 'alert:edit');
  await press(page, 'ArrowUp');
  await expect(homeFocus(page)).toHaveAttribute('data-key', 'account');
  await press(page, 'ArrowDown');
  await expect(homeFocus(page)).toHaveAttribute('data-key', 'alert:edit');
  await press(page, 'ArrowDown');
  await expect(homeFocus(page)).toHaveAttribute('data-section', 'live');
  await press(page, 'ArrowRight');
  await expect(homeFocus(page)).toHaveAttribute('data-section', 'movies');
  await press(page, 'ArrowUp');
  await expect(homeFocus(page)).toHaveAttribute('data-key', 'alert:edit');
  await press(page, 'ArrowLeft');
  await press(page, 'ArrowLeft');
  await expect(homeFocus(page)).toHaveAttribute('data-key', 'alert:retry');
  await expect(page.locator('#view-home')).toBeVisible();
});

test('Try again checks again, keeps the banner while it fails, and a pass removes it', async ({ page }) => {
  await seedHome(page);
  const auth = { value: 0 };
  const seen = await routeSignIn(page, auth);
  await page.goto('/');
  await expect(homeFocus(page)).toHaveAttribute('data-key', 'alert:retry');
  await expect.poll(() => seen.count).toBe(1);
  await press(page, 'Enter');
  await expect.poll(() => seen.count).toBe(2);
  await expect(alert(page)).toBeVisible();
  await expect(homeFocus(page)).toHaveAttribute('data-key', 'alert:retry');

  auth.value = 1;
  await press(page, 'Enter');
  await expect.poll(() => seen.count).toBe(3);
  await expect(alert(page)).toHaveCount(0);
  // The keys return to the bento, and the bento to its place.
  await expect(homeFocus(page)).toHaveAttribute('data-section', 'live');
  const live = await box(page, 'live');
  const movies = await box(page, 'movies');
  expect(live.h).toBeCloseTo(movies.h * 2 + 32, 0);
  expect(live.y + live.h / 2).toBeCloseTo(540, 0);
});

test('the pointer reaches the banner: Try again re-checks and Edit account opens that account', async ({ page }) => {
  await seedHome(page);
  const seen = await routeSignIn(page, { value: 0 });
  await page.goto('/');
  await expect(alert(page)).toBeVisible();
  const retry = page.locator('[data-key="alert:retry"]');
  const edit = page.locator('[data-key="alert:edit"]');
  await edit.hover();
  await expect(edit).toHaveClass(/\bfocused\b/);
  await retry.click();
  await expect.poll(() => seen.count).toBe(2);
  await expect(alert(page)).toBeVisible();

  await edit.click();
  await expect(page.locator('#view-settings')).toBeVisible();
  await expect(page.locator('#settings-sources')).toHaveClass(/\bactive\b/);
  await expect(page.locator('.xtream-card[data-id="x1"] .xtream-password')).toBeVisible();
});

test('Edit account with the D-pad opens Settings on the account', async ({ page }) => {
  await seedHome(page);
  await routeSignIn(page, { value: 0 });
  await page.goto('/');
  await expect(homeFocus(page)).toHaveAttribute('data-key', 'alert:retry');
  await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await expect(page.locator('#view-settings')).toBeVisible();
  await expect(page.locator('#view-settings .focused'))
    .toHaveClass(/\bxtream-password\b/);
  await expect(page.locator('#view-settings .focused').locator('xpath=ancestor::div[contains(@class,"xtream-card")]'))
    .toHaveAttribute('data-id', 'x1');
});

test('the D-pad moves across the bento, Up reaches the account, and the glow follows focus', async ({ page }) => {
  await seedHome(page);
  await goHome(page);
  const view = page.locator('.home-view');
  await expect(view).toHaveAttribute('data-tint', 'live');
  await press(page, 'ArrowRight');
  await expect(homeFocus(page)).toHaveAttribute('data-section', 'movies');
  await expect(view).toHaveAttribute('data-tint', 'movies');
  await press(page, 'ArrowRight');
  await expect(homeFocus(page)).toHaveAttribute('data-section', 'series');
  await press(page, 'ArrowDown');
  await expect(homeFocus(page)).toHaveAttribute('data-section', 'settings');
  await press(page, 'ArrowLeft');
  await expect(homeFocus(page)).toHaveAttribute('data-section', 'search');
  await press(page, 'ArrowLeft');
  await expect(homeFocus(page)).toHaveAttribute('data-section', 'live');
  // Right goes back to the row Left came from.
  await press(page, 'ArrowRight');
  await expect(homeFocus(page)).toHaveAttribute('data-section', 'search');
  await press(page, 'ArrowUp');
  await press(page, 'ArrowUp');
  await expect(homeFocus(page)).toHaveAttribute('data-key', 'account');
  await press(page, 'ArrowDown');
  await expect(homeFocus(page)).toHaveAttribute('data-section', 'movies');
  // The focused card grows; one ring at a time (the fixture checks every key).
  const focused = await card(page, 'movies').evaluate((el) => getComputedStyle(el).transform);
  expect(focused).not.toBe('none');
});

for (const [section, view] of [
  ['live', 'channels'], ['movies', 'movies'], ['series', 'series'],
  ['search', 'search'], ['settings', 'settings'],
] as const) {
  test(`the ${section} destination opens full screen; Back goes Home on its card`, async ({ page }) => {
    await seedHome(page);
    await goHome(page);
    const path: Record<string, string[]> = {
      live: [], movies: ['ArrowRight'], series: ['ArrowRight', 'ArrowRight'],
      search: ['ArrowRight', 'ArrowDown'], settings: ['ArrowRight', 'ArrowRight', 'ArrowDown'],
    };
    for (const key of path[section]) await press(page, key);
    await expect(homeFocus(page)).toHaveAttribute('data-section', section);
    await press(page, 'Enter');
    await expect(page.locator(`#view-${view}`)).toBeVisible();
    await expectFullScreen(page, view);
    // Search keeps the caret in its box, where Back is the top level too.
    await back(page);
    await expect(page.locator('#view-home')).toBeVisible();
    await expect(page.locator(`#view-${view}`)).toBeHidden();
    await expect(homeFocus(page)).toHaveAttribute('data-section', section);
  });
}

test('Left at the left edge of a section stays where it is', async ({ page }) => {
  await seedHome(page);
  await goHome(page);
  await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await expect(page.locator('#view-movies .catalog-tile[data-focusable]').first()).toBeVisible();
  await press(page, 'ArrowDown');
  const tile = page.locator('#view-movies .catalog-tile.focused');
  await expect(tile).toHaveCount(1);
  const key = await tile.getAttribute('data-key');
  await press(page, 'ArrowLeft');
  await press(page, 'ArrowLeft');
  await expect(tile).toHaveAttribute('data-key', key!);
  await expect(page.locator('#view-movies')).toBeVisible();

  // Live: Left from a channel row reaches the groups, and stops there.
  await enterTab(page, 'live');
  await page.locator('.channel-item').first().waitFor();
  await press(page, 'ArrowDown');
  await press(page, 'ArrowLeft');
  const group = page.locator('#view-channels .group-item.focused');
  await expect(group).toHaveCount(1);
  const groupKey = await group.getAttribute('data-key');
  await press(page, 'ArrowLeft');
  await expect(group).toHaveAttribute('data-key', groupKey!);
  await expect(page.locator('#view-channels .focused')).toHaveCount(1);
});

test('Left on Home\'s Live card stays on it', async ({ page }) => {
  await seedHome(page);
  await goHome(page);
  await press(page, 'ArrowLeft');
  await expect(homeFocus(page)).toHaveAttribute('data-section', 'live');
  await expect(page.locator('#view-home .focused')).toHaveCount(1);
});

// LG store checklist: Back on the entry page shows the TV's Home screen.
test('Back on Home leaves the app in one press, with no hint', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __closed: number };
    w.__closed = 0;
    window.close = () => { w.__closed += 1; };
  });
  await seedHome(page);
  await goHome(page);
  await back(page);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __closed: number }).__closed)).toBe(1);
  await expect(page.locator('.toast.visible')).toHaveCount(0);
});

test('Back on Home closes the app instead of raising the launcher through platformBack', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __calls: string[]; PalmSystem: { platformBack: () => void } };
    w.__calls = [];
    w.PalmSystem = { platformBack: () => { w.__calls.push('platformBack'); } };
    window.close = () => { w.__calls.push('close'); };
  });
  await seedHome(page);
  await goHome(page);
  await back(page);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __calls: string[] }).__calls))
    .toEqual(['close']);
});

test('first run shows the welcome, phone setup, and the two Add cards, Add Xtream focused', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(page.locator('.home-welcome-title')).toHaveText('Welcome to Pleione');
  await expect(page.locator('#view-home .home-bento')).toHaveCount(0);
  await expect(page.locator('.home-card .home-card-label')).toHaveText(['Add Xtream account', 'Add M3U playlist']);
  // No LAN service on the desktop preview.
  await expect(page.locator('.home-setup')).toContainText('The setup service is currently unavailable.');
  await expect(homeFocus(page)).toHaveAttribute('data-key', 'add:xtream');
  await expect(page.locator('.toast.visible')).toHaveCount(0);
  // The welcome, the panel, and the cards keep the 80px gutters.
  for (const sel of ['.home-welcome', '.home-setup', '[data-key="add:xtream"]', '[data-key="add:playlist"]']) {
    const b = (await page.locator(sel).boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(80);
    expect(b.x + b.width).toBeLessThanOrEqual(1920 - 80);
    expect(b.y + b.height).toBeLessThanOrEqual(1080 - 80);
  }
});

test('the first-run cards open the Add flows by D-pad and pointer', async ({ page }) => {
  await page.goto('/');
  await expect(homeFocus(page)).toHaveAttribute('data-key', 'add:xtream');
  await press(page, 'Enter');
  await expect(page.locator('#view-settings')).toBeVisible();
  await expect(page.locator('#settings-sources')).toHaveClass(/\bactive\b/);
  await expect(page.locator('#xtream-entries .xtream-card')).toHaveCount(1);
  await expect(page.locator('#view-settings .focused')).toHaveClass(/\bxtream-name\b/);
  // Cancel returns to the first run, where it was left.
  await page.locator('#cancel-settings').click();
  await expect(page.locator('#view-home .home-first-run')).toBeVisible();

  await press(page, 'ArrowDown');
  await expect(homeFocus(page)).toHaveAttribute('data-key', 'add:playlist');
  await press(page, 'ArrowDown');
  await expect(homeFocus(page)).toHaveAttribute('data-key', 'add:playlist');
  await press(page, 'ArrowUp');
  await expect(homeFocus(page)).toHaveAttribute('data-key', 'add:xtream');

  await page.locator('[data-key="add:playlist"]').click();
  await expect(page.locator('#view-settings')).toBeVisible();
  await expect(page.locator('#playlist-entries [data-source-entry]')).toHaveCount(1);
  await expect(page.locator('#playlist-entries .playlist-name')).toBeFocused();
});

test('first run shows the phone setup the LAN service offers', async ({ page }) => {
  // The later route wins: /info over the catch-all.
  await page.route('http://127.0.0.1:9999/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('http://127.0.0.1:9999/info', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ip: '10.0.0.2', port: 9999, setupUrl: 'http://host/setup?token=t1',
      manualUrl: 'http://host/a', pairingCode: '1234' }),
  }));
  await page.addInitScript(() => {
    class FakePalmServiceBridge {
      onservicecallback: ((message: string) => void) | null = null;
      call(uri: string): void {
        const method = uri.slice(uri.lastIndexOf('/') + 1);
        const response = method === 'start' ? { running: true, port: 9999 }
          : method === 'serviceEvents' ? { subscribed: true } : { returnValue: false };
        setTimeout(() => this.onservicecallback?.(JSON.stringify(response)), 0);
      }
      cancel(): void { this.onservicecallback = null; }
    }
    (window as unknown as { PalmServiceBridge?: unknown }).PalmServiceBridge = FakePalmServiceBridge;
  });
  await page.goto('/');
  await expect(page.locator('.home-setup-qr')).toBeVisible();
  await expect(page.locator('.home-setup-url')).toHaveText('http://host/a');
  await expect(page.locator('.home-setup-code')).toHaveText('1234');
  // The QR is square and stays inside its panel.
  const qr = (await page.locator('.home-setup-qr').boundingBox())!;
  const panel = (await page.locator('.home-setup').boundingBox())!;
  expect(qr.width).toBeCloseTo(qr.height, 0);
  expect(qr.y + qr.height).toBeLessThanOrEqual(panel.y + panel.height);
});

test('the pointer resting at the left edge reveals nothing', async ({ page }) => {
  await seedHome(page);
  await goHome(page);
  await press(page, 'Enter');
  await page.locator('.channel-item').first().waitFor();
  await page.mouse.move(400, 500);
  await page.mouse.move(0, 500);
  await page.waitForTimeout(800);
  await expect(page.locator('#view-channels')).toBeVisible();
  // Nothing covers the content at the edge.
  const atEdge = await page.evaluate(() => {
    const hit = document.elementFromPoint(2, 500);
    return !!hit && !!hit.closest('#view-channels');
  });
  expect(atEdge).toBe(true);
});

test('the account switcher on Home switches the account', async ({ page }) => {
  await seedXtream(page);
  await page.addInitScript(() => {
    const list = JSON.parse(localStorage.getItem('iptv_playlists')!) as unknown[];
    list.push({ id: 'x2', name: 'Y Account', url: 'http://host.example.com:8081',
      source: 'xtream', xtream: { username: 'u', password: 'p' } });
    localStorage.setItem('iptv_playlists', JSON.stringify(list));
  });
  await goHome(page);
  await press(page, 'ArrowUp');
  await expect(homeFocus(page)).toHaveAttribute('data-key', 'account');
  await press(page, 'Enter');
  await expect(page.locator('#view-home .account-menu-item')).toHaveCount(2);
  await back(page);
  await expect(page.locator('#view-home .account-menu')).toHaveCount(0);

  await press(page, 'Enter');
  await expect(page.locator('#view-home .account-menu-item')).toHaveCount(2);
  await press(page, 'ArrowDown');
  await press(page, 'Enter');
  await expect(page.locator('#view-home .account-menu')).toHaveCount(0);
  await expect(page.locator('.home-account .account-avatar')).toHaveText('Y');
});

test('Lock now stays reachable on Home during a PIN session', async ({ page }) => {
  await seedHome(page);
  await goHome(page);
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(page.locator('[data-lock-now]')).toHaveCount(0);
  // Leaving the manager keeps an unlock session open.
  await enterTab(page, 'settings');
  await page.locator('#manage-parental-controls').click();
  const prompt = page.locator('.parental-pin-prompt');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(prompt.locator('h2')).toContainText('Confirm');
  await prompt.locator('.parental-pin-input').fill('1234');
  await page.locator('[data-parental-tab="options"]').click();
  await page.locator('#parental-duration [data-value="until-backgrounded"]').click();
  await page.locator('[data-parental-back]').click();
  await expect(page.locator('#view-settings')).toBeVisible();

  await enterTab(page, 'home');
  const lock = page.locator('#view-home .home-lock');
  await expect(lock).toHaveText('Lock now');
  await lock.click();
  await expect(page.locator('[data-lock-now]')).toHaveCount(0);
});

test('Interface size 130 at text size 150 keeps the bento centered, on the canvas, and under the header', async ({ page }) => {
  await seedHome(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_interface_size', JSON.stringify('130'));
    localStorage.setItem('iptv_text_size', JSON.stringify('150'));
    localStorage.setItem('iptv_locale', JSON.stringify('de'));
  });
  await goHome(page);
  await expectFullScreen(page, 'home');
  const header = await page.locator('.home-header').boundingBox();
  const boxes = await Promise.all(['live', 'movies', 'series', 'search', 'settings'].map((s) => box(page, s)));
  for (const b of boxes) {
    expect(b.x).toBeGreaterThanOrEqual(80);
    expect(b.x + b.w).toBeLessThanOrEqual(1920 - 80);
    expect(b.y).toBeGreaterThan(header!.y + header!.height);
    expect(b.y + b.h).toBeLessThanOrEqual(1080);
  }
  expect(boxes[0].x + (boxes[2].x + boxes[2].w - boxes[0].x) / 2).toBeCloseTo(960, 0);
  // The longest label fits its card.
  const label = card(page, 'settings').locator('.home-card-label');
  await expect(label).toHaveText('Einstellungen');
  expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('Arabic labels Home', async ({ page }) => {
  await seedHome(page);
  await page.addInitScript(() => localStorage.setItem('iptv_locale', JSON.stringify('ar')));
  await goHome(page);
  await expect(card(page, 'live').locator('.home-card-label')).toHaveText('مباشر');
});

test('a light theme keeps the cards and darkens the header text', async ({ page }) => {
  await seedHome(page);
  await page.addInitScript(() => localStorage.setItem('iptv_theme', JSON.stringify('daylight')));
  await goHome(page);
  const colors = await page.evaluate(() => ({
    title: getComputedStyle(document.querySelector('.home-title')!).color,
    label: getComputedStyle(document.querySelector('.home-card-label')!).color,
  }));
  expect(colors.label).toBe('rgb(255, 255, 255)');
  expect(colors.title).not.toBe('rgb(255, 255, 255)');
});

test('Save and Cancel in Settings return to Home, where Settings was opened', async ({ page }) => {
  await seedHome(page);
  await goHome(page);
  await enterTab(page, 'settings');
  await expect(page.locator('#view-settings')).toBeVisible();
  await page.locator('#save-settings').click();
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(page.locator('#view-channels')).toBeHidden();

  await enterTab(page, 'settings');
  await expect(page.locator('#view-settings')).toBeVisible();
  await page.locator('#cancel-settings').click();
  await expect(page.locator('#view-home')).toBeVisible();
});

test('in pointer mode each section offers a Home button; keys hide it', async ({ page }) => {
  await seedHome(page);
  await goHome(page);
  const button = page.locator('.home-button');
  // Home itself needs none.
  await page.mouse.move(900, 1000);
  await page.mouse.move(960, 1040);
  await expect(button).toBeHidden();
  for (const [section, view] of [
    ['live', 'channels'], ['movies', 'movies'], ['series', 'series'],
    ['search', 'search'], ['settings', 'settings'],
  ] as const) {
    await enterTab(page, section);
    await expect(page.locator(`#view-${view}`)).toBeVisible();
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-label', 'Home');
    // Clear of the screen's edges, inside the canvas.
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1920);
    expect(box.y + box.height).toBeLessThanOrEqual(1080);
    await button.click();
    await expect(page.locator('#view-home')).toBeVisible();
    await expect(button).toBeHidden();
    // It never takes a ring.
    await expect(page.locator('.home-button.focused')).toHaveCount(0);
  }

  // A key hands the screen back to the remote: the button goes.
  await enterTab(page, 'movies');
  await expect(button).toBeVisible();
  await press(page, 'ArrowDown');
  await expect(button).toBeHidden();
  // OK after the click does not press the button again.
  await expect(page.locator('#view-movies')).toBeVisible();
});

// The Movies hero follows the lit tile, by pointer and by key, through the
// re-renders that wheel steps and arriving rail data cause.
test('the Movies hero follows the lit tile through re-renders, by pointer and by key', async ({ page }) => {
  await seedXtream(page, { catalog: 'large' });
  await goHome(page);
  await enterTab(page, 'movies');
  const view = page.locator('#view-movies .catalog-layer-browse');
  await expect(view.locator('[data-rail-key="cat:3"] .catalog-tile').first()).toBeVisible();
  const heroTitle = view.locator('.catalog-hero-title');
  const lit = view.locator('.catalog-tile.focused:not(.catalog-see-all) .catalog-tile-name');
  const hover = async (rail: string, index: number): Promise<void> => {
    const tile = view.locator(`[data-rail-key="${rail}"] .catalog-tile:not(.catalog-see-all)`).nth(index);
    const box = (await tile.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2 + 4, box.y + 60);
    await page.mouse.move(box.x + box.width / 2, box.y + 60);
    await expect(lit).toHaveCount(1);
    await expect(heroTitle).toHaveText((await lit.textContent())!);
  };
  await hover('cat:1', 2);
  await hover('cat:1', 4);
  // The wheel steps the rails, re-rendering them under the resting pointer.
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(600);
  await hover('cat:2', 1);
  await hover('cat:2', 3);
  await page.waitForTimeout(800);
  await expect(heroTitle).toHaveText((await lit.textContent())!);

  // Keys move the same focus, and the hero with it.
  for (const key of ['ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowLeft']) {
    await press(page, key);
    await expect(lit).toHaveCount(1);
    await expect(heroTitle).toHaveText((await lit.textContent())!);
  }
});
