import { test, expect, openLive, routePlaylist, seedPlaylist } from './helpers';

// App bootstrap / first run.

test('lands on Home\'s first run, not Settings, when no source is configured', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#view-home .home-view-first-run')).toBeVisible();
  await expect(page.locator('#view-settings')).toBeHidden();
  await expect(page.locator('.toast.visible')).toHaveCount(0);
});

test('loads and renders channels from a configured playlist', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);

  await page.goto('/');
  await openLive(page);

  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.getByText('Channel One')).toBeVisible();
  await expect(page.getByText('Channel Two')).toBeVisible();
});
