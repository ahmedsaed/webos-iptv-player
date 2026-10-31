// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { healthMock, playlistMock } = vi.hoisted(() => ({
  healthMock: {
    recordPlaybackFailure: vi.fn().mockResolvedValue(undefined),
    recordPlaybackSuccess: vi.fn().mockResolvedValue(false),
  },
  playlistMock: {
    channels: [] as unknown[],
    getByIndex: vi.fn(),
    indexOf: vi.fn(),
    resolveChannelKey: vi.fn(),
    getByGroup: vi.fn(),
  },
}));

vi.mock('../services/playlist-service', () => ({ PlaylistService: playlistMock }));
vi.mock('../services/channel-health', () => ({ ChannelHealthService: healthMock }));
vi.mock('../services/epg-service', () => ({
  EpgService: { findChannelId: () => null, getNowPlaying: () => null, getUpcoming: () => [] },
}));
vi.mock('../services/storage-service', () => ({
  StorageService: {
    getSubtitlePref: vi.fn(), setSubtitlePref: vi.fn(),
    getAudioPref: vi.fn(), setAudioPref: vi.fn(),
    setResume: vi.fn(), clearResume: vi.fn(), markWatched: vi.fn(),
    removeWatchlist: vi.fn(),
    getPickedOnlineSub: vi.fn(), setPickedOnlineSub: vi.fn(),
    setCatchupProgress: vi.fn(), getCatchupProgress: vi.fn(), clearCatchupProgress: vi.fn(),
    touchRecentlyWatchedLive: vi.fn(),
    getSubtitleOffset: vi.fn(() => 0), setSubtitleOffset: vi.fn(),
    getChannelCycleMode: vi.fn(() => 'global'),
    getLiveReconnectAttempts: vi.fn(() => 3),
    getPlayerOsdTimeoutMs: vi.fn(() => 5000),
    getPlaylists: vi.fn(() => [{
      id: 'x',
      name: 'Account',
      url: 'http://host',
      source: 'xtream',
      xtream: { username: 'u1', password: 'p1', liveOutput: 'auto' },
    }]),
  },
}));
vi.mock('./toast', () => ({ showToast: vi.fn() }));
vi.mock('../services/media-probe', () => ({ probeMedia: vi.fn() }));
vi.mock('../services/subtitle-search/subtitle-search-service', () => ({
  subtitleSearchService: { isAvailable: () => false },
}));

import { Player } from './player';
import { Focus } from '../navigation/focus-scope';
import { setCursorHidden, setInputMode, setKeyRepeat } from '../navigation/input-mode';
import {
  containerMime,
  diagnosticStreamUrl,
  extFromUrl,
  sniffStreamContentType,
  streamMime,
  streamRouteKey,
  streamUrlMime,
} from '../utils/url';
import { StorageService } from '../services/storage-service';
import { showToast } from './toast';
import { probeMedia } from '../services/media-probe';
import { CONFIG } from '../config';
import { channelKey, legacyChannelKey } from '../utils/channel';
import { ParentalControlService } from '../services/parental-control';
import { VodSubtitles } from '../services/vod-subtitles';
import { HlsSubtitles } from '../services/hls-subtitles';
import { DashSubtitles } from '../services/dash-subtitles';

const CHANNEL = {
  id: 'c1', name: 'Chan', logo: '', group: '', url: 'http://host/play/c1', extras: null,
  playlistIds: [], catchup: 'default', catchupSource: 'http://host/catchup/c1?start={utc}&end={utcend}', catchupDays: 7,
};
// Channel without catchupSource — catch-up progress must never be written.
const CHANNEL_NO_CATCHUP = {
  id: 'c2', name: 'NoCatchup', logo: '', group: '', url: 'http://host/play/c2', extras: null,
  playlistIds: [], catchupDays: 0,
};
const XTREAM_CHANNEL = {
  ...CHANNEL,
  catchup: 'xtream',
  catchupSource: 'http://host/timeshift/u1/p1/{duration}/{start}/42.ts',
  catchupSources: [
    {
      kind: 'path-ts' as const,
      url: 'http://host/timeshift/u1/p1/{duration}/{start}/42.ts',
    },
    {
      kind: 'path-bare' as const,
      url: 'http://host/timeshift/u1/p1/{duration}/{start}/42',
    },
    {
      kind: 'legacy-ts' as const,
      url: 'http://host/streaming/timeshift.php?username=u1&password=p1'
        + '&stream=42&start={start}&duration={duration}&extension=ts',
    },
  ],
  catchupTimeZone: 'America/New_York',
};
const DERIVED_XTREAM_CHANNEL = {
  ...CHANNEL,
  url: 'https://stream-host/token/42',
  catchup: 'xtream',
  catchupSource: 'http://host/timeshift/u1/p1/{duration}/{start}/42.m3u8',
  catchupAccountId: 'x',
  catchupStreamId: '42',
  catchupTimeZone: 'America/New_York',
};
// 120-second catch-up programme.
const CATCHUP = { start: 1_000_000, end: 1_000_120, title: 'Prog', description: '', icon: '' };

// A stand-in <video> with controllable duration/currentTime — jsdom's real one
// reports duration NaN and ignores currentTime without a media source.
function fakeVideo(duration: number): HTMLVideoElement {
  let currentTime = 0;
  let src = '';
  let paused = false;
  const listeners: Record<string, Array<() => void>> = {};
  return {
    duration,
    get currentTime() { return currentTime; },
    set currentTime(t: number) { currentTime = t; },
    get paused() { return paused; },
    get src() { return src; },
    set src(v: string) { src = v; },
    classList: { add() {}, remove() {} },
    canPlayType: () => '',
    get currentSrc() { return src; },
    getAttribute: () => null,
    querySelector: () => null,
    play: () => { paused = false; return Promise.resolve(); },
    pause() { paused = true; },
    load() {}, removeAttribute() {}, appendChild() {}, set innerHTML(_: string) {},
    addEventListener(type: string, fn: () => void) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(e: Event) { (listeners[e.type] || []).forEach((fn) => fn()); return true; },
  } as unknown as HTMLVideoElement;
}

// An AudioTrackList/TextTrackList stand-in whose add() fires `addtrack`.
function trackList<T>(items: T[]) {
  const listeners: Array<(e: { track: T }) => void> = [];
  const list = Object.assign(items.slice(), {
    addEventListener(_type: string, fn: (e: { track: T }) => void) { listeners.push(fn); },
    add(track: T) { list.push(track); listeners.forEach(fn => fn({ track })); },
  });
  return list;
}

const vodTrackEvents = (log: { mock: { calls: unknown[][] } }) => log.mock.calls
  .map(args => args.join(' ')).filter(text => text.includes('event=vod.tracks'));

function fakeAsyncSeekVideo(duration: number) {
  let currentTime = 0;
  let requestedTime = 0;
  const requestedTimes: number[] = [];
  let paused = false;
  let src = '';
  const listeners: Record<string, Array<() => void>> = {};
  const video = {
    duration,
    get currentTime() { return currentTime; },
    set currentTime(t: number) { requestedTime = t; requestedTimes.push(t); },
    get paused() { return paused; },
    get src() { return src; },
    set src(v: string) { src = v; },
    classList: { add() {}, remove() {} },
    canPlayType: () => '',
    get currentSrc() { return src; },
    getAttribute: () => null,
    querySelector: () => null,
    play: () => { paused = false; return Promise.resolve(); },
    pause() { paused = true; },
    load() {}, removeAttribute() {}, appendChild() {}, set innerHTML(_: string) {},
    addEventListener(type: string, fn: () => void) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(e: Event) { (listeners[e.type] || []).forEach((fn) => fn()); return true; },
  };
  return {
    video: video as unknown as HTMLVideoElement,
    requestedTime: () => requestedTime,
    requestedTimes,
    settleSeek: (time = requestedTime) => {
      currentTime = time;
      video.dispatchEvent(new Event('seeked'));
    },
  };
}

// A live <video> stand-in: duration Infinity and a single seekable range (the DVR
// window), with a mutable window so tests can simulate it rolling forward.
function fakeLiveVideo(start: number, end: number, currentTime = 0) {
  let ct = currentTime;
  let paused = false;
  let src = '';
  let w = { start, end };
  const listeners: Record<string, Array<() => void>> = {};
  const video = {
    duration: Infinity,
    get currentTime() { return ct; },
    set currentTime(t: number) { ct = t; },
    get paused() { return paused; },
    get src() { return src; },
    set src(v: string) { src = v; },
    seekable: { length: 1, start: () => w.start, end: () => w.end },
    classList: { add() {}, remove() {} },
    canPlayType: () => '',
    get currentSrc() { return src; },
    getAttribute: () => null,
    querySelector: () => null,
    play: () => { paused = false; return Promise.resolve(); },
    pause() { paused = true; },
    load() {}, removeAttribute() {}, appendChild() {}, set innerHTML(_: string) {},
    addEventListener(type: string, fn: () => void) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(e: Event) { (listeners[e.type] || []).forEach((fn) => fn()); return true; },
  };
  return {
    video: video as unknown as HTMLVideoElement,
    setWindow: (s: number, e: number) => { w = { start: s, end: e }; },
  };
}

let container: HTMLElement;
let player: Player;
let video: HTMLVideoElement;
let allowAutoRevealOsd: boolean;
let onHealthChanged: ReturnType<typeof vi.fn>;

// The desktop path probes the stream's Content-Type before routing; stub it so
// tests stay offline and deterministic (HLS → hls.js fallback sets video.src).
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => ({
    headers: { get: () => 'application/vnd.apple.mpegurl' },
    body: { cancel: async () => {} },
  })));
  document.body.innerHTML = '';
  container = document.createElement('div');
  const osd = document.createElement('div');
  osd.id = 'player-osd';
  container.appendChild(osd);
  document.body.appendChild(container);
  playlistMock.getByIndex.mockReturnValue(CHANNEL);
  playlistMock.indexOf.mockReturnValue(0);
  playlistMock.resolveChannelKey.mockReturnValue({ channel: CHANNEL, channelIndex: 0 });
  playlistMock.getByGroup.mockReturnValue([]);
  healthMock.recordPlaybackFailure.mockClear();
  healthMock.recordPlaybackSuccess.mockReset();
  healthMock.recordPlaybackSuccess.mockResolvedValue(false);
  vi.mocked(probeMedia).mockResolvedValue(null);
  allowAutoRevealOsd = true;
  onHealthChanged = vi.fn();
  player = new Player(
    container,
    vi.fn(),
    undefined,
    () => allowAutoRevealOsd,
    onHealthChanged,
  );
  video = fakeVideo(120);
  player.init(video);
});
afterEach(() => {
  Focus.uninstall();
  setInputMode('pointer');
  setKeyRepeat(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const bar = () => container.querySelector('.osd-progress-bar') as HTMLElement;
// The remote's keys drive the player, as KeyHandler records a key press that
// follows another key.
const remoteKeys = () => { setInputMode('keys'); setInputMode('keys'); };
const elapsed = () => container.querySelector('.osd-time-current')!.textContent;

describe('Player authorization gates', () => {
  it('defers live playback until the authorizer runs the action', () => {
    let deferred: (() => void) | null = null;
    const authorize = vi.fn((_channel, action: () => void) => {
      deferred = action;
      return false;
    });
    player = new Player(
      container,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      authorize,
    );
    player.init(video);

    player.play(0);

    expect(authorize).toHaveBeenCalledWith(CHANNEL, expect.any(Function), false);
    expect(player.getCurrentChannel()).toBeNull();
    expect(deferred).not.toBeNull();
    (deferred as unknown as () => void)();
    expect(player.getCurrentChannel()).toBe(CHANNEL);
  });

  it('asks again before resuming a live channel after the app was hidden', () => {
    let allowed = true;
    let deferred: (() => void) | null = null;
    const onBack = vi.fn();
    const authorize = vi.fn((_channel, action: () => void) => {
      if (allowed) { action(); return true; }
      deferred = action;
      return false;
    });
    player = new Player(
      container, onBack, undefined, undefined, undefined, undefined, undefined, authorize,
    );
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const el = document.createElement('video');
    Object.defineProperty(el, 'paused', { get: () => false, configurable: true });
    container.appendChild(el);
    player.init(el);
    player.play(0);
    player.suspend();
    allowed = false;

    player.resume();

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(container.classList.contains('hidden')).toBe(true);
    (deferred as unknown as () => void)();
    expect(container.classList.contains('hidden')).toBe(false);
  });
});

describe('Player pointer OSD reveal', () => {
  it('does not reveal a hidden OSD while a player overlay is open', () => {
    player.hideOSD();
    allowAutoRevealOsd = false;

    container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));

    expect(container.querySelector('#player-osd')?.classList.contains('hidden')).toBe(true);
  });

  it('keeps an already visible OSD visible while a player overlay is open', () => {
    player.showOSD();
    allowAutoRevealOsd = false;

    container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));

    expect(container.querySelector('#player-osd')?.classList.contains('hidden')).toBe(false);
  });
});

