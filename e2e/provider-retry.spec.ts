import { test, expect, enterTab, type Page } from './helpers';
import { seedXtream } from './fixtures/xtream';

// Opened from Home's Live card after every load (see `startOn`).
test.use({ startOn: 'live' });

// Counts each routed request to one player_api action; the first `failures`
// get `status`, the rest fall through to the seeded portal.
async function failAction(
  page: Page,
  action: string,
  status: number,
  failures: number,
): Promise<{ count: () => number }> {
  let requests = 0;
  await page.route('**/player_api.php*', (route) => {
    if (new URL(route.request().url()).searchParams.get('action') !== action) {
      return route.fallback();
    }
    requests++;
    if (requests > failures) return route.fallback();
    return route.fulfill({ status, contentType: 'text/plain', body: 'unavailable' });
  });
  return { count: () => requests };
}

test('retries a provider server error and shows the catalog', async ({ page }) => {
  await seedXtream(page);
  const categories = await failAction(page, 'get_vod_categories', 500, 2);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');

  // Two failures wait 1 s, then 2 s, before the third request succeeds.
  await expect(page.locator('#view-movies .catalog-tile[data-item-id="10"]'))
    .toBeVisible({ timeout: 15000 });
  expect(categories.count()).toBeGreaterThanOrEqual(3);
});

test('does not retry a missing catalog list', async ({ page }) => {
  await seedXtream(page);
  const streams = await failAction(page, 'get_vod_streams', 404, Infinity);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');

  // The rail fails at once, leaving only the category index to open.
  const allCategories = page.locator('#view-movies .catalog-rail-title')
    .filter({ hasText: 'All Categories' });
  await expect(allCategories).toBeVisible({ timeout: 2000 });
  await expect(page.locator('#view-movies .catalog-tile[data-item-id="10"]')).toHaveCount(0);
  const requests = streams.count();
  expect(requests).toBeGreaterThanOrEqual(1);
  // Past the first retry delay, a retried request would have gone out.
  await page.waitForTimeout(1500);
  expect(streams.count()).toBe(requests);
});
