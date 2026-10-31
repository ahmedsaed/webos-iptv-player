import { test, expect, enterTab, routeLiveManifest, pressKeys, type Page } from './helpers';
import { seedXtream } from './fixtures/xtream';

// Back goes up one level, from every page's own steps to its section, from the
// section to Home, and from Home out of the app (LG store checklist: Back on
// the entry page shows the TV's Home screen).

const BACK = 461;
const RED = 403;
const home = (page: Page) => page.locator('#view-home');
const homeFocus = (page: Page) => page.locator('#view-home .focused');

// A Home-first Xtream setup whose exit only counts.
async function boot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __exits: number };
    w.__exits = 0;
    window.close = () => { w.__exits += 1; };
  });
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(homeFocus(page)).toHaveAttribute('data-section', 'live');
}

const exits = (page: Page) => page.evaluate(() => (window as unknown as { __exits: number }).__exits);

async function back(page: Page): Promise<void> {
  await pressKeys(page, BACK);
}

// Back on Home lands on the section's card; one more Back leaves the app.
async function expectHomeThenExit(page: Page, section: string): Promise<void> {
  await expect(home(page)).toBeVisible();
  await expect(homeFocus(page)).toHaveAttribute('data-section', section);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
  expect(await exits(page)).toBe(0);
  await back(page);
  await expect.poll(() => exits(page)).toBe(1);
}

test('Live: Back from the list goes Home, then out of the app', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-channels .channel-item').first()).toBeVisible();
  await back(page);
  await expectHomeThenExit(page, 'live');
});

test('Live: Back from the Guide steps to its groups, then Home', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-channels .channel-item').first()).toBeVisible();
  await pressKeys(page, RED);
  await expect(page.locator('#view-channels.live-guide-mode #live-guide .guide-cell').first()).toBeVisible();
  await expect(page.locator('#live-guide .focused')).toHaveCount(1);
  await back(page);
  await expect(page.locator('#view-channels.live-guide-mode')).toBeVisible();
  await expect(page.locator('#view-channels .group-item.focused')).toHaveCount(1);
  await back(page);
  await expectHomeThenExit(page, 'live');
});

test('Live: Back from full-screen playback returns to the list it started on', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-channels .channel-item').first()).toBeVisible();
  await page.keyboard.press('1');
  await expect(page.locator('#view-player')).toBeVisible();
  await back(page);
  if (await page.locator('#view-player').isVisible()) await back(page);
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(home(page)).toBeHidden();
  await back(page);
  await expectHomeThenExit(page, 'live');
});

test('Home: Back from playback started on Home returns to Home', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('1');
  await expect(page.locator('#view-player')).toBeVisible();
  await back(page);
  if (await page.locator('#view-player').isVisible()) await back(page);
  await expect(home(page)).toBeVisible();
  await expect(page.locator('#view-channels')).toBeHidden();
  expect(await exits(page)).toBe(0);
});

test('Settings: Back closes an open dropdown first, then goes Home', async ({ page }) => {
  await boot(page);
  await enterTab(page, 'settings');
  const dropdown = page.locator('#app-language');
  await dropdown.locator('.dropdown-trigger').click();
  await expect(dropdown).toHaveClass(/\bopen\b/);
  await back(page);
  await expect(dropdown).not.toHaveClass(/\bopen\b/);
  await expect(page.locator('#view-settings')).toBeVisible();
  await back(page);
  await expectHomeThenExit(page, 'settings');
});

test('Reminders: Back returns to Settings, then Home', async ({ page }) => {
  await boot(page);
  await enterTab(page, 'settings');
  await page.locator('[data-settings-target="guide"]').click();
  await page.locator('#manage-reminders').click();
  await expect(page.locator('#view-reminders')).toBeVisible();
  await back(page);
  await expect(page.locator('#view-settings')).toBeVisible();
  await expect(page.locator('#manage-reminders')).toHaveClass(/\bfocused\b/);
  await back(page);
  await expectHomeThenExit(page, 'settings');
});

test('Parental controls: Back returns to Settings, then Home', async ({ page }) => {
  await boot(page);
  await enterTab(page, 'settings');
  await page.locator('#manage-parental-controls').click();
  const prompt = page.locator('.parental-pin-prompt');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(prompt.locator('h2')).toContainText('Confirm');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(page.locator('#view-parental-controls')).toBeVisible();
  // The keys go back to the remote before Back.
  await page.keyboard.press('ArrowDown');
  await back(page);
  await expect(page.locator('#view-settings')).toBeVisible();
  await back(page);
  await expectHomeThenExit(page, 'settings');
});

test('Movies and Series: Back from a detail steps to browse, then Home', async ({ page }) => {
  await boot(page);
  for (const [section, tile] of [['movies', '10'], ['series', '20']] as const) {
    await enterTab(page, section);
    const card = page.locator(`#view-${section} .catalog-tile[data-item-id="${tile}"]`).first();
    await expect(card).toBeVisible();
    await card.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
    await page.keyboard.press('Enter');
    await expect(page.locator(`#view-${section} .catalog-detail`)).toBeVisible();
    await back(page);
    await expect(page.locator(`#view-${section} .catalog-detail`)).toHaveCount(0);
    await expect(page.locator(`#view-${section}`)).toBeVisible();
    await back(page);
    await expect(home(page)).toBeVisible();
    await expect(homeFocus(page)).toHaveAttribute('data-section', section);
  }
  await back(page);
  await expect.poll(() => exits(page)).toBe(1);
});

test('Search: Back from the results to the box, then Home', async ({ page }) => {
  await boot(page);
  await enterTab(page, 'search');
  const input = page.locator('.search-box-input');
  await expect(input).toBeFocused();
  await input.fill('one');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toBeVisible();
  await input.press('ArrowDown');
  await expect(page.locator('#view-search .focused')).toHaveCount(1);
  await back(page);
  await expect(input).toBeFocused();
  await back(page);
  await expectHomeThenExit(page, 'search');
});

test('a menu on Home keeps its own Back: it closes before Back leaves the app', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('ArrowUp');
  await expect(homeFocus(page)).toHaveAttribute('data-key', 'account');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-home .account-menu')).toBeVisible();
  await back(page);
  await expect(page.locator('#view-home .account-menu')).toHaveCount(0);
  await expect(home(page)).toBeVisible();
  expect(await exits(page)).toBe(0);
  await back(page);
  await expect.poll(() => exits(page)).toBe(1);
});