describe('Player catch-up seeking', () => {
  beforeEach(() => player.play(0, CATCHUP)); // catch-up → OSD shown, seekable

  it('renders a seek bar showing the playback position and total', () => {
    expect(container.querySelector('[data-seekbar]')).not.toBeNull();
    expect(elapsed()).toBe('0:00');
    expect(container.querySelector('.osd-time-end')!.textContent).toBe('2:00');
    expect(player.canSeek()).toBe(true);
  });

  it('Right seeks forward by the step, Left back; the bar + label follow', () => {
    expect(CONFIG.PLAYER.SEEK_STEP).toBe(10);
    player.handleAction('right');
    expect(video.currentTime).toBe(10);
    expect(bar().style.width).toBe(`${(10 / 120) * 100}%`);
    expect(elapsed()).toBe('0:10');

    player.handleAction('right');
    player.handleAction('right');
    expect(video.currentTime).toBe(30);
    expect(bar().style.width).toBe('25%');

    player.handleAction('left');
    expect(video.currentTime).toBe(20);
  });

  it('accumulates repeated seeks while the native position is still stale', () => {
    const asyncVideo = fakeAsyncSeekVideo(120);
    video = asyncVideo.video;
    player.init(video);
    player.play(0, CATCHUP);

    player.handleAction('right');
    expect(asyncVideo.requestedTime()).toBe(10);
    expect(elapsed()).toBe('0:10');

    video.dispatchEvent(new Event('timeupdate'));
    expect(elapsed()).toBe('0:10');

    player.handleAction('right');
    expect(asyncVideo.requestedTime()).toBe(20);
    expect(elapsed()).toBe('0:20');

    video.dispatchEvent(new Event('timeupdate'));
    expect(elapsed()).toBe('0:20');
    asyncVideo.settleSeek(10);
    expect(asyncVideo.requestedTimes).toEqual([10, 20, 20]);
    expect(elapsed()).toBe('0:20');

    asyncVideo.settleSeek(20);
    expect(elapsed()).toBe('0:20');
  });

  it('clamps seeks to [0, duration]', () => {
    player.handleAction('left'); // 0 - 10 → 0
    expect(video.currentTime).toBe(0);
    for (let i = 0; i < 13; i++) player.handleAction('right'); // 130 → clamp 120
    expect(video.currentTime).toBe(120);
  });

  const stubBar = () => {
    const seekbar = container.querySelector('[data-seekbar]') as HTMLElement;
    seekbar.getBoundingClientRect = () => ({ left: 0, right: 1000, width: 1000, top: 0, bottom: 36 }) as DOMRect;
  };

  it('a pointer release over the bar seeks to that fraction of the duration', () => {
    stubBar();
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 750, clientY: 18 }));
    expect(video.currentTime).toBe(90); // 0.75 * 120
  });

  it('OK while the cursor is over the bar seeks to the pointer position', () => {
    stubBar();
    container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 250, clientY: 18 }));
    player.handleAction('select');
    expect(video.currentTime).toBe(30); // 0.25 * 120
  });

  it('OK away from the bar pauses playback instead of seeking', () => {
    stubBar();
    container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 250, clientY: 500 })); // off the bar
    player.handleAction('select');
    expect(video.currentTime).toBe(0); // not seeked
    expect(video.paused).toBe(true); // paused instead
  });

  it('a d-pad press clears the cursor so OK pauses instead of seeking', () => {
    stubBar();
    container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 250, clientY: 18 }));
    player.handleAction('right'); // d-pad seek clears the tracked cursor
    expect(video.currentTime).toBe(10);
    player.handleAction('select');
    expect(video.paused).toBe(true); // paused (cursor cleared), not seeked to the stale pointer
  });

  it('Back drops a stale cursor, so OK resumes rather than seeking to it', () => {
    stubBar();
    player.handleAction('pause');
    container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 250, clientY: 18 }));
    remoteKeys();
    expect(player.handleBack()).toBe(true);
    player.handleAction('select'); // shows the controls on Play/Pause
    expect(player.canSeek()).toBe(true);
    expect(video.paused).toBe(true);
    player.handleAction('select');
    expect(video.paused).toBe(false); // resumed
    expect(video.currentTime).toBe(0); // not seeked to the stale cursor
  });

  it('is no longer seekable once the OSD hides', () => {
    player.hideOSD();
    expect(player.canSeek()).toBe(false);
  });
});

describe('Player catch-up pause/play', () => {
  beforeEach(() => player.play(0, CATCHUP)); // catch-up → OSD shown, finite duration

  it('renders a play/pause control', () => {
    expect(container.querySelector('[data-dock-action="playpause"]')).not.toBeNull();
  });

  it('OK (OSD up, cursor off the bar) pauses on the seek bar, where Right skips and OK resumes', () => {
    expect(video.paused).toBe(false);
    player.handleAction('select'); // OSD up + catch-up → pause
    expect(video.paused).toBe(true);
    Focus.flush();
    expect(container.querySelector('[data-seekbar]')!.classList.contains('focused')).toBe(true);
    player.handleAction('right');
    expect(video.currentTime).toBe(10);
    expect(video.paused).toBe(true);
    player.handleAction('select'); // resume
    expect(video.paused).toBe(false);
  });

  it('the pause/play remote keys toggle playback', () => {
    player.handleAction('pause');
    expect(video.paused).toBe(true);
    player.handleAction('play');
    expect(video.paused).toBe(false);
  });

  it('lets Back hide the OSD only while paused', () => {
    remoteKeys();
    expect(player.handleBack()).toBe(false); // playing: Back stops
    player.handleAction('pause');
    expect(video.paused).toBe(true);
    expect(player.handleBack()).toBe(true);
    expect(video.paused).toBe(true);
    expect(player.canSeek()).toBe(false); // Left opens the channel list
    vi.advanceTimersByTime(60_000);
    expect(container.querySelector('#player-osd')!.classList.contains('hidden')).toBe(true);
  });

  it('lets Back stop once the pipeline resumed a user pause, even if it paused again', () => {
    remoteKeys();
    player.handleAction('pause');
    video.play();
    video.dispatchEvent(new Event('play'));
    video.pause();
    video.dispatchEvent(new Event('pause'));
    expect(container.querySelector('#player-osd')!.classList.contains('hidden')).toBe(false);
    expect(player.handleBack()).toBe(false);
  });

  it('keeps a user re-pause when the resume\'s `play` event arrives after it', () => {
    remoteKeys();
    player.handleAction('pause');
    player.handleAction('play');
    player.handleAction('pause');
    video.dispatchEvent(new Event('play'));
    expect(player.handleBack()).toBe(true);
  });

  // The control is driven from click by coordinates — mirror the live DVR
  // play/pause test.
  it('a pointer click on the play/pause control pauses playback', () => {
    const btn = container.querySelector('[data-dock-action="playpause"]') as HTMLElement;
    btn.getBoundingClientRect = () => ({ left: 10, right: 42, width: 32, top: 0, bottom: 32 }) as DOMRect;
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 26, clientY: 16 }));
    expect(video.paused).toBe(true);
  });

});

describe('Player catch-up completion', () => {
  it('derives Xtream catch-up candidates only when playback needs them', () => {
    const internals = player as unknown as {
      xtreamCatchupSources: (channel: typeof DERIVED_XTREAM_CHANNEL) =>
        Array<{ kind: string; url: string }>;
    };

    const sources = internals.xtreamCatchupSources(DERIVED_XTREAM_CHANNEL);

    expect(sources.map(source => source.kind)).toEqual([
      'path-hls',
      'path-bare',
      'path-ts',
      'legacy-hls',
      'legacy-bare',
      'legacy-ts',
    ]);
    expect(sources[0].url)
      .toBe('http://host/timeshift/u1/p1/{duration}/{start}/42.m3u8');
    expect(DERIVED_XTREAM_CHANNEL).not.toHaveProperty('catchupSources');
  });

  it('resolves an Xtream timeshift URL in the provider timezone', async () => {
    playlistMock.getByIndex.mockReturnValue(DERIVED_XTREAM_CHANNEL);
    const start = Date.UTC(2026, 6, 21, 19, 30) / 1000;
    player.play(0, {
      ...CATCHUP,
      start,
      end: start + 3661,
    });
    await flush();
    expect(video.src)
      .toContain('/timeshift/u1/p1/62/2026-07-21:15-30/42.m3u8');
  });

  it('tries each Xtream catch-up candidate once in order', async () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const realVideo = document.createElement('video');
    container.appendChild(realVideo);
    player.init(realVideo);
    playlistMock.getByIndex.mockReturnValue(XTREAM_CHANNEL);
    const start = Date.UTC(2026, 6, 21, 19, 30) / 1000;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    player.play(0, { ...CATCHUP, start, end: start + 3600 });
    await flush();
    expect(realVideo.src).toContain('/timeshift/');

    realVideo.dispatchEvent(new Event('error'));
    await flush();
    const bareVideo = container.querySelector('video')!;
    expect(bareVideo.src).toContain(
      '/timeshift/u1/p1/60/2026-07-21:15-30/42',
    );
    expect(bareVideo.src).not.toContain('42.ts');

    bareVideo.dispatchEvent(new Event('error'));
    await flush();
    const legacyVideo = container.querySelector('video')!;
    expect(legacyVideo.src).toContain(
      '/streaming/timeshift.php?username=u1&password=p1&stream=42' +
      '&start=2026-07-21:15-30&duration=60&extension=ts',
    );

    legacyVideo.dispatchEvent(new Event('error'));
    expect(container.querySelector('video')).toBe(legacyVideo);
    expect(warn.mock.calls.map(args => args.join(' '))).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'event=xtream.catchup.variant.attempted variant=path-bare attempt=2 total=3',
        ),
        expect.stringContaining(
          'event=xtream.catchup.variant.attempted variant=legacy-ts attempt=3 total=3',
        ),
        expect.stringContaining(
          'event=xtream.catchup.variant.failed variant=legacy-ts attempt=3 total=3',
        ),
      ]),
    );
    warn.mockRestore();
  });

  it('does not switch catch-up variants after playback starts', async () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const realVideo = document.createElement('video');
    container.appendChild(realVideo);
    player.init(realVideo);
    playlistMock.getByIndex.mockReturnValue(XTREAM_CHANNEL);

    player.play(0, CATCHUP);
    await flush();
    realVideo.dispatchEvent(new Event('playing'));
    realVideo.dispatchEvent(new Event('error'));

    expect(container.querySelector('video')).toBe(realVideo);
    expect(container.querySelector('video')!.src).toContain('/42.ts');
  });

  it('resumes the channel live stream when the catch-up programme ends', async () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const v = document.createElement('video');
    Object.defineProperty(v, 'duration', { value: 120, configurable: true });
    container.appendChild(v);
    const onPlaybackChanged = vi.fn();
    player = new Player(container, vi.fn(), onPlaybackChanged);
    player.init(v);

    player.play(0, CATCHUP);
    await flush();
    expect(container.querySelector('video')!.src).toContain('/catchup/');
    expect(player.canSeek()).toBe(true);

    container.querySelector('video')!.dispatchEvent(new Event('ended'));
    await flush();

    expect(container.querySelector('video')!.src).toContain('/play/'); // live URL on the fresh element
    expect(player.canSeek()).toBe(false); // live, not seekable
    expect(onPlaybackChanged).toHaveBeenLastCalledWith(0, null);
  });
});

