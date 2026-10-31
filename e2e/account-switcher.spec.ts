import { test, expect, routeLiveManifest, SAMPLE_M3U, enterTab, type Page } from './helpers';

// Two Xtream accounts on distinct hosts so player_api.php can serve a different
// catalog per account: Alpha (a1) -> "Alpha Movie" under "Cat Alpha"; Bravo (a2)
// -> "Bravo Movie" under "Cat Bravo". Both get.php serve the sample M3U so the
// channels view loads normally for either.
async function seedTwoAccounts(page: Page): Promise<void> {
  await page.route('**/get.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', (route) => {
    const url = route.request().url();
    const bravo = url.includes('host2.example.com');
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('get_vod_categories')) {
      return json([{ category_id: '1', category_name: bravo ? 'Cat Bravo' : 'Cat Alpha' }]);
    }
    if (url.includes('get_vod_streams')) {
      return json([{ stream_id: bravo ? 20 : 10, name: bravo ? 'Bravo Movie' : 'Alpha Movie',
        stream_icon: '', container_extension: 'mp4', category_id: '1' }]);
    }
    // The sign-in check Home makes: player_api.php with no action.
    if (!new URL(url).searchParams.has('action')) return json({ user_info: { auth: 1, status: 'Active' } });
    return json({});
  });
  await page.route('**/movie/**', (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'a1', name: 'Alpha', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'u1', password: 'p' } },
      { id: 'a2', name: 'Bravo', url: 'http://host2.example.com:8080',
        source: 'xtream', xtream: { username: 'u2', password: 'p' } },
    ]));
  });
}

// Open Home's avatar dropdown with a coordinate mouse press (the switcher
// activates on a click hit-test), then wait for the menu.
async function openAccountMenu(page: Page): Promise<void> {
  const avatar = page.locator('.home-account .account-avatar');
  await expect(avatar).toBeVisible();
  const box = await avatar.boundingBox();
  if (!box) throw new Error('account avatar has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator('.account-menu')).toBeVisible();
}

// Choose an account row by id with a coordinate mouse press (same reason as above).
async function pickAccount(page: Page, id: string): Promise<void> {
  const row = page.locator(`.account-menu-item[data-account-id="${id}"]`);
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  if (!box) throw new Error(`account row ${id} has no bounding box`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

const homeAvatar = (page: Page) => page.locator('.home-account .account-avatar');
const homeSlot = (page: Page) => page.locator('.home-account');

async function goHome(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.home-card.focused')).toHaveAttribute('data-section', 'live');
}

test('Home shows the active account initial at the top right, by the name', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await goHome(page);

  // Default active account is the first (Alpha) -> initial "A".
  const avatar = homeAvatar(page);
  await expect(avatar).toHaveText('A');
  await avatar.hover();
  await expect(avatar).toHaveCSS('transform', 'matrix(1.06, 0, 0, 1.06, 0, 0)');

  const avatarBox = await avatar.boundingBox();
  const titleBox = await page.locator('.home-title').boundingBox();
  if (!avatarBox || !titleBox) throw new Error('missing bounding box');
  expect(avatarBox.x).toBeGreaterThan(titleBox.x + titleBox.width);
  expect(avatarBox.y).toBeLessThan(titleBox.y + titleBox.height);
});

test('no account avatar for an M3U-only setup', async ({ page }) => {
  await page.route('**/playlist.m3u', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await routeLiveManifest(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { name: 'Test', url: 'http://host.example.com/playlist.m3u' },
    ]));
  });
  await goHome(page);
  await expect(homeSlot(page)).toBeHidden();
  await expect(page.locator('.account-avatar')).toHaveCount(0);
});

test('the dropdown lists every account with the active one marked', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await goHome(page);

  await openAccountMenu(page);
  await expect(page.locator('.account-menu-item .account-menu-name')).toHaveText(['Alpha', 'Bravo']);
  // Alpha (the active account) carries the current marker.
  await expect(page.locator('.account-menu-item.current .account-menu-name')).toHaveText('Alpha');
});

test('an open account menu holds the only ring, which returns to the avatar on close', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await goHome(page);

  await openAccountMenu(page);
  await expect(page.locator('.account-menu-item.focused')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.account-menu-item.focused .account-menu-name')).toHaveText('Bravo');
  await expect(page.locator('.focused:visible')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(page.locator('.account-menu')).toHaveCount(0);
  await expect(homeSlot(page)).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
});

test('a menu opened with the remote holds the only ring, which returns to the avatar on Back', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await goHome(page);

  await page.keyboard.press('ArrowUp');
  await expect(homeSlot(page)).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('Enter');
  await expect(page.locator('.account-menu')).toBeVisible();
  await expect(page.locator('.account-menu-item.focused')).toHaveCount(1);
  await expect(homeSlot(page)).not.toHaveClass(/(^|\s)focused(\s|$)/);

  await page.keyboard.press('Escape');
  await expect(page.locator('.account-menu')).toHaveCount(0);
  await expect(homeSlot(page)).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
});

test('an account picked on Home persists across a reload, and Movies uses it', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await goHome(page);

  await openAccountMenu(page);
  await pickAccount(page, 'a2');
  await expect(homeAvatar(page)).toHaveText('B');
  // The pick lands on the row, not on the destination under it.
  await page.waitForTimeout(100);
  await expect(page.locator('#view-home')).toBeVisible();

  await page.reload();
  await expect(homeAvatar(page)).toHaveText('B');
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies .catalog-rail-title')).toContainText('Cat Bravo');
  await expect(page.locator('.catalog-tile[data-item-id="20"]')).toContainText('Bravo Movie');
});

test('Search opened after an account is picked on Home searches that account', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await goHome(page);
  await openAccountMenu(page);
  await pickAccount(page, 'a2');
  await expect(homeAvatar(page)).toHaveText('B');

  await enterTab(page, 'search');
  const input = page.locator('.search-box-input');
  await expect(input).toBeFocused();
  await page.keyboard.type('Movie');
  await expect(page.locator('#view-search')).toContainText('Bravo Movie');
  await expect(page.locator('#view-search')).not.toContainText('Alpha Movie');
});

test('the pointer moves the account menu ring, and Back from it returns to the avatar', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await goHome(page);

  await openAccountMenu(page);
  const bravo = page.locator('.account-menu-item[data-account-id="a2"]');
  const box = (await bravo.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(bravo).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
  await expect(page.locator('[data-ring-owner]')).toHaveAttribute('data-focus-scope', 'home.accounts');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.account-menu-item[data-account-id="a1"]')).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(page.locator('.account-menu')).toHaveCount(0);
  await expect(homeSlot(page)).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.home-card.focused')).toHaveCount(1);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
});
