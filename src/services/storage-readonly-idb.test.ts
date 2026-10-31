// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reminder, ResumeEntry } from '../types';
import { fillOrigin } from '../test/full-origin';

// A TV whose free disk is below Chromium's system reserve: IndexedDB reads
// work, and every put aborts with QuotaExceededError, even after eviction.
type Storage = typeof import('./storage-service').StorageService;
type Cache = typeof import('./idb-cache');
type UserData = typeof import('./idb-user-data');

// A fresh module graph over the same IndexedDB and localStorage, as an app
// relaunch sees them.
async function relaunch(): Promise<{ storage: Storage; cache: Cache; userData: UserData }> {
  vi.resetModules();
  const { StorageService } = await import('./storage-service');
  const cache = await import('./idb-cache');
  const userData = await import('./idb-user-data');
  await StorageService.init();
  return { storage: StorageService, cache, userData };
}

const resume: ResumeEntry = {
  accountId: 'x1',
  kind: 'vod',
  itemId: '1',
  name: 'Movie One',
  poster: '',
  ext: 'mp4',
  position: 20,
  duration: 120,
  updatedAt: 1000,
};

const reminder: Reminder = {
  channelKey: 'ch1',
  channelName: 'Alpha',
  title: 'Program One',
  startMs: Date.now() + 60 * 60 * 1000,
  stopMs: Date.now() + 2 * 60 * 60 * 1000,
};

function events(spy: ReturnType<typeof vi.spyOn>, name: string): string[] {
  return spy.mock.calls.map(call => call.join(' '))
    .filter(line => line.indexOf(`event=${name}`) >= 0);
}

function fallbackKeys(): string[] {
  return Object.keys(localStorage).filter(key => key.indexOf('iptv_fb_') === 0);
}

describe('StorageService when IndexedDB refuses every write', () => {
  let origin: ReturnType<typeof fillOrigin> | null = null;
  let warn: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    globalThis.indexedDB = new IDBFactory();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    origin?.restore();
    origin = null;
    vi.restoreAllMocks();
  });

  it('keeps progress, the watched flag, favorites and reminders across a relaunch', async () => {
    // Saved before the TV filled up.
    let app = await relaunch();
    app.storage.setFavorites(['ch0']);
    await app.storage.flush();

    origin = fillOrigin([]);
    app = await relaunch();
    const onFailure = vi.fn();
    app.storage.setWriteFailureHandler(onFailure);
    app.storage.setResume(resume);
    app.storage.markWatched('x1', 'vod', '2');
    app.storage.toggleFavorite('ch1');
    app.storage.setReminders([reminder]);
    await expect(app.storage.flush()).resolves.toBeUndefined();
    expect(onFailure).not.toHaveBeenCalled();
    expect(events(error, 'persistence.user.write.failed')).toEqual([]);

    app = await relaunch();
    expect(app.storage.getResumeList('x1').map(entry => entry.itemId)).toEqual(['1']);
    expect(app.storage.getResume('x1', 'vod', '1')?.position).toBe(20);
    expect(app.storage.isWatched('x1', 'vod', '2')).toBe(true);
    expect(app.storage.getFavorites()).toEqual(['ch0', 'ch1']);
    expect(app.storage.getReminders()).toEqual([reminder]);
  });

  it('keeps a deletion of a record IndexedDB still holds', async () => {
    let app = await relaunch();
    app.storage.setFavorites(['ch0', 'ch1']);
    await app.storage.flush();

    origin = fillOrigin([]);
    app = await relaunch();
    app.storage.toggleFavorite('ch0');
    await app.storage.flush();

    app = await relaunch();
    expect(app.storage.getFavorites()).toEqual(['ch1']);
  });

  it('logs the switch once with the records the fallback already holds', async () => {
    origin = fillOrigin([]);
    let app = await relaunch();
    app.storage.setFavorites(['ch1', 'ch2']);
    await app.storage.flush();
    const first = events(warn, 'storage.idb.readonly');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/event=storage\.idb\.readonly reason=quota fallbackKeys=0$/);

    warn.mockClear();
    app = await relaunch();
    app.storage.setFavorites(['ch1']);
    await app.storage.flush();
    const second = events(warn, 'storage.idb.readonly');
    expect(second).toHaveLength(1);
    expect(second[0]).toMatch(/fallbackKeys=2$/);
  });

  it('keeps caches in memory for the session only', async () => {
    origin = fillOrigin([]);
    let app = await relaunch();
    await app.cache.setCachedCatalog('x1|vod_all', ['Movie One']);
    await app.cache.setCachedStreamMime('host/a', 'video/mp4');

    expect((await app.cache.getCachedCatalog('x1|vod_all'))?.data).toEqual(['Movie One']);
    expect(await app.cache.getCachedStreamMime('host/a')).toBe('video/mp4');
    expect(fallbackKeys()).toEqual([]);

    app = await relaunch();
    expect(await app.cache.getCachedCatalog('x1|vod_all')).toBeNull();
    expect(await app.cache.getCachedStreamMime('host/a')).toBeNull();
  });

  it('reports limited storage for the session, never as a write failure', async () => {
    let app = await relaunch();
    expect(app.storage.isStorageLimited()).toBe(false);

    origin = fillOrigin([]);
    app = await relaunch();
    const onFailure = vi.fn();
    app.storage.setWriteFailureHandler(onFailure);
    expect(app.storage.isStorageLimited()).toBe(true);
    app.storage.setFavorites(['ch1']);
    app.storage.setResume(resume);
    await expect(app.storage.flush()).resolves.toBeUndefined();
    expect(onFailure).not.toHaveBeenCalled();

    origin.restore();
    origin = null;
    app = await relaunch();
    expect(app.storage.isStorageLimited()).toBe(false);
  });

  it('moves the fallback back into IndexedDB once writes work again', async () => {
    origin = fillOrigin([]);
    let app = await relaunch();
    app.storage.setResume(resume);
    app.storage.setFavorites(['ch1']);
    await app.storage.flush();
    expect(fallbackKeys().sort()).toEqual(['iptv_fb_favorites', 'iptv_fb_playback-progress']);

    origin.restore();
    origin = null;
    app = await relaunch();

    expect(fallbackKeys()).toEqual([]);
    expect((await app.userData.loadUserRecords('favorites')).map(item => item.key))
      .toEqual(['favorite:ch1']);
    expect((await app.userData.loadUserRecords('playback-progress')).map(item => item.key))
      .toEqual(['resume:x1|vod|1']);
    expect(app.storage.getFavorites()).toEqual(['ch1']);
    expect(app.storage.getResume('x1', 'vod', '1')?.position).toBe(20);
    const restored = events(info, 'storage.idb.restored');
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatch(/event=storage\.idb\.restored records=2$/);
  });
});