describe('Player live playback', () => {
  it('lets Back stop playing live with the OSD up', () => {
    player.play(0);
    remoteKeys();
    expect(container.querySelector('#player-osd')!.classList.contains('hidden')).toBe(false);
    expect(player.handleBack()).toBe(false);
  });

  it('has no seek bar and is not seekable', () => {
    player.play(0); // live, no catch-up
    expect(player.canSeek()).toBe(false);
    expect(container.querySelector('[data-seekbar]')).toBeNull();
  });

  it('clears the visible index when the playing channel is hidden', () => {
    const onPlaybackChanged = vi.fn();
    player = new Player(container, vi.fn(), onPlaybackChanged);
    player.init(video);
    player.play(0);
    playlistMock.resolveChannelKey.mockReturnValue(null);

    player.syncCurrentIndex();

    expect(player.getCurrentIndex()).toBe(-1);
    expect(player.getCurrentChannel()).toBe(CHANNEL);
    expect(onPlaybackChanged).toHaveBeenLastCalledWith(-1, null);
  });

  it('ignores the outgoing stream\'s state until the new source is attached', async () => {
    playlistMock.channels = [{}, {}];
    // Left over from the channel that just failed; the next load has not
    // reached the element yet (webOS probes the content type first).
    Object.assign(video, { readyState: 0, networkState: 3 });
    player.play(0);
    await flush();
    playlistMock.getByIndex.mockClear();
    healthMock.recordPlaybackFailure.mockClear();

    vi.advanceTimersByTime(CONFIG.PLAYER.STARTUP_TIMEOUT);

    expect(healthMock.recordPlaybackFailure).not.toHaveBeenCalled();
    expect(playlistMock.getByIndex).not.toHaveBeenCalled();
  });

  it('leaves a live stream that never starts to the stall watchdog', async () => {
    playlistMock.channels = [{}, {}];
    Object.assign(video, { readyState: 0, networkState: 2 });
    player.play(0);
    await flush();
    video.dispatchEvent(new Event('loadstart'));
    playlistMock.getByIndex.mockClear();
    healthMock.recordPlaybackFailure.mockClear();

    vi.advanceTimersByTime(CONFIG.PLAYER.STARTUP_TIMEOUT * 2);

    expect(playlistMock.getByIndex).not.toHaveBeenCalled();
    expect(healthMock.recordPlaybackFailure).not.toHaveBeenCalled();
  });

  it('detects a stalled initial load even while autoplay has not unpaused the video', async () => {
    Object.defineProperties(video, {
      paused: { get: () => true, configurable: true },
      readyState: { value: 0, configurable: true },
      networkState: { value: 2, configurable: true },
    });
    player.play(0);
    await flush();
    const reload = vi.spyOn(player as unknown as { reloadCurrentStream(): void }, 'reloadCurrentStream')
      .mockImplementation(() => {});
    const watchdog = (player as unknown as { stallWatchdog: { start(): void } }).stallWatchdog;
    watchdog.start();

    vi.advanceTimersByTime(
      CONFIG.PLAYER.STALL_POLL_MS * (CONFIG.PLAYER.STALL_FREEZE_TICKS + 1),
    );
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does not retry a live stream the user pauses after playback starts', async () => {
    Object.defineProperties(video, {
      paused: { get: () => true, configurable: true },
      readyState: { value: 0, configurable: true },
      networkState: { value: 2, configurable: true },
    });
    player.play(0);
    await flush();
    video.dispatchEvent(new Event('playing'));
    const reload = vi.spyOn(player as unknown as { reloadCurrentStream(): void }, 'reloadCurrentStream')
      .mockImplementation(() => {});
    const watchdog = (player as unknown as { stallWatchdog: { start(): void } }).stallWatchdog;
    watchdog.start();

    vi.advanceTimersByTime(
      CONFIG.PLAYER.STALL_POLL_MS * CONFIG.PLAYER.STALL_FREEZE_TICKS * 2,
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it('coalesces errors and reconnects the same channel before advancing', async () => {
    playlistMock.channels = [{}, {}];
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    video = document.createElement('video');
    container.appendChild(video);
    player.init(video);
    player.play(0);
    playlistMock.getByIndex.mockClear();

    for (let i = 0; i < 20; i++) video.dispatchEvent(new Event('error'));
    await flush();
    expect(healthMock.recordPlaybackFailure).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1999);
    expect(container.querySelector('video')).toBe(video);
    vi.advanceTimersByTime(1);
    expect(playlistMock.getByIndex).not.toHaveBeenCalled();

    const first = container.querySelector('video')!;
    first.dispatchEvent(new Event('error'));
    first.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(2000);
    const second = container.querySelector('video')!;
    expect(second).not.toBe(first);
    first.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(2000);
    expect(container.querySelector('video')).toBe(second);
    second.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(2000);
    const third = container.querySelector('video')!;
    expect(third).not.toBe(second);
    expect(healthMock.recordPlaybackFailure).not.toHaveBeenCalled();

    third.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(2000);

    expect(playlistMock.getByIndex).toHaveBeenCalledTimes(1);
    expect(playlistMock.getByIndex).toHaveBeenCalledWith(1);
    expect(healthMock.recordPlaybackFailure).toHaveBeenCalledOnce();
    expect(healthMock.recordPlaybackFailure)
      .toHaveBeenCalledWith(CHANNEL, 'playback_error');
    await flush();
    expect(onHealthChanged).toHaveBeenCalledOnce();
  });

  it('cancels a pending reconnect if the original live stream resumes', async () => {
    player.play(0);
    await flush();
    video.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(1000);
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(3000);
    expect(container.querySelector('video')).toBeNull();
    expect(healthMock.recordPlaybackFailure).not.toHaveBeenCalled();
    expect(container.querySelector('#player-osd')?.textContent).not.toContain('Reconnecting');
  });

  it('honors a disabled retry limit and skips reconnect for unsupported sources', async () => {
    playlistMock.channels = [{}, {}];
    vi.mocked(StorageService.getLiveReconnectAttempts).mockReturnValueOnce(0);
    player.play(0);
    await flush();
    video.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(2000);
    expect(healthMock.recordPlaybackFailure).toHaveBeenCalledWith(CHANNEL, 'playback_error');
    expect(container.querySelector('video')).toBeNull();

    player.play(0);
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 4, message: '' } });
    healthMock.recordPlaybackFailure.mockClear();
    video.dispatchEvent(new Event('error'));
    expect(healthMock.recordPlaybackFailure).toHaveBeenCalledOnce();
  });

  it('cancels a pending reconnect when the user changes channel or stops', async () => {
    playlistMock.channels = [{}, {}];
    player.play(0);
    await flush();
    video.dispatchEvent(new Event('error'));
    player.play(1);
    playlistMock.getByIndex.mockClear();
    vi.advanceTimersByTime(3000);
    expect(playlistMock.getByIndex).not.toHaveBeenCalled();

    video.dispatchEvent(new Event('error'));
    player.stop();
    vi.advanceTimersByTime(3000);
    expect(healthMock.recordPlaybackFailure).not.toHaveBeenCalled();
  });

  it('starts the OSD hide timer when startup playback begins', async () => {
    video.pause();
    player.showOSD();
    vi.advanceTimersByTime(CONFIG.PLAYER.DEFAULT_PLAYER_OSD_TIMEOUT_MS);
    expect((container.querySelector('#player-osd') as HTMLElement).style.display).not.toBe('none');

    await video.play();
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(CONFIG.PLAYER.DEFAULT_PLAYER_OSD_TIMEOUT_MS);

    expect((container.querySelector('#player-osd') as HTMLElement).style.display).toBe('none');
  });

  it('refreshes health UI only when passive success updates a tracked channel', async () => {
    healthMock.recordPlaybackSuccess.mockResolvedValueOnce(false);
    player.play(0);
    video.dispatchEvent(new Event('playing'));
    await flush();
    expect(onHealthChanged).not.toHaveBeenCalled();

    healthMock.recordPlaybackSuccess.mockResolvedValueOnce(true);
    player.play(0);
    video.dispatchEvent(new Event('playing'));
    await flush();
    expect(onHealthChanged).toHaveBeenCalledOnce();
  });
});

describe('Player Recently Watched recording', () => {
  const touchLive = () => vi.mocked(StorageService.touchRecentlyWatchedLive);

  beforeEach(() => {
    touchLive().mockClear();
  });

  it('records live playback after five continuous seconds', () => {
    player.play(0);
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(CONFIG.RECENTLY_WATCHED.LIVE_CONFIRM_MS - 1);
    expect(touchLive()).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(touchLive()).toHaveBeenCalledWith(channelKey(CHANNEL));
  });

  it('does not record Catch-up playback as live', () => {
    player.play(0, CATCHUP);
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(CONFIG.RECENTLY_WATCHED.LIVE_CONFIRM_MS);
    expect(touchLive()).not.toHaveBeenCalled();
  });

  it('cancels a pending live record when playback buffers', () => {
    player.play(0);
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(2000);
    video.dispatchEvent(new Event('waiting'));
    vi.advanceTimersByTime(CONFIG.RECENTLY_WATCHED.LIVE_CONFIRM_MS);
    expect(touchLive()).not.toHaveBeenCalled();
  });

  it('keeps the pending live record through a spurious stalled event', () => {
    player.play(0);
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(2000);
    video.dispatchEvent(new Event('stalled'));
    vi.advanceTimersByTime(CONFIG.RECENTLY_WATCHED.LIVE_CONFIRM_MS - 2000);

    expect(touchLive()).toHaveBeenCalledWith(channelKey(CHANNEL));
  });

  it('cancels the abandoned playback generation', () => {
    player.play(0);
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(2000);

    player.play(1);
    vi.advanceTimersByTime(CONFIG.RECENTLY_WATCHED.LIVE_CONFIRM_MS);
    expect(touchLive()).not.toHaveBeenCalled();
  });

  it('deduplicates repeated playing events in one playback generation', () => {
    player.play(0);
    video.dispatchEvent(new Event('playing'));
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(CONFIG.RECENTLY_WATCHED.LIVE_CONFIRM_MS);
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(CONFIG.RECENTLY_WATCHED.LIVE_CONFIRM_MS);
    expect(touchLive()).toHaveBeenCalledTimes(1);
  });
});

describe('Player native subtitle retry', () => {
  it('re-applies only the native subtitle compositor once playback starts', () => {
    const apply = vi.fn();
    const internals = player as unknown as {
      tracks: { reapplyNativeSubtitleCompositor: () => void };
    };
    internals.tracks.reapplyNativeSubtitleCompositor = apply;

    video.dispatchEvent(new Event('playing'));

    expect(apply).toHaveBeenCalledOnce();
  });
});

describe('Player live DVR', () => {
  let live: HTMLVideoElement;
  let setWindow: (s: number, e: number) => void;
  const PAD = CONFIG.PLAYER.DVR_GO_LIVE_PAD;
  const OLDEST_PAD = CONFIG.PLAYER.DVR_OLDEST_PAD;

  beforeEach(() => {
    ({ video: live, setWindow } = fakeLiveVideo(0, 60, 60)); // 60s window, at the live edge
    player.init(live);
    player.play(0); // live, no catch-up → OSD shown
  });

  it('is seekable within the window and shows a seek bar', () => {
    expect(player.canSeek()).toBe(true);
    expect(container.querySelector('[data-seekbar]')).not.toBeNull();
  });

  it('Left rewinds by the step, moving the bar', () => {
    player.handleAction('left'); // 60 - 10 = 50
    expect(live.currentTime).toBe(50);
    expect((container.querySelector('.osd-progress-bar') as HTMLElement).style.width)
      .toBe(`${(50 / 60) * 100}%`);
  });

  it('Right near the live edge snaps to the edge (end - pad)', () => {
    player.handleAction('right'); // 60 + 30 → clamp 60 → snap 60 - PAD
    expect(live.currentTime).toBe(60 - PAD);
  });

  it('rewind jumps to the oldest point, fast_forward to live', () => {
    player.handleAction('rewind');
    expect(live.currentTime).toBe(OLDEST_PAD);
    player.handleAction('fast_forward');
    expect(live.currentTime).toBe(60 - PAD);
  });

  it('pause/play and OK toggle playback', () => {
    player.handleAction('pause');
    expect(live.paused).toBe(true);
    player.handleAction('play');
    expect(live.paused).toBe(false);
    player.handleAction('select'); // OSD up + live DVR → pause
    expect(live.paused).toBe(true);
    player.handleAction('select'); // the controls now own OK: Play/Pause resumes
    expect(live.paused).toBe(false);
  });

  it('keeps a paused OSD current after Back hid it and OK showed it again', () => {
    remoteKeys();
    player.handleAction('pause');
    expect(player.handleBack()).toBe(true);
    vi.advanceTimersByTime(1000);
    player.handleAction('select'); // hidden OSD: OK shows it, still paused
    expect(live.paused).toBe(true);
    setWindow(0, 120); // the live edge moves on while paused
    vi.advanceTimersByTime(1000);
    expect((container.querySelector('.osd-progress-bar') as HTMLElement).style.width).toBe('50%');
  });

  it('holds the paused point until resume, then clamps into the rolled window', () => {
    player.handleAction('rewind');
    player.handleAction('pause');
    const pausedAt = live.currentTime;
    setWindow(20, 80); // window rolled forward while paused
    live.dispatchEvent(new Event('progress'));
    expect(live.currentTime).toBe(pausedAt);

    player.handleAction('play');
    expect(live.currentTime).toBe(20 + OLDEST_PAD);
  });

  it('re-enters the sliding window when a manifest refresh overtakes playback', () => {
    player.handleAction('rewind');
    expect(live.currentTime).toBe(OLDEST_PAD);

    setWindow(10, 70);
    live.dispatchEvent(new Event('progress'));

    expect(live.currentTime).toBe(10 + OLDEST_PAD);
  });

  // The OSD controls are driven from click by coordinates, like the seek bar.
  it('a pointer click on the pause control pauses playback', () => {
    const btn = container.querySelector('[data-dock-action="playpause"]') as HTMLElement;
    btn.getBoundingClientRect = () => ({ left: 10, right: 42, width: 32, top: 0, bottom: 32 }) as DOMRect;
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 26, clientY: 16 }));
    expect(live.paused).toBe(true);
  });

  it('a pointer release on the Go-to-Live control seeks to the live edge', () => {
    player.handleAction('rewind');
    expect(live.currentTime).toBe(OLDEST_PAD);
    const btn = container.querySelector('[data-golive]') as HTMLElement;
    btn.getBoundingClientRect = () => ({ left: 500, right: 560, width: 60, top: 0, bottom: 32 }) as DOMRect;
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 530, clientY: 16 }));
    expect(live.currentTime).toBe(60 - PAD);
  });

  it('reveals the DVR bar once the window becomes available, without reopening the OSD', () => {
    // Tune in to a live stream whose seekable window is not usable yet.
    const { video: v2, setWindow } = fakeLiveVideo(0, 3, 0); // 3s < DVR_MIN_WINDOW
    player.init(v2);
    player.play(0); // OSD shown, but no DVR window yet
    expect(container.querySelector('[data-seekbar]')).toBeNull();

    // The pipeline fills the retained window; the next timeupdate must switch the
    // OSD to the DVR layout on its own (no close/reopen).
    setWindow(0, 60);
    v2.dispatchEvent(new Event('timeupdate'));

    expect(container.querySelector('[data-seekbar]')).not.toBeNull();
    expect(container.querySelector('[data-dock-action="playpause"]')).not.toBeNull();
  });
});

