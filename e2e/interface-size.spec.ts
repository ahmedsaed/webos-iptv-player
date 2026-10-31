import {
  liveAfterSave,
  test, expect, enterTab, openGuide, pressKeys, routePlaylist, seedPlaylist, type Page,
} from './helpers';
import { seedXtream } from './fixtures/xtream';

// Opened from Home's Live card after every load (see `startOn`).
test.use({ startOn: 'live' });

const SIZES = ['90', '110', '120', '130'] as const;

async function seedInterfaceSize(page: Page, size: string): Promise<void> {
  await page.addInitScript((s) => {
    localStorage.setItem('iptv_interface_size', JSON.stringify(s));
  }, size);
}

// Focus targets the screen edge cuts off, rather than a scroll container: the
// part of each target its clipping ancestors leave visible must fit 1920x1080.
async function offscreenTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const W = 1920;
    const H = 1080;
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-focusable]'))) {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height || !el.offsetParent
        || getComputedStyle(el).visibility === 'hidden') continue;
      let left = rect.left;
      let top = rect.top;
      let right = rect.right;
      let bottom = rect.bottom;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const box = a.getBoundingClientRect();
        left = Math.max(left, box.left);
        top = Math.max(top, box.top);
        right = Math.min(right, box.right);
        bottom = Math.min(bottom, box.bottom);
      }
      if (right <= left || bottom <= top) continue;
      if (left < -1 || top < -1 || right > W + 1 || bottom > H + 1) {
        const label = el.id || el.dataset.key || el.className.toString().split(' ')[0];
        out.push(`${label} [${Math.round(left)},${Math.round(top)} → ${Math.round(right)},${Math.round(bottom)}]`);
      }
    }
    return out;
  });
}

for (const size of SIZES) {
  test(`at ${size}% every view scales and keeps its targets on screen`, async ({ page }) => {
    const scale = Number(size) / 100;
    await seedXtream(page, { catalog: 'large' });
    await seedInterfaceSize(page, size);
    await page.goto('/');
    await expect(page.locator('#view-channels')).toBeVisible();

    expect(await offscreenTargets(page), 'Live').toEqual([]);
    await openGuide(page);
    expect(await offscreenTargets(page), 'Guide').toEqual([]);
    await pressKeys(page, 403);
    await expect(page.locator('#view-channels:not(.live-guide-mode)')).toBeVisible();

    for (const [section, view] of [
      ['home', '#view-home'],
      ['movies', '#view-movies'],
      ['series', '#view-series'],
    ] as const) {
      await enterTab(page, section);
      await expect(page.locator(view)).toBeVisible();
      await page.waitForTimeout(300);
      expect(await offscreenTargets(page), section).toEqual([]);
      if (section === 'home') {
        // The Live card holds its height until the header would crowd it.
        const height = await page.locator('.home-card-live')
          .evaluate((el) => (el as HTMLElement).offsetHeight);
        expect(height).toBeCloseTo(Math.min(592 * scale, 1080 - 340 * scale), 0);
      }
    }

    await enterTab(page, 'search');
    await expect(page.locator('.search-box-input')).toBeFocused();
    await page.locator('.search-box-input').fill('movie');
    await expect(page.locator('#view-search')).toBeVisible();
    await page.waitForTimeout(300);
    expect(await offscreenTargets(page), 'search').toEqual([]);

    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();
    for (const category of ['general', 'sources', 'guide', 'appearance', 'playback', 'subtitles', 'advanced', 'data']) {
      await page.locator(`[data-settings-target="${category}"]`).click();
      await page.waitForTimeout(150);
      // Settings scrolls its categories; only its frame and actions must fit.
      const actions = await page.locator('#save-settings').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { right: r.right, bottom: r.bottom };
      });
      expect(actions.bottom, `${category}: Save sits on screen`).toBeLessThanOrEqual(1081);
      expect(actions.right, `${category}: Save sits on screen`).toBeLessThanOrEqual(1921);
    }
  });
}

test('at 130% the virtualized channel list keeps rows, D-pad, and pointer aligned', async ({ page }) => {
  const m3u = ['#EXTM3U', ...Array.from({ length: 80 }, (_, i) => (
    `#EXTINF:-1 group-title="Group 1",Channel ${String(i + 1)}\nhttp://host/${String(i + 1)}.m3u8`))].join('\n');
  await routePlaylist(page, m3u);
  await seedPlaylist(page);
  await seedInterfaceSize(page, '130');
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  // The virtualizer's stride matches the CSS row height at this scale.
  const tops = await page.locator('#view-channels .channel-item').evaluateAll((rows) =>
    rows.slice(0, 3).map((row) => row.getBoundingClientRect().top));
  expect(tops[1] - tops[0]).toBeCloseTo(122 * 1.3, 0);
  expect(tops[2] - tops[1]).toBeCloseTo(122 * 1.3, 0);

  // Scroll far down the list with the D-pad; the focused row stays inside it.
  const focusedName = () => page.locator('#view-channels .channel-item.focused .channel-name').innerText();
  const start = Number((await focusedName()).replace(/\D+/g, ''));
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowDown');
  expect(await focusedName()).toBe(`Channel ${String(start + 30)}`);
  const fit = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('#view-channels .channel-item.focused');
    const list = row?.closest<HTMLElement>('.channel-list-scroll, [data-nav-container]');
    if (!row || !list) return null;
    const r = row.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    return { inside: r.top >= l.top - 1 && r.bottom <= l.bottom + 1 };
  });
  expect(fit?.inside).toBe(true);

  // A pointer over a visible row's center targets that row, not a neighbor.
  const key = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('#view-channels .channel-item'));
    const list = rows[0]?.closest<HTMLElement>('[data-nav-container]');
    const l = list?.getBoundingClientRect();
    const visible = rows.filter((row) => {
      const r = row.getBoundingClientRect();
      return l && !row.classList.contains('focused') && r.top >= l.top && r.bottom <= l.bottom;
    });
    return visible[Math.floor(visible.length / 2)]?.dataset.key ?? null;
  });
  if (!key) throw new Error('no fully visible row');
  const target = page.locator(`#view-channels .channel-item[data-key="${key}"]`);
  const box = await target.boundingBox();
  if (!box) throw new Error('row has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await expect(target).toHaveClass(/focused/);
});