describe('StorageService localStorage quota while IndexedDB is read-only', () => {
  let origin: ReturnType<typeof fillOrigin> | null = null;

  beforeEach(() => {
    localStorage.clear();
    globalThis.indexedDB = new IDBFactory();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    origin?.restore();
    origin = null;
    vi.restoreAllMocks();
  });

  // Rejects a write that would take localStorage past `limit` characters.
  function limitLocalStorage(limit: () => number): void {
    const realSet = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(
      function (this: globalThis.Storage, key: string, value: string) {
        let used = 0;
        for (let i = 0; i < this.length; i++) {
          const name = this.key(i)!;
          if (name !== key) used += name.length + (this.getItem(name) ?? '').length;
        }
        if (used + key.length + value.length > limit()) {
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        }
        realSet.call(this, key, value);
      },
    );
  }

  it('gives the fallback room back to a boot-critical key', async () => {
    origin = fillOrigin([]);
    const app = await relaunch();
    for (let i = 0; i < 40; i++) {
      app.storage.setAudioPref(`ch${i}`, { name: 'x'.repeat(2000), language: 'l1' });
    }
    await app.storage.flush();
    const fallbackChars = fallbackKeys().reduce((sum, key) =>
      sum + key.length + localStorage.getItem(key)!.length, 0);
    let limit = Number.POSITIVE_INFINITY;
    limitLocalStorage(() => limit);
    limit = fallbackChars + 1000;

    const playlists = [{ id: 'p1', name: 'Playlist One', url: 'http://host/a'.padEnd(5000, 'a') }];
    expect(app.storage.setPlaylists(playlists)).toBe(true);
    expect(app.storage.getPlaylists().map(item => item.url)).toEqual([playlists[0].url]);
    // The oldest fallback records went; the newest stay.
    const kept = localStorage.getItem('iptv_fb_channel-state')!;
    expect(kept).toContain('audio:ch39');
    expect(kept).not.toContain('"audio:ch0"');
  });

  it('still evicts the parsed-playlist and stream-MIME caches on a quota error', async () => {
    origin = fillOrigin([]);
    const app = await relaunch();
    await app.cache.setCachedStreamMime('host/a', 'video/mp4');
    let limit = Number.POSITIVE_INFINITY;
    limitLocalStorage(() => limit);
    limit = 0;

    app.storage.setEpgTzOffset(60);

    expect(await app.cache.getCachedStreamMime('host/a')).toBeNull();
  });
});