describe('Player OSD image handling', () => {
  // renderOSD re-runs on pointer move (to keep the OSD fresh); it must reuse the
  // programme <img> instead of recreating it, and drop one that failed to load so
  // a broken image can't thrash the layout.
  it('reuses the programme icon element across re-renders instead of recreating it', () => {
    player.play(0, { ...CATCHUP, icon: 'http://host/a.jpg' });
    const img1 = container.querySelector('.osd-programme-icon');
    expect(img1).not.toBeNull();
    player.showOSD(); // a re-render (e.g. pointer moved into the OSD area)
    expect(container.querySelector('.osd-programme-icon')).toBe(img1); // same node → no reload
  });

  it('drops a programme icon that failed to load and does not re-request it', () => {
    player.play(0, { ...CATCHUP, icon: 'http://host/broken.jpg' });
    const img = container.querySelector('.osd-programme-icon') as HTMLImageElement;
    expect(img).not.toBeNull();
    img.dispatchEvent(new Event('error'));
    expect(container.querySelector('.osd-programme-icon')).toBeNull(); // dropped on error
    player.showOSD(); // re-render must not bring it back
    expect(container.querySelector('.osd-programme-icon')).toBeNull();
  });

  it('retries a previously-failed icon on the next channel/programme (failure is per-visit)', () => {
    player.play(0, { ...CATCHUP, icon: 'http://host/x.jpg' });
    (container.querySelector('.osd-programme-icon') as HTMLImageElement).dispatchEvent(new Event('error'));
    expect(container.querySelector('.osd-programme-icon')).toBeNull();

    player.play(1, { ...CATCHUP, icon: 'http://host/x.jpg' }); // switch channel, same icon URL
    expect(container.querySelector('.osd-programme-icon')).not.toBeNull(); // fresh attempt
  });
});

describe('Player stall reconnect OSD', () => {
  it('clears the Reconnecting… message after the reloaded stream recovers', async () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const v = document.createElement('video');
    container.appendChild(v);
    player.init(v);

    player.play(0); // live
    await flush();

    // A real stall reloads only after the OSD has auto-hidden (osdVisible false)
    // — the case the message used to get stuck in.
    vi.advanceTimersByTime(CONFIG.PLAYER.DEFAULT_PLAYER_OSD_TIMEOUT_MS + 100);

    (player as unknown as { reloadCurrentStream(): void }).reloadCurrentStream();
    await flush();
    const osd = container.querySelector('#player-osd')!;
    expect(osd.textContent).toContain('Reconnecting');

    // Recovery (loadedmetadata) must repaint over the message, not leave it stuck.
    container.querySelector('video')!.dispatchEvent(new Event('loadedmetadata'));
    expect(osd.textContent).not.toContain('Reconnecting');
  });

  it('lets Back stop at once over a Reconnecting… message and while the reload starts', async () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const v = document.createElement('video');
    container.appendChild(v);
    player.init(v);
    player.play(0); // live
    await flush();
    (player as unknown as { reloadCurrentStream(): void }).reloadCurrentStream();
    await flush();
    remoteKeys();
    expect(v.paused).toBe(true); // the mocked play() never starts it
    expect(player.handleBack()).toBe(false);
    container.querySelector('video')!.dispatchEvent(new Event('loadedmetadata'));
    expect(container.querySelector('#player-osd')!.classList.contains('hidden')).toBe(false);
    expect(player.handleBack()).toBe(false); // recovered metadata, not yet playing
  });

  it('lets Back stop a live stream still starting with the OSD up, but hide a VOD\'s controls', async () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const v = document.createElement('video');
    container.appendChild(v);
    player.init(v);
    player.play(0); // live
    await flush();
    remoteKeys();
    expect(v.paused).toBe(true); // the mocked play() never starts it
    expect(container.querySelector('#player-osd')!.classList.contains('hidden')).toBe(false);
    expect(player.handleBack()).toBe(false);
    player.playVod({
      url: 'http://host/a.mp4', title: 'Movie One', poster: '', accountId: 'x1', itemId: '10',
      kind: 'vod', resumeSecs: 0, subtitles: [], onBack: vi.fn(),
    });
    await flush();
    expect(container.querySelector('video')!.paused).toBe(true);
    expect(player.handleBack()).toBe(true);
    expect(container.querySelector('#player-osd')!.classList.contains('hidden')).toBe(true);
    expect(player.handleBack()).toBe(false);
  });
});