test('the interface size previews live, reverts on Cancel, and persists on Save', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');
  await enterTab(page, 'settings');
  await expect(page.locator('#view-settings')).toBeVisible();
  const root = page.locator('html');

  await page.locator('[data-settings-target="appearance"]').click();
  await page.locator('#interface-size .dropdown-trigger').click();
  await page.locator('#interface-size .dropdown-option[data-dropdown-value="120"]').click();
  await expect(root).toHaveAttribute('data-interface-size', '120');
  const radius = await page.locator('#save-settings').evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
  expect(radius).toBeCloseTo(8 * 1.2, 1);

  await page.locator('#cancel-settings').click();
  await expect(root).toHaveAttribute('data-interface-size', '100');

  await enterTab(page, 'settings');
  await page.locator('[data-settings-target="appearance"]').click();
  await page.locator('#interface-size .dropdown-trigger').click();
  await page.locator('#interface-size .dropdown-option[data-dropdown-value="120"]').click();
  await page.locator('#save-settings').click();
  await liveAfterSave(page);
  await expect(root).toHaveAttribute('data-interface-size', '120');

  await page.reload();
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(root).toHaveAttribute('data-interface-size', '120');
});

// The Settings sidebar is a fixed box: whatever it holds, text included, must
// stay inside it and on screen; its category list scrolls when it can't fit.
// Text is measured on its own, since a line can overflow the element it sits in.
async function sidebarSpill(page: Page): Promise<string[]> {
  return page.locator('#view-settings .settings-sidebar').evaluate((sidebar) => {
    const box = sidebar.getBoundingClientRect();
    const out: string[] = [];
    const nodes: Node[] = Array.from(sidebar.querySelectorAll('*'));
    const walker = document.createTreeWalker(sidebar, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if ((n.textContent ?? '').trim()) nodes.push(n);
    }
    for (const node of nodes) {
      const owner = node instanceof Element ? node : node.parentElement!;
      let rect: DOMRect;
      if (node instanceof Element) {
        rect = node.getBoundingClientRect();
      } else {
        const range = document.createRange();
        range.selectNodeContents(node);
        rect = range.getBoundingClientRect();
      }
      if (!rect.width || !rect.height || getComputedStyle(owner).visibility === 'hidden') continue;
      let left = rect.left;
      let top = rect.top;
      let right = rect.right;
      let bottom = rect.bottom;
      const first = node instanceof Element ? node.parentElement : owner;
      for (let a = first; a && a !== sidebar; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const clip = a.getBoundingClientRect();
        left = Math.max(left, clip.left);
        top = Math.max(top, clip.top);
        right = Math.min(right, clip.right);
        bottom = Math.min(bottom, clip.bottom);
      }
      if (right <= left || bottom <= top) continue;
      if (left < Math.max(box.left, 0) - 1 || top < Math.max(box.top, 0) - 1
          || right > Math.min(box.right, 1920) + 1 || bottom > Math.min(box.bottom, 1080) + 1) {
        const label = (node.textContent ?? '').trim().slice(0, 24) || (owner.getAttribute('class') ?? owner.tagName);
        out.push(`${label} [${Math.round(left)},${Math.round(top)} → ${Math.round(right)},${Math.round(bottom)}]`);
      }
    }
    return out;
  });
}

for (const textSize of ['100', '150']) {
  test(`at text size ${textSize} the Settings sidebar keeps everything inside its box at every size`, async ({ page }) => {
    test.slow();
    for (const locale of ['en', 'de', 'ru', 'uk', 'pt-BR', 'ar']) {
      for (const size of ['90', '100', '110', '120', '130']) {
        await page.addInitScript(([s, t, l]) => {
          localStorage.setItem('iptv_interface_size', JSON.stringify(s));
          localStorage.setItem('iptv_text_size', JSON.stringify(t));
          localStorage.setItem('iptv_locale', JSON.stringify(l));
        }, [size, textSize, locale]);
        await page.goto('/');
        await expect(page.locator('#view-settings')).toBeVisible();
        expect(await sidebarSpill(page), `${locale} at ${size}%`).toEqual([]);

        // The last category scrolls into the list rather than out of the box.
        const last = page.locator('[data-settings-target="data"]');
        for (let i = 0; i < 8 && !(await last.evaluate(el => el.classList.contains('focused'))); i++) {
          await page.keyboard.press('ArrowDown');
        }
        await expect(last).toHaveClass(/focused/);
        expect(await sidebarSpill(page), `${locale} at ${size}%, last category`).toEqual([]);
        await expect(last).toBeInViewport({ ratio: 0.99 });
      }
    }
  });
}