describe('Player VOD mode', () => {
  const req = (over = {}) => ({
    url: 'http://host:8080/movie/u/p/10.mp4', title: 'Movie One', poster: '',
    accountId: 'x1', itemId: '10', kind: 'vod' as const, resumeSecs: 0, subtitles: [], onBack: vi.fn(), ...over,
  });

  let player: Player;
  let container: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = ''; // drop the outer beforeEach's #player-osd (a duplicate id breaks scoped querySelector)
    container = document.createElement('div');
    container.innerHTML = '<div id="player-osd"></div>';
    document.body.appendChild(container);
    player = new Player(container, () => {});
  });
  afterEach(() => { container.remove(); vi.restoreAllMocks(); });

  it('defers VOD playback until the authorizer runs the action', () => {
    let deferred: (() => void) | null = null;
    const authorize = vi.fn((_item, action: () => void) => {
      deferred = action;
      return false;
    });
    player = new Player(
      container,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      authorize,
    );
    player.init(fakeVideo(3600));

    player.playVod(req());

    expect(player.isVod()).toBe(false);
    expect(deferred).not.toBeNull();
    (deferred as unknown as () => void)();
    expect(player.isVod()).toBe(true);
  });

  it('asks again before resuming a VOD after the app was hidden', () => {
    let allowed = true;
    let deferred: (() => void) | null = null;
    const authorize = vi.fn((_item, action: () => void) => {
      if (allowed) { action(); return true; }
      deferred = action;
      return false;
    });
    player = new Player(
      container, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, authorize,
    );
    const v = fakeVideo(3600);
    player.init(v);
    const r = req();
    player.playVod(r);
    v.currentTime = 42;
    player.suspend();
    allowed = false;

    player.resume();

    expect(r.onBack).toHaveBeenCalledTimes(1);
    expect(player.isVod()).toBe(false);
    expect(authorize).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemId: '10', resumeSecs: 42 }), expect.any(Function));
    (deferred as unknown as () => void)();
    expect(player.isVod()).toBe(true);
  });

  it('keeps an allowed VOD playing when the app returns', () => {
    const authorize = vi.fn((_item, action: () => void) => { action(); return true; });
    player = new Player(
      container, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, authorize,
    );
    player.init(fakeVideo(3600));
    const r = req();
    player.playVod(r);

    player.resume();

    expect(r.onBack).not.toHaveBeenCalled();
    expect(player.isVod()).toBe(true);
  });

  it('seeks to the resume position once metadata is known', () => {
    const video = fakeVideo(3600);
    player.init(video);
    player.playVod(req({ resumeSecs: 900 }));
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(900);
    expect(player.isVod()).toBe(true);
  });

  it('logs the native track counts once metadata is known', () => {
    const counted = fakeVideo(3600);
    const audio = (enabled: boolean) => ({ enabled, label: '', language: '', id: '', kind: 'main' });
    const sidecar = { kind: 'subtitles', label: '', language: '', mode: 'hidden' };
    Object.defineProperty(counted, 'audioTracks', { value: [audio(true), audio(false)] });
    Object.defineProperty(counted, 'textTracks', {
      value: [{ kind: 'subtitles', label: '', language: '', mode: 'disabled' }, sidecar],
    });
    vi.spyOn(VodSubtitles.prototype, 'owns').mockImplementation((track) => track === sidecar as unknown);
    const bare = fakeVideo(3600);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    player.init(counted);
    player.playVod(req());
    counted.dispatchEvent(new Event('loadedmetadata'));
    player.init(bare);
    player.playVod(req());
    bare.dispatchEvent(new Event('loadedmetadata'));

    expect(vodTrackEvents(log)).toEqual([
      expect.stringContaining('event=vod.tracks audio=2 text=1 mse=0'),
      expect.stringContaining('event=vod.tracks audio=none text=0 mse=0'),
    ]);
  });

  it('flags MSE playback in the track counts', () => {
    const video = fakeVideo(3600);
    vi.spyOn((player as unknown as { pipeline: { isMseActive(): boolean } }).pipeline, 'isMseActive')
      .mockReturnValue(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    player.init(video);
    player.playVod(req());
    video.dispatchEvent(new Event('loadedmetadata'));

    expect(vodTrackEvents(log)).toEqual([expect.stringContaining('mse=1')]);
  });

  it('logs the first native track added after metadata once per load', () => {
    const video = fakeVideo(3600);
    const audio = () => ({ enabled: false, label: '', language: '', id: '', kind: 'main' });
    const text = () => ({ kind: 'subtitles', label: '', language: '', mode: 'disabled' });
    const audioTracks = trackList([audio()]);
    const textTracks = trackList<unknown>([]);
    Object.defineProperty(video, 'audioTracks', { value: audioTracks });
    Object.defineProperty(video, 'textTracks', { value: textTracks });
    const sidecar = text();
    vi.spyOn(VodSubtitles.prototype, 'owns').mockImplementation((track) => track === sidecar as unknown);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    player.init(video);
    player.playVod(req());
    audioTracks.add(audio()); // before metadata: covered by the loadedmetadata event
    video.dispatchEvent(new Event('loadedmetadata'));
    textTracks.add(sidecar); // the app's own sidecar track is not a late arrival
    textTracks.add(text());
    audioTracks.add(audio());
    video.dispatchEvent(new Event('loadstart'));
    video.dispatchEvent(new Event('loadedmetadata'));
    video.dispatchEvent(new Event('loadstart')); // a new load disarms the last one's late event
    textTracks.add(text());
    video.dispatchEvent(new Event('loadedmetadata'));
    audioTracks.add(audio());

    expect(vodTrackEvents(log)).toEqual([
      expect.stringContaining('event=vod.tracks audio=2 text=0 mse=0'),
      expect.stringContaining('event=vod.tracks phase=late audio=2 text=1 mse=0'),
      expect.stringContaining('event=vod.tracks audio=3 text=1 mse=0'),
      expect.stringContaining('event=vod.tracks audio=3 text=2 mse=0'),
      expect.stringContaining('event=vod.tracks phase=late audio=4 text=2 mse=0'),
    ]);
  });

  it('leaves the HLS and DASH renderer tracks out of the track counts', () => {
    const video = fakeVideo(3600);
    const text = () => ({ kind: 'subtitles', label: '', language: '', mode: 'disabled' });
    const textTracks = trackList<unknown>([]);
    Object.defineProperty(video, 'audioTracks', { value: trackList([]) });
    Object.defineProperty(video, 'textTracks', { value: textTracks });
    const hlsTrack = text();
    const dashTrack = text();
    vi.spyOn(HlsSubtitles.prototype, 'owns').mockImplementation((track) => track === hlsTrack as unknown);
    vi.spyOn(DashSubtitles.prototype, 'owns').mockImplementation((track) => track === dashTrack as unknown);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    player.init(video);
    player.playVod(req());
    textTracks.add(hlsTrack);
    video.dispatchEvent(new Event('loadedmetadata'));
    textTracks.add(dashTrack); // a FORCED or saved subtitle the app renders itself
    textTracks.add(text());

    expect(vodTrackEvents(log)).toEqual([
      expect.stringContaining('event=vod.tracks audio=0 text=0 mse=0'),
      expect.stringContaining('event=vod.tracks phase=late audio=0 text=1 mse=0'),
    ]);
  });

  it('is seekable while the OSD is up (finite duration)', () => {
    const video = fakeVideo(3600);
    player.init(video);
    player.playVod(req());
    expect(player.canSeek()).toBe(true); // playVod shows the OSD
  });

  it('lets Back hide the controls, playing or paused, unless the subtitle search or up-next owns them', () => {
    const video = fakeVideo(3600);
    player.init(video);
    player.playVod(req());
    remoteKeys();
    const internals = player as unknown as {
      tracks: { subsOverlay: { visible: boolean } | null };
      upNextTimer: ReturnType<typeof setInterval> | null;
    };
    internals.tracks.subsOverlay = { visible: true };
    expect(player.handleBack()).toBe(false);
    internals.tracks.subsOverlay = null;
    internals.upNextTimer = 1 as unknown as ReturnType<typeof setInterval>;
    expect(player.handleBack()).toBe(false);
    internals.upNextTimer = null;
    expect(player.handleBack()).toBe(true); // playing: the controls hide first
    expect(player.handleBack()).toBe(false); // hidden: Back stops
    player.handleAction('select'); // pause, showing the controls
    expect(video.paused).toBe(true);
    expect(player.handleBack()).toBe(true);
    expect(video.paused).toBe(true);
  });

  it('lets Back hide a paused VOD\'s controls when the pointer drove it last', () => {
    const video = fakeVideo(3600);
    player.init(video);
    player.playVod(req());
    player.handleAction('select'); // pause
    setInputMode('pointer');
    setInputMode('keys'); // Back is the first key after the pointer
    expect(player.handleBack()).toBe(true);
  });

  it('keeps live controls up for Back only while paused with the cursor gone, or once OK gave them the keys', () => {
    const live = fakeLiveVideo(0, 60, 60).video;
    player.init(live);
    player.play(0);
    player.handleAction('pause');
    setInputMode('pointer');
    setInputMode('keys');
    expect(player.handleBack()).toBe(false); // a cursor on screen re-reveals it
    setInputMode('pointer');
    setCursorHidden(true);
    setInputMode('keys');
    expect(player.handleBack()).toBe(true);
    player.handleAction('play');
    player.handleAction('select'); // shows the controls with the keys
    expect(player.handleBack()).toBe(true);
  });

  it('renders the VOD OSD through the Live markup (title + stream info, no .osd-vod)', () => {
    const video = fakeVideo(3600);
    (video as unknown as { videoHeight: number }).videoHeight = 1080;
    player.init(video);
    player.playVod(req());
    video.dispatchEvent(new Event('loadedmetadata'));
    const osd = container.querySelector('#player-osd')!;
    expect(osd.querySelector('.osd-vod')).toBeNull();
    expect(osd.querySelector('.osd-channel-name')?.textContent).toContain('Movie One');
    expect(osd.querySelector('.osd-stream-info')?.textContent).toContain('1080p');
    expect(osd.querySelector('.osd-progress[data-seekbar]')).not.toBeNull();
  });

  it('merges probed codec/fps/HDR into the VOD OSD when the probe resolves', async () => {
    vi.mocked(probeMedia).mockResolvedValue({ videoCodec: 'hvc1', audioCodec: 'ec-3', width: 3840, height: 2160, fps: 24, hdr: 'PQ' });
    const video = fakeVideo(3600);
    (video as unknown as { videoHeight: number }).videoHeight = 2160;
    player.init(video);
    player.playVod(req());
    video.dispatchEvent(new Event('loadedmetadata'));
    await flush(); // let the probe promise resolve and re-render the OSD
    const info = container.querySelector('.osd-stream-info')?.textContent ?? '';
    expect(probeMedia).toHaveBeenCalledWith('http://host:8080/movie/u/p/10.mp4', 'x1|media_probe|vod|10');
    expect(info).toContain('4K');
    expect(info).toContain('HEVC');
    expect(info).toContain('24fps');
    expect(info).toContain('HDR');
  });

  it('saves the resume point and calls onBack on Back', () => {
    const video = fakeVideo(3600);
    player.init(video);
    const r = req();
    player.playVod(r);
    video.dispatchEvent(new Event('loadedmetadata'));
    video.currentTime = 1200;
    player.handleAction('back');
    expect(StorageService.setResume).toHaveBeenCalledWith(expect.objectContaining({ itemId: '10', position: 1200, duration: 3600, ext: 'mp4' }));
    expect(r.onBack).toHaveBeenCalled();
    expect(player.isVod()).toBe(false); // stop() cleared VOD state
  });

  it('stores the remaining episode queue with the resume point', () => {
    const video = fakeVideo(1800);
    player.init(video);
    const next = {
      url: 'http://host:8080/series/u/p/e2.mp4', title: 'Series One — S1E2',
      poster: '', accountId: 'x1', itemId: 'e2', kind: 'episode' as const, subtitles: [],
    };
    player.playVod(req({
      itemId: 'e1',
      kind: 'episode',
      episodeQueue: [next],
      watchlistOwner: { kind: 'series', itemId: 's1' },
    }));
    video.currentTime = 300;
    player.handleAction('back');
    expect(StorageService.setResume).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'e1',
      episodeQueue: [next],
      watchlistOwner: { kind: 'series', itemId: 's1' },
    }));
  });

  it('clears resume and Watchlist state when a movie ends', () => {
    const video = fakeVideo(3600);
    player.init(video);
    const r = req();
    vi.mocked(StorageService.removeWatchlist).mockClear();
    player.playVod(r);
    video.dispatchEvent(new Event('ended'));
    expect(StorageService.clearResume).toHaveBeenCalledWith('x1', 'vod', '10');
    expect(StorageService.markWatched).toHaveBeenCalledWith('x1', 'vod', '10');
    expect(StorageService.removeWatchlist).toHaveBeenCalledWith('x1', 'vod', '10');
    expect(r.onBack).toHaveBeenCalled();
  });

  it('counts down and starts the next movie from a Watchlist queue', async () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 1800, configurable: true });
    container.appendChild(video);
    player.init(video);
    const next = {
      url: 'http://host:8080/movie/u/p/11.mp4', title: 'Movie Two',
      poster: '', accountId: 'x1', itemId: '11', kind: 'vod' as const, subtitles: [],
    };
    player.playVod(req({ watchlistQueue: [next] }));
    vi.mocked(probeMedia).mockClear();

    video.dispatchEvent(new Event('ended'));
    expect(container.textContent).toContain('Starts in 10 seconds');
    expect(container.textContent).toContain('Movie Two');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(probeMedia).toHaveBeenCalledWith(next.url, 'x1|media_probe|vod|11');
  });

  it('leaves the player while a locked next item waits for the PIN', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    let locked = false;
    let deferred: (() => void) | null = null;
    const authorize = vi.fn((_item, action: () => void) => {
      if (!locked) { action(); return true; }
      deferred = action;
      return false;
    });
    player = new Player(
      container, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, authorize,
    );
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 1800, configurable: true });
    container.appendChild(video);
    player.init(video);
    const next = {
      url: 'http://host:8080/movie/u/p/11.mp4', title: 'Movie Two',
      poster: '', accountId: 'x1', itemId: '11', kind: 'vod' as const, subtitles: [],
    };
    const r = req({ watchlistQueue: [next] });
    player.playVod(r);
    video.dispatchEvent(new Event('ended'));
    vi.mocked(r.onBack).mockClear();
    locked = true;

    player.handleAction('select');

    expect(r.onBack).toHaveBeenCalledTimes(1);
    expect(player.isVod()).toBe(false);
    (deferred as unknown as () => void)();
    expect(player.isVod()).toBe(true);
  });

  it('continues to the next episode of an unlocked series without the PIN', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    let locked = false;
    const authorize = vi.fn((_item, action: () => void) => {
      if (!locked) { action(); return true; }
      return false;
    });
    player = new Player(
      container, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, authorize,
    );
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 1800, configurable: true });
    container.appendChild(video);
    player.init(video);
    const series = { kind: 'episode' as const, categoryId: 'c1', parentalItemId: 's1' };
    const next = {
      url: 'http://host:8080/series/u/p/e2.mp4', title: 'Series One — S1E2',
      poster: '', accountId: 'x1', itemId: 'e2', subtitles: [], ...series,
    };
    player.playVod(req({ itemId: 'e1', episodeQueue: [next], ...series }));
    video.dispatchEvent(new Event('ended'));
    locked = true;
    authorize.mockClear();

    player.handleAction('select');

    expect(authorize).not.toHaveBeenCalled();
    expect(player.isVod()).toBe(true);
  });

  it('counts down and automatically starts the next episode', async () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 1800, configurable: true });
    container.appendChild(video);
    player.init(video);
    const next = {
      url: 'http://host:8080/series/u/p/e2.mp4', title: 'Series One — S1E2',
      poster: '', accountId: 'x1', itemId: 'e2', kind: 'episode' as const, subtitles: [],
    };
    player.playVod(req({ itemId: 'e1', kind: 'episode', episodeQueue: [next] }));
    vi.mocked(probeMedia).mockClear();

    video.dispatchEvent(new Event('ended'));
    expect(container.textContent).toContain('Starts in 10 seconds');
    expect(container.textContent).toContain('Series One — S1E2');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(probeMedia).toHaveBeenCalledWith(next.url, 'x1|media_probe|episode|e2');
    expect(player.isVod()).toBe(true);
  });

  it('removes a series from Watchlist only after its final episode', () => {
    const video = fakeVideo(1800);
    player.init(video);
    vi.mocked(StorageService.removeWatchlist).mockClear();
    player.playVod(req({
      itemId: 'e2',
      kind: 'episode',
      episodeQueue: [],
      watchlistOwner: { kind: 'series', itemId: 's1' },
    }));
    video.dispatchEvent(new Event('ended'));
    expect(StorageService.removeWatchlist).toHaveBeenCalledWith('x1', 'series', 's1');
  });

  it('keeps a series in Watchlist when another episode remains', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 1800, configurable: true });
    container.appendChild(video);
    player.init(video);
    vi.mocked(StorageService.removeWatchlist).mockClear();
    player.playVod(req({
      itemId: 'e1',
      kind: 'episode',
      watchlistOwner: { kind: 'series', itemId: 's1' },
      episodeQueue: [{
        url: 'http://host/series/e2.mp4', title: 'Series One — S1E2',
        poster: '', accountId: 'x1', itemId: 'e2', kind: 'episode', subtitles: [],
        watchlistOwner: { kind: 'series', itemId: 's1' },
      }],
    }));
    video.dispatchEvent(new Event('ended'));
    expect(StorageService.removeWatchlist).not.toHaveBeenCalled();
  });

  it('cancels the next-episode countdown with Back', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 1800, configurable: true });
    container.appendChild(video);
    player.init(video);
    const r = req({
      itemId: 'e1',
      kind: 'episode',
      episodeQueue: [{
        url: 'http://host:8080/series/u/p/e2.mp4', title: 'Series One — S1E2',
        poster: '', accountId: 'x1', itemId: 'e2', kind: 'episode', subtitles: [],
      }],
    });
    player.playVod(r);
    video.dispatchEvent(new Event('ended'));
    player.handleAction('back');

    expect(r.onBack).toHaveBeenCalledTimes(1);
    expect(player.isVod()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(r.onBack).toHaveBeenCalledTimes(1);
  });

  it('ignores channel up/down in VOD mode', () => {
    const video = fakeVideo(3600);
    player.init(video);
    player.playVod(req());
    expect(() => { player.handleAction('channel_up'); player.handleAction('up'); }).not.toThrow();
    expect(player.isVod()).toBe(true);
  });

  it('routes a playback error to onBack, not a channel change', () => {
    const video = fakeVideo(3600);
    player.init(video);
    const r = req();
    player.playVod(r);
    playlistMock.channels = [{}, {}]; // non-empty so a stray channelUp would fire
    playlistMock.getByIndex.mockClear();
    vi.mocked(showToast).mockClear();
    video.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(3000); // let any (unwanted) channelUp timer run
    expect(r.onBack).toHaveBeenCalled();
    expect(player.isVod()).toBe(false);
    expect(playlistMock.getByIndex).not.toHaveBeenCalled(); // no channel playback
    expect(showToast).toHaveBeenCalled();
  });

  it('surfaces a source the element refused, which fires no error event', () => {
    const video = fakeVideo(3600);
    // NETWORK_NO_SOURCE: every <source> was skipped, so no 'error' ever arrives.
    Object.assign(video, { readyState: 0, networkState: 3 });
    player.init(video);
    const r = req({ url: 'http://host:8080/movie/u/p/10.mkv' });
    player.playVod(r);
    video.dispatchEvent(new Event('loadstart'));
    vi.mocked(showToast).mockClear();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.advanceTimersByTime(CONFIG.PLAYER.STARTUP_POLL_MS);

    // A rejected source never becomes currentSrc, so the URL comes from the request.
    const detail = logged.mock.calls[0].join(' ');
    expect(detail).toContain('extension=mkv');
    expect(detail).toContain('url=http://host:8080/movie/***/***/10.mkv');
    logged.mockRestore();
    expect(showToast).toHaveBeenCalledWith('Unable to play this video.');
    expect(r.onBack).toHaveBeenCalled();
    expect(player.isVod()).toBe(false);
  });

  it('surfaces a VOD stream that never produces a frame', () => {
    const video = fakeVideo(3600);
    Object.assign(video, { readyState: 0, networkState: 2 }); // NETWORK_LOADING forever
    player.init(video);
    const r = req();
    player.playVod(r);
    video.dispatchEvent(new Event('loadstart'));
    vi.mocked(showToast).mockClear();

    vi.advanceTimersByTime(CONFIG.PLAYER.STARTUP_TIMEOUT);

    expect(showToast).toHaveBeenCalledWith('Unable to play this video.');
    expect(r.onBack).toHaveBeenCalled();
  });

  it('stops watching once the stream starts', () => {
    const video = fakeVideo(3600);
    Object.assign(video, { readyState: 0, networkState: 2 });
    player.init(video);
    player.playVod(req());
    video.dispatchEvent(new Event('loadstart'));
    vi.mocked(showToast).mockClear();
    Object.assign(video, { readyState: 4 });

    vi.advanceTimersByTime(CONFIG.PLAYER.STARTUP_TIMEOUT * 2);

    expect(showToast).not.toHaveBeenCalled();
    expect(player.isVod()).toBe(true);
  });

  it('does not fail a VOD that was still loading when the app was hidden', () => {
    const video = fakeVideo(3600);
    Object.assign(video, { readyState: 0, networkState: 2 });
    player.init(video);
    const r = req();
    player.playVod(r);
    video.dispatchEvent(new Event('loadstart'));
    vi.mocked(showToast).mockClear();

    player.suspend();
    vi.advanceTimersByTime(CONFIG.PLAYER.STARTUP_TIMEOUT * 2);

    expect(showToast).not.toHaveBeenCalled();
    expect(r.onBack).not.toHaveBeenCalled();
  });

  it('does not re-arm the startup watchdog for a VOD that already played', () => {
    const video = fakeVideo(3600);
    Object.assign(video, { readyState: 0, networkState: 2 });
    player.init(video);
    const r = req();
    player.playVod(r);
    video.dispatchEvent(new Event('loadstart'));
    video.dispatchEvent(new Event('loadeddata')); // first frame decoded
    player.suspend();
    // Back from hidden mid-seek: readyState drops below HAVE_CURRENT_DATA
    // without the stream having failed to start.
    Object.assign(video, { readyState: 1 });
    vi.mocked(showToast).mockClear();

    player.resume();
    vi.advanceTimersByTime(CONFIG.PLAYER.STARTUP_TIMEOUT * 2);

    expect(showToast).not.toHaveBeenCalled();
    expect(r.onBack).not.toHaveBeenCalled();
  });

  it('does not clobber the resume point when Back is pressed before metadata loads', () => {
    const video = fakeVideo(NaN); // duration NaN — metadata not loaded yet
    player.init(video);
    const r = req();
    player.playVod(r);
    vi.mocked(StorageService.setResume).mockClear();
    player.handleAction('back');
    expect(StorageService.setResume).not.toHaveBeenCalled();
    expect(r.onBack).toHaveBeenCalled();
  });
});

describe('containerMime', () => {
  it('maps reliably recognized progressive extensions to their MIME', () => {
    expect(containerMime('http://host/movie/u/p/10.mp4')).toBe('video/mp4');
    expect(containerMime('http://host/movie/u/p/10.m4v')).toBe('video/mp4');
    expect(containerMime('http://host/movie/u/p/10.ts')).toBe('video/mp2t');
  });

  it('ignores query strings and fragments when reading the extension', () => {
    expect(containerMime('http://host/movie/u/p/10.mp4?token=x')).toBe('video/mp4');
    expect(containerMime('http://host/movie/u/p/10.mkv#frag')).toBe('');
  });

  it('claims no type for containers without reliable webOS MIME recognition', () => {
    expect(containerMime('http://host/movie/u/p/10.mkv')).toBe('');
    expect(containerMime('http://host/movie/u/p/10.avi')).toBe('');
    expect(containerMime('http://host/movie/u/p/10.mov')).toBe('');
    expect(containerMime('http://host/movie/u/p/10.webm')).toBe('');
  });

  it('claims no type for unknown or extension-less URLs', () => {
    expect(containerMime('http://host/movie/u/p/10.xyz')).toBe('');
    expect(containerMime('http://host/movie/u/p/10')).toBe('');
  });
});

describe('extFromUrl', () => {
  it('reads the lowercased extension, ignoring query and fragment', () => {
    expect(extFromUrl('http://host/movie/u/p/10.MP4')).toBe('mp4');
    expect(extFromUrl('http://host/series/u/p/e1.mkv?token=x')).toBe('mkv');
    expect(extFromUrl('http://host/series/u/p/e1.avi#frag')).toBe('avi');
    expect(extFromUrl('http://host/movie/u/p/10')).toBe('');
  });
});

describe('sniffStreamContentType', () => {
  it('recognizes an MPEG-TS body served as application/octet-stream', () => {
    const prefix = new Uint8Array(900);
    prefix[300] = 0x47;
    prefix[488] = 0x47;
    prefix[676] = 0x47;
    expect(sniffStreamContentType('application/octet-stream', prefix)).toBe('video/mp2t');
  });

  it('recognizes an HLS body served as application/octet-stream', () => {
    const prefix = new TextEncoder().encode('#EXTM3U\n#EXT-X-VERSION:3');
    expect(sniffStreamContentType('application/octet-stream', prefix))
      .toBe('application/vnd.apple.mpegurl');
  });

  it('leaves unknown binary and specific response types unchanged', () => {
    expect(sniffStreamContentType('application/octet-stream', new Uint8Array([1, 2, 3])))
      .toBe('application/octet-stream');
    expect(sniffStreamContentType('video/mp2t; charset=binary', new Uint8Array()))
      .toBe('video/mp2t');
  });
});

describe('stream routing', () => {
  it('classifies stream URLs by extension path or query parameter', () => {
    expect(streamUrlMime('http://host/live/ch1.TS?token=x')).toBe('video/mp2t');
    expect(streamUrlMime('http://host/live?id=ch1&extension=ts#fragment')).toBe('video/mp2t');
    expect(streamUrlMime('http://host/live/ch1.FLV#fragment')).toBe('video/x-flv');
    expect(streamUrlMime('http://host/live?extension=FLV&token=x')).toBe('video/x-flv');
    expect(streamUrlMime('http://host/live/ch1.m3u8?token=x'))
      .toBe('application/vnd.apple.mpegurl');
    expect(streamUrlMime('http://host/live?extension=flv2')).toBe('');
  });

  it('groups extension-less channels by origin and route prefix', () => {
    expect(streamRouteKey('http://host/play/ch1')).toBe('http://host/play');
    expect(streamRouteKey('http://host/play/ch2?token=x')).toBe('http://host/play');
    expect(streamRouteKey('http://host/catchup/ch1')).toBe('http://host/catchup');
    expect(streamRouteKey('not a url')).toBe('');
  });

  it('separates routes by the requested live output format', () => {
    // The same route serves a different container per requested format, so a
    // probe of one must not classify the other.
    expect(streamRouteKey('http://host/live/ch1?output_format=m3u8'))
      .toBe('http://host/live?output=m3u8');
    expect(streamRouteKey('http://host/live/ch1?output_format=ts'))
      .toBe('http://host/live?output=ts');
    expect(streamRouteKey('http://host/live/ch1?output=m3u8'))
      .toBe('http://host/live?output=m3u8');
    expect(streamRouteKey('http://host/live/ch1?output_format=ts&token=x'))
      .toBe('http://host/live?output=ts');
  });

  it('redacts stream credentials while retaining diagnostic routing data', () => {
    expect(diagnosticStreamUrl(
      'http://user:pass@host/timeshift/u1/p1/60/start/42.ts?token=x&start=10&end=20',
    )).toBe(
      'http://***:***@host/timeshift/***/***/60/start/42.ts?token=***&start=10&end=20',
    );
    expect(diagnosticStreamUrl(
      'http://host/catchup/ch1.m3u8?start=10&end=20&auth=secret',
    )).toBe('http://host/catchup/ch1.m3u8?start=10&end=20&auth=***');
  });

  it('maps detected content types to native MIME values', () => {
    expect(streamMime('video/mp2t')).toBe('video/mp2t');
    expect(streamMime('video/x-flv')).toBe('video/x-flv');
    expect(streamMime('video/mp4; charset=binary')).toBe('video/mp4');
    expect(streamMime('application/vnd.apple.mpegurl')).toBe('application/vnd.apple.mpegurl');
    expect(streamMime('application/octet-stream')).toBe('');
    expect(streamMime('')).toBe('');
  });
});

describe('Player catch-up save/restore lifecycle', () => {
  // Outer beforeEach provides: player (with fakeVideo(120) via player.init(video)), video
  const setCatchupProgress = () => vi.mocked(StorageService.setCatchupProgress);

  beforeEach(() => {
    setCatchupProgress().mockClear();
  });

  it('applies resumeSecs from CatchupInfo on loadedmetadata', () => {
    player.play(0, { ...CATCHUP, resumeSecs: 45 });
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(45);
  });

  it('restores and persists progress for Xtream catch-up', async () => {
    playlistMock.getByIndex.mockReturnValue(XTREAM_CHANNEL);
    const start = Date.UTC(2026, 6, 21, 19, 30) / 1000;
    player.play(0, {
      ...CATCHUP,
      start,
      end: start + 3600,
      resumeSecs: 45,
    });
    await flush();

    expect(video.src).toContain('/timeshift/u1/p1/60/2026-07-21:15-30/42.ts');
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(45);

    video.currentTime = 70;
    setCatchupProgress().mockClear();
    video.dispatchEvent(new Event('seeked'));
    expect(setCatchupProgress()).toHaveBeenCalledWith(
      expect.objectContaining({
        channelKey: channelKey(XTREAM_CHANNEL),
        progStart: start * 1000,
        progEnd: (start + 3600) * 1000,
        position: 70,
      }),
      XTREAM_CHANNEL.catchupDays,
    );
  });

  it('clamps resumeSecs to duration-1 if it would overshoot', () => {
    player.play(0, { ...CATCHUP, resumeSecs: 999 });
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(119); // Math.min(999, 120-1)
  });

  it('does not seek when resumeSecs is absent', () => {
    player.play(0, CATCHUP);
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(0);
  });

  it('saves on pause with channelKey, progStart epoch ms, and position', () => {
    player.play(0, CATCHUP);
    video.currentTime = 60;
    setCatchupProgress().mockClear();
    player.handleAction('pause');
    expect(setCatchupProgress()).toHaveBeenCalledWith(
      expect.objectContaining({
        channelKey: channelKey(CHANNEL),
        progStart: CATCHUP.start * 1000,
        progEnd: CATCHUP.end * 1000,
        title: CATCHUP.title,
        description: CATCHUP.description,
        icon: CATCHUP.icon,
        position: 60,
      }),
      CHANNEL.catchupDays,
    );
  });

  it('saves on seeked', () => {
    player.play(0, CATCHUP);
    video.currentTime = 50;
    setCatchupProgress().mockClear();
    video.dispatchEvent(new Event('seeked'));
    expect(setCatchupProgress()).toHaveBeenCalledWith(
      expect.objectContaining({ position: 50 }),
      CHANNEL.catchupDays,
    );
  });

  it('saves on stop (back action)', () => {
    player.play(0, CATCHUP);
    video.currentTime = 70;
    setCatchupProgress().mockClear();
    player.handleAction('back');
    expect(setCatchupProgress()).toHaveBeenCalledWith(
      expect.objectContaining({ position: 70 }),
      CHANNEL.catchupDays,
    );
  });

  it('saves on channel switch (channelUp)', () => {
    player.play(0, CATCHUP);
    video.currentTime = 80;
    setCatchupProgress().mockClear();
    player.channelUp();
    expect(setCatchupProgress()).toHaveBeenCalledWith(
      expect.objectContaining({ position: 80 }),
      CHANNEL.catchupDays,
    );
  });

  it('saves on switching to VOD (playVod)', () => {
    player.play(0, CATCHUP);
    video.currentTime = 90;
    setCatchupProgress().mockClear();
    player.playVod({
      url: 'http://host/movie.mp4', title: 'Movie', poster: '',
      accountId: 'x1', itemId: '1', kind: 'vod', resumeSecs: 0,
      subtitles: [], onBack: vi.fn(),
    });
    expect(setCatchupProgress()).toHaveBeenCalledWith(
      expect.objectContaining({ position: 90 }),
      CHANNEL.catchupDays,
    );
  });

  it('throttles periodic saves to CHECKPOINT_INTERVAL via timeupdate', () => {
    player.play(0, CATCHUP);
    setCatchupProgress().mockClear();

    // First timeupdate — no time elapsed, no save.
    video.currentTime = 15;
    video.dispatchEvent(new Event('timeupdate'));
    expect(setCatchupProgress()).not.toHaveBeenCalled();

    // Advance past CHECKPOINT_INTERVAL.
    vi.advanceTimersByTime(CONFIG.CATCHUP.CHECKPOINT_INTERVAL + 100);
    video.currentTime = 45;
    video.dispatchEvent(new Event('timeupdate'));
    expect(setCatchupProgress()).toHaveBeenCalledTimes(1);
    expect(setCatchupProgress()).toHaveBeenCalledWith(
      expect.objectContaining({ position: 45 }),
      CHANNEL.catchupDays,
    );

    // Another timeupdate immediately after — still within interval, no second save.
    setCatchupProgress().mockClear();
    video.currentTime = 46;
    video.dispatchEvent(new Event('timeupdate'));
    expect(setCatchupProgress()).not.toHaveBeenCalled();
  });

  it('does not save on timeupdate for live playback (no catch-up)', () => {
    player.play(0); // live, no catchup
    setCatchupProgress().mockClear();
    vi.advanceTimersByTime(CONFIG.CATCHUP.CHECKPOINT_INTERVAL + 100);
    video.dispatchEvent(new Event('timeupdate'));
    expect(setCatchupProgress()).not.toHaveBeenCalled();
  });

  it('marks completed=true when the ended event fires on a catch-up stream', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const v = document.createElement('video');
    Object.defineProperty(v, 'duration', { value: 120, configurable: true });
    container.appendChild(v);
    player.init(v);

    player.play(0, CATCHUP);
    v.currentTime = 118;
    setCatchupProgress().mockClear();
    v.dispatchEvent(new Event('ended'));
    expect(setCatchupProgress()).toHaveBeenCalledWith(
      expect.objectContaining({ completed: true }),
      CHANNEL.catchupDays,
    );
  });

  it('saves with current position before suspend and queues that position for resume', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const v = document.createElement('video');
    Object.defineProperty(v, 'duration', { value: 120, configurable: true });
    // suspend() only saves when the element was playing; a real DOM element is always paused
    // without an actual src, so override paused to simulate the playing state.
    Object.defineProperty(v, 'paused', { get: () => false, configurable: true });
    container.appendChild(v);
    player.init(v);

    player.play(0, CATCHUP);
    v.currentTime = 55;
    setCatchupProgress().mockClear();

    player.suspend();
    // Progress saved with the pre-suspend position before the element was destroyed.
    expect(setCatchupProgress()).toHaveBeenCalledWith(
      expect.objectContaining({ position: 55 }),
      CHANNEL.catchupDays,
    );

    // After resume(), play() must queue 55 as the resume position.
    player.resume();
    const p = player as unknown as { pendingResumeSecs: number };
    expect(p.pendingResumeSecs).toBe(55);
  });

  it('preserves a pending resume seek when suspended before loadedmetadata applies it', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const v = document.createElement('video');
    Object.defineProperty(v, 'duration', { value: 120, configurable: true });
    Object.defineProperty(v, 'paused', { get: () => false, configurable: true });
    container.appendChild(v);
    player.init(v);

    // Resume from 45s, but the resume seek only runs on loadedmetadata — which we
    // never dispatch here, so currentTime stays 0 (the race window).
    player.play(0, { ...CATCHUP, resumeSecs: 45 });
    expect(v.currentTime).toBe(0);

    player.suspend();
    player.resume();
    // The requested 45s must survive — not collapse to 0 from the un-advanced element.
    const p = player as unknown as { pendingResumeSecs: number };
    expect(p.pendingResumeSecs).toBe(45);
  });

  it('does not write zero-position progress after suspend recreates the element', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const v = document.createElement('video');
    Object.defineProperty(v, 'duration', { value: 120, configurable: true });
    Object.defineProperty(v, 'paused', { get: () => false, configurable: true });
    container.appendChild(v);
    player.init(v);

    player.play(0, CATCHUP);
    v.currentTime = 55;
    player.suspend();
    setCatchupProgress().mockClear(); // ignore the suspend save

    // resume() calls play() with a fresh element (currentTime=0); that must not overwrite.
    player.resume();
    expect(setCatchupProgress()).not.toHaveBeenCalled();

    // The fresh element's first timeupdate should also be silent (checkpoint timer reset).
    const freshEl = (player as unknown as { videoEl: HTMLVideoElement }).videoEl;
    freshEl.dispatchEvent(new Event('timeupdate'));
    expect(setCatchupProgress()).not.toHaveBeenCalled();
  });

  it('does not save catch-up progress when channel has no catchupSource', () => {
    playlistMock.getByIndex.mockReturnValue(CHANNEL_NO_CATCHUP);
    player.play(0, CATCHUP);
    video.currentTime = 60;
    setCatchupProgress().mockClear();
    player.handleAction('pause');
    expect(setCatchupProgress()).not.toHaveBeenCalled();

    // Also no write on seeked
    video.dispatchEvent(new Event('seeked'));
    expect(setCatchupProgress()).not.toHaveBeenCalled();

    // Also no write on back
    player.handleAction('back');
    expect(setCatchupProgress()).not.toHaveBeenCalled();
  });
});

describe('Player subtitle-offset overlay', () => {
  it('opens, routes actions, and closes without throwing', () => {
    document.body.innerHTML = '<div id="pc"></div><div id="subtitle-offset" class="hidden"></div>';
    const p = new Player(document.getElementById('pc') as HTMLElement, vi.fn());
    p.init(fakeVideo(0));
    (p as unknown as { currentChannel: unknown }).currentChannel = { ...CHANNEL };
    p.openSubtitleOffset();
    const offset = document.getElementById('subtitle-offset')!;
    expect(offset.classList.contains('hidden')).toBe(false);
    // The overlay owns its keys while open, ahead of the player view.
    expect(Focus.owner()?.id).toBe('player.subtitle_offset');
    expect(Focus.owner()?.handle('right')).toBe(true);
    expect(Focus.owner()?.handle('back')).toBe(true);
    expect(offset.classList.contains('hidden')).toBe(true);
    expect(Focus.owner()).toBeNull();
  });
});

describe('Player channel number entry', () => {
  beforeEach(() => {
    playlistMock.channels = [CHANNEL, CHANNEL_NO_CATCHUP, XTREAM_CHANNEL];
  });
  afterEach(() => {
    playlistMock.channels = [];
  });

  it('jumps to the 1-based channel number the digits spelled out', () => {
    const play = vi.spyOn(player, 'play').mockImplementation(() => {});

    player.handleAction('number', { number: 2 });

    expect(play).toHaveBeenCalledWith(1, undefined, null);
  });

  it('ignores a number outside the channel list instead of switching', () => {
    const play = vi.spyOn(player, 'play').mockImplementation(() => {});

    player.handleAction('number', { number: 0 });
    player.handleAction('number', { number: 4 });

    expect(play).not.toHaveBeenCalled();
  });

  it('ignores channel numbers during VOD playback', () => {
    const play = vi.spyOn(player, 'play').mockImplementation(() => {});
    (player as unknown as { vod: unknown }).vod = { title: 'Movie' };

    player.handleAction('number', { number: 2 });

    expect(play).not.toHaveBeenCalled();
  });
});

describe('Player channel_up/channel_down view scope', () => {
  // Global order deliberately interleaves a non-favorite (OTHER) between two
  // favorites — exactly the real-world layout that made channel_up from
  // Favorites land on a non-favorite channel before this fix.
  const FAV_A = { id: 'fa', name: 'FavA', logo: '', group: '', url: 'http://host/fa', extras: null, playlistIds: [], catchupDays: 0 };
  const OTHER = { id: 'ox', name: 'Other', logo: '', group: '', url: 'http://host/ox', extras: null, playlistIds: [], catchupDays: 0 };
  const FAV_B = { id: 'fb', name: 'FavB', logo: '', group: '', url: 'http://host/fb', extras: null, playlistIds: [], catchupDays: 0 };
  const FAV_C = { id: 'fc', name: 'FavC', logo: '', group: '', url: 'http://host/fc', extras: null, playlistIds: [], catchupDays: 0 };
  const GLOBAL = [FAV_A, OTHER, FAV_B, FAV_C];
  let favorites: (typeof FAV_A)[];

  beforeEach(() => {
    favorites = [FAV_A, FAV_B, FAV_C];
    playlistMock.channels = GLOBAL;
    playlistMock.getByIndex.mockImplementation((i: number) => GLOBAL[i] ?? null);
    playlistMock.indexOf.mockImplementation((ch: unknown) => GLOBAL.indexOf(ch as never));
    playlistMock.getByGroup.mockImplementation(() => favorites);
    // These tests exercise scoped stepping, which only applies when the
    // user opted into it — settings.channelCycleMode: 'active'.
    vi.mocked(StorageService.getChannelCycleMode).mockReturnValue('active');
  });
  afterEach(() => {
    playlistMock.channels = [];
    vi.mocked(StorageService.getChannelCycleMode).mockReturnValue('global');
  });

  it('steps within the launch scope, skipping channels outside it', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A
    player.channelUp();
    expect(player.getCurrentChannel()).toBe(FAV_B); // not OTHER, which sits between them globally
    player.channelUp();
    expect(player.getCurrentChannel()).toBe(FAV_C);
  });

  it('passes over parental-locked channels in both directions', () => {
    vi.mocked(StorageService.getChannelCycleMode).mockReturnValue('global');
    const decision = vi.spyOn(ParentalControlService, 'decision').mockImplementation(request =>
      request.target.kind === 'live-channel' && request.target.channelKey === channelKey(OTHER as never)
        ? { allowed: false, concealed: false, reason: 'item' }
        : { allowed: true });
    const enabled = vi.spyOn(ParentalControlService, 'enabled', 'get').mockReturnValue(true);
    try {
      player.play(0); // FAV_A
      player.channelUp();
      expect(player.getCurrentChannel()).toBe(FAV_B);
      player.channelDown();
      expect(player.getCurrentChannel()).toBe(FAV_A);
    } finally {
      decision.mockRestore();
      enabled.mockRestore();
    }
  });

  it('wraps at the end of the scope instead of spilling into the full list', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A
    player.channelUp(); // -> FAV_B
    player.channelUp(); // -> FAV_C
    player.channelUp(); // wraps
    expect(player.getCurrentChannel()).toBe(FAV_A);
  });

  it('wraps backward the same way with channelDown', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A
    player.channelDown();
    expect(player.getCurrentChannel()).toBe(FAV_C); // wraps to the scope's last entry
  });

  it('picks up a live change to the scope on the very next press', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A
    favorites = [FAV_A, FAV_C]; // FAV_B unfavorited mid-playback
    player.channelUp();
    expect(player.getCurrentChannel()).toBe(FAV_C);
  });

  it('falls back to the global list when the playing channel drops out of scope', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A, global index 0
    favorites = [FAV_B, FAV_C]; // FAV_A itself unfavorited while it's still playing
    player.channelUp();
    // FAV_A is gone from the scope — resume plain global stepping from its
    // global index (0) instead of a remembered slot in the stale scope.
    expect(player.getCurrentChannel()).toBe(OTHER);
  });

  it('falls back to the global list when the scope becomes empty', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A
    favorites = []; // the whole group emptied out mid-playback
    player.channelUp();
    expect(player.getCurrentChannel()).toBe(OTHER); // global neighbor of FAV_A
  });

  it('stays on global stepping for a scope it already fell back out of', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A
    favorites = [FAV_B, FAV_C]; // FAV_A drops out
    player.channelUp(); // falls back to global -> OTHER, and clears the scope
    player.channelUp(); // now plain global stepping from OTHER
    expect(player.getCurrentChannel()).toBe(FAV_B);
  });

  it('keeps a scope across internal channelUp/channelDown replays', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A
    player.channelUp(); // -> FAV_B, via the internal 2-arg play() call
    player.channelUp(); // still scoped -> FAV_C, not the global next (FAV_C anyway, but via scope math)
    expect(player.getCurrentChannel()).toBe(FAV_C);
  });

  it('has no scope when launched without one — channel_up cycles the full list', () => {
    player.play(0); // no scope passed at all
    player.channelUp();
    expect(player.getCurrentChannel()).toBe(OTHER); // the full-list neighbor, not a favorite
  });

  it('a global number jump mid-scope clears the scope for the next channel_up', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A
    player.handleAction('number', { number: 2 }); // jump to global index 1 = OTHER
    expect(player.getCurrentChannel()).toBe(OTHER);
    player.channelUp();
    expect(player.getCurrentChannel()).toBe(FAV_B); // global neighbor of OTHER, not scoped
  });

  it('keeps the OSD channel number global even while scoped to Favorites', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A, global index 0
    player.channelUp(); // -> FAV_B, global index 2
    expect(player.getCurrentIndex()).toBe(2);
  });

  it('ignores an active launch scope when settings.channelCycleMode is global (the default)', () => {
    vi.mocked(StorageService.getChannelCycleMode).mockReturnValue('global');
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A, scope tracked either way
    player.channelUp();
    expect(player.getCurrentChannel()).toBe(OTHER); // full-list neighbor, not FAV_B
  });
});

describe('Player controls', () => {
  type QueueItem = {
    url: string; title: string; poster: string; accountId: string; itemId: string;
    kind: 'episode'; subtitles: never[]; categoryId: string; parentalItemId: string;
  };
  const episode = (n: number): QueueItem => ({
    url: `http://host/series/e${n}.mp4`, title: `Series One — S1E${n}`, poster: '',
    accountId: 'x1', itemId: `e${n}`, kind: 'episode', subtitles: [],
    categoryId: 'c1', parentalItemId: 's1',
  });
  const movie = (over = {}) => ({
    url: 'http://host/movie/10.mp4', title: 'Movie One', poster: '', accountId: 'x1', itemId: '10',
    kind: 'vod' as const, resumeSecs: 0, subtitles: [], onBack: vi.fn(), ...over,
  });
  const controls = () => Array.from(container.querySelectorAll('[data-dock-action]'))
    .map(el => `${el.getAttribute('data-dock-action')}${el.hasAttribute('disabled') ? ':disabled' : ''}`);
  const osdHidden = () => container.querySelector('#player-osd')!.classList.contains('hidden');
  const internals = () => player as unknown as {
    osd: { hide(): void; focused(): string | null; isActive(): boolean };
    tracks: { getAudioTracks: () => unknown[]; getSubtitleTracks: () => unknown[] };
  };

  // A real <video> whose element can be swapped (episode switches recreate it),
  // with a settable position.
  function realVideo(duration = 1800): HTMLVideoElement {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const el = document.createElement('video');
    let time = 0;
    Object.defineProperty(el, 'duration', { value: duration, configurable: true });
    Object.defineProperty(el, 'currentTime', {
      configurable: true, get: () => time, set: (t: number) => { time = t; },
    });
    container.appendChild(el);
    return el;
  }

  describe('VOD keys', () => {
    beforeEach(() => {
      player.playVod(movie({ url: 'http://host/movie/10.mp4' }));
      remoteKeys();
    });

    it('skips with Left/Right while the controls are hidden, showing them on the seek bar', () => {
      internals().osd.hide();
      expect(osdHidden()).toBe(true);
      player.handleAction('right');
      expect(video.currentTime).toBe(10);
      expect(osdHidden()).toBe(false);
      expect(internals().osd.focused()).toBe('seek');
      expect(container.querySelector('.osd-seek-delta')!.textContent).toBe('+0:10');
      player.handleAction('left');
      player.handleAction('left');
      expect(video.currentTime).toBe(0);
      expect(video.paused).toBe(false);
      vi.advanceTimersByTime(CONFIG.PLAYER.SEEK_BUBBLE_MS);
      expect(container.querySelector('.osd-seek-bubble')).toBeNull();
    });

    it('speeds a held key up: 10s steps, then 30s after a second, 60s after three', () => {
      (video as { duration: number }).duration = 100_000;
      const seeks: number[] = [];
      let last = 0;
      const step = () => { seeks.push(video.currentTime - last); last = video.currentTime; };
      player.handleAction('right');
      step();
      setKeyRepeat(true);
      for (let t = 50; t <= 4000; t += 50) {
        vi.advanceTimersByTime(50);
        player.handleAction('right');
        if (video.currentTime !== last) step();
      }
      setKeyRepeat(false);
      const repeat = CONFIG.PLAYER.SEEK_HOLD_REPEAT_MS;
      expect(seeks[0]).toBe(10);
      // At most one step per repeat interval, sped up as the hold goes on.
      expect(seeks.length).toBe(1 + Math.floor(4000 / repeat));
      expect(seeks.slice(0, 1000 / repeat)).toEqual(Array(1000 / repeat).fill(10));
      expect(seeks[1000 / repeat]).toBe(30);
      expect(seeks[3000 / repeat - 1]).toBe(30);
      expect(seeks[3000 / repeat]).toBe(60);
      expect(seeks[seeks.length - 1]).toBe(60);
      expect(video.paused).toBe(false);

      // A fresh press starts over at the base step.
      const before = video.currentTime;
      player.handleAction('right');
      expect(video.currentTime - before).toBe(10);
    });

    it('turns a held key around at the base step', () => {
      player.handleAction('right');
      setKeyRepeat(true);
      vi.advanceTimersByTime(2000);
      player.handleAction('left');
      expect(video.currentTime).toBe(0);
    });

    it('shows the controls with Up/Down without pausing; Down steps into the buttons', () => {
      internals().osd.hide();
      player.handleAction('down');
      expect(osdHidden()).toBe(false);
      expect(video.paused).toBe(false);
      expect(internals().osd.focused()).toBe('seek');
      player.handleAction('down');
      expect(internals().osd.focused()).toBe('playpause');
      // On the buttons, Left/Right move between them and never skip.
      player.handleAction('right');
      expect(video.currentTime).toBe(0);
      player.handleAction('up');
      expect(internals().osd.focused()).toBe('seek');
      internals().osd.hide();
      player.handleAction('up');
      expect(osdHidden()).toBe(false);
      expect(video.paused).toBe(false);
    });

    it('pauses and resumes with OK, showing the controls', () => {
      internals().osd.hide();
      player.handleAction('select');
      expect(video.paused).toBe(true);
      expect(osdHidden()).toBe(false);
      player.handleAction('select');
      expect(video.paused).toBe(false);
    });

    it('presses the focused button with OK', () => {
      player.handleAction('down');
      player.handleAction('select');
      expect(video.paused).toBe(true);
    });

    // Regression: a panel the picker opens (online search, sync adjuster)
    // takes the keys; the controls behind it must not keep a parked ring.
    it.each(['openSubtitleSearch', 'openSubtitleOffset'] as const)(
      'gives up the controls\' keys when the picker runs %s', (open) => {
        expect(internals().osd.isActive()).toBe(true);
        (player as unknown as { picker: { options: Record<typeof open, () => void> } })
          .picker.options[open]();
        expect(internals().osd.isActive()).toBe(false);
        // Up brings the keys back to the controls.
        player.handleAction('up');
        expect(internals().osd.focused()).toBe('seek');
      });

    it('offers Audio and Subtitles only for a real choice', () => {
      expect(controls()).toEqual(['playpause']);
      internals().tracks.getAudioTracks = () => [{ index: 0 }, { index: 1 }];
      internals().tracks.getSubtitleTracks = () => [{ index: 0 }];
      player.showOSD();
      expect(controls()).toEqual(['playpause', 'audio', 'subtitles']);
      internals().tracks.getAudioTracks = () => [{ index: 0 }];
      internals().tracks.getSubtitleTracks = () => [];
      player.showOSD();
      expect(controls()).toEqual(['playpause']);
    });
  });

  describe('episodes', () => {
    let onBack: ReturnType<typeof vi.fn>;
    const play = (index: number, all = [1, 2, 3]) => {
      onBack = vi.fn();
      video = realVideo();
      player.init(video);
      player.playVod({
        ...episode(all[index]), resumeSecs: 0, onBack,
        previousEpisodes: all.slice(0, index).map(episode),
        episodeQueue: all.slice(index + 1).map(episode),
      });
    };
    const playing = () => (player as unknown as { vod: { itemId: string; previousEpisodes?: QueueItem[];
      episodeQueue?: QueueItem[] } | null }).vod;

    it('disables Previous on the first episode and Next on the last; movies have neither', () => {
      play(0);
      expect(controls()).toEqual(['previous:disabled', 'playpause', 'next']);
      play(2);
      expect(controls()).toEqual(['previous', 'playpause', 'next:disabled']);
      player.playVod(movie());
      expect(controls()).toEqual(['playpause']);
    });

    it('plays the previous episode within the first minute, keeping the queue in order', () => {
      play(1);
      video.currentTime = CONFIG.PLAYER.PREVIOUS_EPISODE_WINDOW - 1;
      vi.mocked(StorageService.setResume).mockClear();
      (player as unknown as { onDockControl(c: string): void }).onDockControl('previous');
      expect(playing()?.itemId).toBe('e1');
      expect(playing()?.previousEpisodes).toEqual([]);
      expect(playing()?.episodeQueue?.map(e => e.itemId)).toEqual(['e2', 'e3']);
      expect(onBack).not.toHaveBeenCalled();
    });

    it('restarts the episode once past the first minute', () => {
      play(1);
      video.currentTime = CONFIG.PLAYER.PREVIOUS_EPISODE_WINDOW;
      (player as unknown as { onDockControl(c: string): void }).onDockControl('previous');
      expect(playing()?.itemId).toBe('e2');
      expect(video.currentTime).toBe(0);
    });

    it('plays the next episode at once, saving where this one was left', () => {
      play(1);
      video.currentTime = 300;
      vi.mocked(StorageService.setResume).mockClear();
      (player as unknown as { onDockControl(c: string): void }).onDockControl('next');
      expect(StorageService.setResume).toHaveBeenCalledWith(expect.objectContaining({
        itemId: 'e2', position: 300,
      }));
      expect(playing()?.itemId).toBe('e3');
      expect(playing()?.previousEpisodes?.map(e => e.itemId)).toEqual(['e1', 'e2']);
      expect(playing()?.episodeQueue).toEqual([]);
      expect(controls()).toEqual(['previous', 'playpause', 'next:disabled']);
    });

    it('asks for the PIN before switching to an episode another rule locks', () => {
      const authorize = vi.fn(() => false);
      player = new Player(
        container, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, authorize,
      );
      onBack = vi.fn();
      video = realVideo();
      player.init(video);
      const next = { ...episode(2), parentalItemId: 's2' };
      authorize.mockImplementationOnce(((_item: unknown, action: () => void) => { action(); return true; }) as never);
      player.playVod({ ...episode(1), resumeSecs: 0, onBack, episodeQueue: [next] });
      (player as unknown as { onDockControl(c: string): void }).onDockControl('next');
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(onBack).toHaveBeenCalledOnce();
    });

    it('carries the episodes before into the resume point and the up-next item', async () => {
      play(1);
      video.currentTime = 300;
      vi.mocked(StorageService.setResume).mockClear();
      player.handleAction('back');
      expect(StorageService.setResume).toHaveBeenCalledWith(expect.objectContaining({
        itemId: 'e2',
        previousEpisodes: [episode(1)],
        episodeQueue: [episode(3)],
      }));

      play(1);
      video.dispatchEvent(new Event('ended'));
      await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.UP_NEXT_COUNTDOWN * 1000);
      expect(playing()?.itemId).toBe('e3');
      expect(playing()?.previousEpisodes?.map(e => e.itemId)).toEqual(['e1', 'e2']);
    });
  });

  describe('live keys', () => {
    let isFavorite: boolean;
    let toggleFavorite: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      isFavorite = false;
      toggleFavorite = vi.fn(() => { isFavorite = !isFavorite; });
      player = new Player(
        container, vi.fn(), undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        { isFavorite: () => isFavorite, toggleFavorite },
      );
      player.init(video);
      playlistMock.channels = [CHANNEL, CHANNEL_NO_CATCHUP];
      playlistMock.getByIndex.mockImplementation((i: number) => playlistMock.channels[i]);
      player.play(0);
      remoteKeys();
    });
    afterEach(() => {
      playlistMock.channels = [];
      playlistMock.getByIndex.mockReset();
    });

    it('changes channel with Up/Down under the info a zap shows, and leaves Right alone', () => {
      expect(osdHidden()).toBe(false);
      expect(internals().osd.isActive()).toBe(false);
      expect(player.claimsLeft()).toBe(false);
      player.handleAction('down');
      expect(player.getCurrentChannel()).not.toBe(CHANNEL);
      player.handleAction('up');
      expect(player.getCurrentChannel()).toBe(CHANNEL);
      internals().osd.hide();
      player.handleAction('right');
      expect(osdHidden()).toBe(true);
      expect(player.getCurrentChannel()).toBe(CHANNEL);
    });

    it('hands OK the controls: Favorite, Channel info, and Up/Down stay in them', () => {
      player.handleAction('select');
      expect(internals().osd.isActive()).toBe(true);
      expect(controls()).toEqual(['favorite', 'info']);
      expect(internals().osd.focused()).toBe('favorite');
      expect(player.claimsLeft()).toBe(true);
      player.handleAction('down');
      expect(player.getCurrentChannel()).toBe(CHANNEL);
      player.handleAction('select');
      expect(toggleFavorite).toHaveBeenCalledWith(CHANNEL);
      expect(container.querySelector('[data-dock-action="favorite"]')!.getAttribute('aria-pressed'))
        .toBe('true');
      player.handleAction('right');
      expect(internals().osd.focused()).toBe('info');
      expect(player.handleBack()).toBe(true);
      expect(osdHidden()).toBe(true);
    });

    it('gives the keys back on a channel change', () => {
      player.handleAction('select');
      player.handleAction('channel_up');
      expect(internals().osd.isActive()).toBe(false);
      expect(osdHidden()).toBe(false);
    });

    // Regression: the native path learns its tracks from the manifest after
    // the controls first render; they must gain Subtitles then, not on the
    // next unrelated re-render.
    it('adds Subtitles to showing controls once the manifest names a track', () => {
      const tracks = internals().tracks as unknown as {
        applyManifest: () => void; getSubtitleTracks: () => unknown[];
      };
      tracks.applyManifest = () => {};
      expect(controls()).toEqual(['favorite', 'info']);
      tracks.getSubtitleTracks = () => [{ index: 0 }];
      (player as unknown as { applyPipelineManifest(m: unknown): void })
        .applyPipelineManifest({ variants: [] });
      expect(controls()).toEqual(['favorite', 'info', 'subtitles']);
    });

    it('offers Audio on live only with two tracks', () => {
      expect(controls()).toEqual(['favorite', 'info']);
      internals().tracks.getAudioTracks = () => [{ index: 0 }, { index: 1 }];
      player.showOSD();
      expect(controls()).toEqual(['favorite', 'info', 'audio']);
    });
  });
});
