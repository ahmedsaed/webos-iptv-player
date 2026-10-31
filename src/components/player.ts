import type {
  Action,
  CatchupInfo,
  Channel,
  ChannelScope,
  LivePlaybackSnapshot,
  LivePlaybackStatus,
  NumberEvent,
  VodPlayback,
  VodQueueItem,
  XtreamCatchupSource,
} from '../types';
import {
  formatXtreamCatchupStart,
  xtreamCatchupSources as buildXtreamCatchupSources,
  xtreamCredentialsFromLiveUrl,
} from '../utils/xtream-url';
import { show, hide } from '../utils/dom';
import { channelKey } from '../utils/channel';
import { dvrWindow, dvrState, type DvrWindow } from '../utils/dvr';
import { PlaylistService } from '../services/playlist-service';
import { ParentalControlService, liveParentalRequest } from '../services/parental-control';
import { EpgService } from '../services/epg-service';
import { StorageService } from '../services/storage-service';
import { CONFIG } from '../config';
import { StallWatchdog, type StallProbe, type StallRecovery } from '../utils/stall-watchdog';
import { StartupWatchdog, type StartupFailure, type StartupProbe } from '../utils/startup-watchdog';
import { resolutionBadge, hdrLabel, frameRateLabel, pickVariant, codecName, audioSummary, subtitleSummary, type StreamVariant, type MediaInfo } from '../utils/stream-info';
import { extFromUrl, diagnosticStreamUrl } from '../utils/url';
import { isWebOS } from '../utils/platform';
import { InputMode } from '../navigation/input-mode';
import { probeMedia } from '../services/media-probe';
import { ChannelHealthService } from '../services/channel-health';
import { createLogger } from '../utils/logger';
import { t } from '../i18n';
import { showToast } from './toast';
import { PlayerPipeline, type PipelineManifest } from './player-pipeline';
import {
  PlayerOsd,
  type DockControl,
  type PlayerOsdControls,
  type PlayerOsdSnapshot,
  type PlayerOsdStreamInfo,
} from './player-osd';
import { PlayerMenu } from './player-menu';
import { PlayerTracks } from './player-tracks';

const log = createLogger('Player');

export class Player {
  private container: HTMLElement;
  private onBack: () => void;
  private onTvPlaybackChanged: (channelIndex: number, catchupStart: number | null) => void;
  private canAutoRevealOsd: () => boolean;
  private onChannelHealthChanged: () => void;
  private videoEl: HTMLVideoElement | null = null;
  private pipeline: PlayerPipeline;
  private tracks: PlayerTracks;
  private osd: PlayerOsd;
  private picker: PlayerMenu;
  private currentChannel: Channel | null = null;
  private currentIndex = -1;
  private currentIndexAnchor = -1;
  // The view (group/playlist) the current channel was launched from, if any —
  // null for launches with no such view (search, reminders, resume-on-boot),
  // which keeps channel_up/channel_down on the full list exactly as before.
  private currentScope: ChannelScope | null = null;
  private catchupInfo: CatchupInfo | null = null;
  private vod: VodPlayback | null = null;
  private upNextSeconds = 0;
  private upNextTimer: ReturnType<typeof setInterval> | null = null;
  private upNextAuthorized = false;
  private vodTracksLatePending = false;
  private pendingResumeSecs = 0;
  private pendingSeekTarget: number | null = null;
  private wasPlayingBeforeHide = false;
  private dvrPauseTick: ReturnType<typeof setInterval> | null = null;
  // Catch-up progress checkpointing. Wall-clock time of the last periodic save;
  // reset to Date.now() on every new catch-up session so the first checkpoint
  // fires CHECKPOINT_INTERVAL after tune-in, not immediately.
  private catchupCheckpointAt = 0;
  // Position (seconds) saved from the video element before suspend() destroys it.
  // play() consumes this to restore the position on resume; -1 = not pending.
  private catchupSuspendPos = -1;
  private catchupSourceIndex = 0;
  private catchupVariantConfirmed = false;
  private playbackGeneration = 0;
  private healthSuccessGeneration = -1;
  private healthStartedAt = 0;
  private liveHistoryGeneration = -1;
  private liveHistoryTimer: ReturnType<typeof setTimeout> | null = null;
  private errorAdvanceTimer: ReturnType<typeof setTimeout> | null = null;
  private errorRetryPending = false;
  // A held Left/Right: when it started and last stepped, so it speeds up.
  private seekHold: { direction: 1 | -1; startedAt: number; steppedAt: number } | null = null;
  // The skip in progress, shown over the bar until SEEK_BUBBLE_MS after the last step.
  private seekDelta: number | null = null;
  private seekBubbleTimer: ReturnType<typeof setTimeout> | null = null;
  private manifestVariants: StreamVariant[] = []; // HLS master variants for best-effort codec readout
  private vodInfo: MediaInfo | null = null; // container-header stream info for the active VOD (codec/fps/HDR)
  private stallWatchdog: StallWatchdog;
  private startupWatchdog: StartupWatchdog;
  private startupPending = false;
  // The user paused the element; startup, reloads, and `play` clear it.
  private userPaused = false;
  private liveSessionActive = false;
  private playbackActive = false;
  private livePreviewMode = false;
  private livePlaybackStatus: LivePlaybackStatus = 'loading';
  private liveMuted = false;
  private liveVolume = 1;
  private previewMuteOverride: boolean | null = null;
  constructor(
    container: HTMLElement,
    onBack: () => void,
    onTvPlaybackChanged: (channelIndex: number, catchupStart: number | null) => void = () => {},
    canAutoRevealOsd: () => boolean = () => true,
    onChannelHealthChanged: () => void = () => {},
    private onPlaybackStateChanged: () => void = () => {},
    private canResumePlayback: () => boolean = () => true,
    private authorizeLive: (
      channel: Channel,
      action: () => void,
      preview: boolean,
      ask?: boolean,
    ) => boolean = (_channel, action) => {
      action();
      return true;
    },
    private authorizeVod: (
      item: VodPlayback,
      action: () => void,
    ) => boolean = (_item, action) => {
      action();
      return true;
    },
    private liveControls: {
      isFavorite: (channel: Channel) => boolean;
      toggleFavorite: (channel: Channel) => void;
    } = { isFavorite: () => false, toggleFavorite: () => {} },
  ) {
    this.container = container;
    this.onBack = onBack;
    this.onTvPlaybackChanged = onTvPlaybackChanged;
    this.canAutoRevealOsd = canAutoRevealOsd;
    this.onChannelHealthChanged = onChannelHealthChanged;
    this.pipeline = new PlayerPipeline({
      playbackLabel: loadToken => this.playbackLabel(loadToken),
      mediaState: video => this.mediaState(video),
      isCatchup: () => this.catchupInfo !== null,
      onError: reason => this.onError(reason),
      onAudioTracksUpdated: () => {
        this.tracks.applyHlsAudioSelection();
        this.tracksChanged();
      },
      onSubtitleTracksUpdated: () => {
        this.tracks.applyHlsSubtitleSelection();
        this.tracksChanged();
      },
      onManifest: manifest => this.applyPipelineManifest(manifest),
    });
    this.tracks = new PlayerTracks(this.pipeline, {
      getVideoElement: () => this.videoEl,
      getChannel: () => this.currentChannel,
      getVod: () => this.vod,
    });
    this.osd = new PlayerOsd(container, {
      getSnapshot: () => this.osdSnapshot(),
      canAutoReveal: () => this.canAutoRevealOsd(),
      canSeek: () => this.canSeek(),
      // VOD controls take the keys whenever they show; live ones on OK, so
      // Up/Down keep changing channels under the info a zap shows.
      activeWhenShown: () => this.vod !== null && this.upNextSeconds === 0,
      heldOpen: () => this.picker.visible,
      onSeekFraction: fraction => this.seekToFraction(fraction),
      onControl: control => this.onDockControl(control),
      onGoLive: () => this.goToLive(),
      onPlayNext: () => this.playNextItem(),
      onCancelNext: () => this.cancelNextItem(),
    });
    this.picker = new PlayerMenu(container, {
      getAudioTracks: () => this.tracks.getAudioTracks(),
      selectAudioTrack: index => this.selectAudioTrack(index),
      getSubtitleTracks: () => this.tracks.getSubtitleTracks(),
      selectSubtitleTrack: index => this.selectSubtitleTrack(index),
      getSubtitleOffsetState: () => this.tracks.subtitleOffsetState(),
      openSubtitleOffset: () => {
        // The adjuster is a modal over a picture the viewer watches to judge
        // timing: the controls step back and give up their ring.
        this.osd.deactivate();
        this.openSubtitleOffset();
      },
      subtitleSearchAvailable: () => this.tracks.subtitleSearchAvailable(),
      openSubtitleSearch: () => {
        // The search panel takes the keys; the controls give up their ring.
        this.osd.deactivate();
        this.openSubtitleSearch();
      },
      anchor: kind => this.osd.controlElement(kind),
      onClose: () => {
        if (this.osd.isVisible()) this.osd.resetTimer();
      },
    });
    this.stallWatchdog = new StallWatchdog({
      probe: (): StallProbe => {
        const v = this.videoEl;
        // No element -> report "paused" so a stray tick is a no-op.
        if (!v) return { currentTime: 0, readyState: 0, networkState: 0, paused: true, seeking: false };
        return {
          currentTime: v.currentTime,
          readyState: v.readyState,
          networkState: v.networkState,
          paused: v.paused && !this.startupPending,
          seeking: v.seeking,
        };
      },
      onReload: recovery => {
        log.warn('Reconnecting live stream',
          'event=playback.recovery.reload', this.playbackLabel(),
          `cause=${recovery.cause}`,
          this.recoveryState(recovery));
        this.reloadCurrentStream();
      },
      onEscalate: recovery => {
        const preview = this.livePreviewMode;
        log.error('Live stream recovery exhausted',
          'event=playback.recovery.exhausted', this.playbackLabel(),
          `cause=${recovery.cause}`,
          `outcome=${preview ? 'preview-failed' : 'next-channel'}`,
          this.recoveryState(recovery));
        this.markLiveUnavailable(recovery.cause === 'stall' ? 'stall_exhausted' : 'playback_error');
        if (this.failLivePreview()) return;
        this.osd.updateMessage(t('player.streamError'));
        this.channelUp();
      },
      pollMs: CONFIG.PLAYER.STALL_POLL_MS,
      freezeTicks: CONFIG.PLAYER.STALL_FREEZE_TICKS,
      maxReloads: CONFIG.PLAYER.DEFAULT_LIVE_RECONNECT_ATTEMPTS,
    });
    this.startupWatchdog = new StartupWatchdog({
      probe: (): StartupProbe => {
        const v = this.videoEl;
        if (!v) return { readyState: 0, networkState: 0 };
        return { readyState: v.readyState, networkState: v.networkState };
      },
      onFailure: (failure, probe, elapsedMs) => this.onStartupFailure(failure, probe, elapsedMs),
      pollMs: CONFIG.PLAYER.STARTUP_POLL_MS,
      timeoutMs: CONFIG.PLAYER.STARTUP_TIMEOUT,
    });
  }

  init(videoEl: HTMLVideoElement): void {
    this.videoEl = videoEl;
    this.pendingSeekTarget = null;
    this.pipeline.setVideoElement(videoEl);
    this.bindVideoEvents(videoEl);

    // Suspend/resume playback when the app is actually backgrounded so the
    // native media pipeline (a separate process) stops pulling segments off the
    // network. Drive this off visibilitychange ONLY: a real background (Home /
    // app switch) flips visibilityState to 'hidden', whereas the TV's Quick
    // Settings overlay merely blurs the window — we stay 'visible' behind it.
    // Suspending on blur is what blacked the app out when settings opened, and
    // getForegroundAppInfo (the precise signal) is a privileged Luna method this
    // app isn't allowed to call.
    const onHidden = (src: string) => { log.debug('suspend trigger:', src); this.suspend(); };
    const onVisible = (src: string) => { log.debug('resume trigger:', src); this.resume(); };

    document.addEventListener('visibilitychange', () => {
      log.debug('visibilitychange →', document.visibilityState);
      if (document.hidden) onHidden('visibilitychange'); else onVisible('visibilitychange');
    });
    document.addEventListener('webkitvisibilitychange', () => {
      if ((document as unknown as Record<string, boolean>).webkitHidden) onHidden('webkitvisibilitychange');
      else onVisible('webkitvisibilitychange');
    });
  }

  private bindVideoEvents(el: HTMLVideoElement): void {
    const onCurrent = (type: string, listener: () => void): void => {
      el.addEventListener(type, () => {
        if (el === this.videoEl) listener();
      });
    };
    const update = (status?: LivePlaybackStatus) => {
      if (status && this.liveSessionActive) this.livePlaybackStatus = status;
      this.onPlaybackStateChanged();
    };
    onCurrent('pause', () => update('paused'));
    onCurrent('volumechange', () => {
      if (this.liveSessionActive && !this.vod) this.rememberLiveAudio();
      update();
    });
    onCurrent('error', () => this.onError(el.error?.code === 4 ? 'unsupported' : undefined));
    // Resource selection starts here. Until then readyState/networkState still
    // describe the previous stream — on webOS the content-type probe can defer
    // the attach by up to MANIFEST_TIMEOUT — and recreateVideoEl() loads a
    // sourceless element, which is not a startup attempt.
    onCurrent('loadstart', () => {
      this.vodTracksLatePending = false;
      if (!el.currentSrc && !el.getAttribute('src') && !el.querySelector('source')) return;
      this.startupWatchdog.start();
    });
    onCurrent('loadedmetadata', () => {
      update();
      log.info('loadedmetadata', this.videoLabel(el), el.videoWidth + 'x' + el.videoHeight,
        this.mediaState(el), '| pendingResume:', this.pendingResumeSecs);
      if (this.vod) {
        this.logVodTracks(el);
        this.vodTracksLatePending = true;
      }
      if ((this.vod || this.catchupInfo) && this.pendingResumeSecs > 0 && Number.isFinite(el.duration) && el.duration > 0) {
        const target = Math.min(this.pendingResumeSecs, el.duration - 1);
        log.info('resume seek', this.videoLabel(el), '| requested:', this.pendingResumeSecs,
          '| target:', target, '| duration:', el.duration);
        el.currentTime = target;
        this.pendingResumeSecs = 0;
      }
      this.tracks.applyNativeAudioSelection();
      this.tracks.applyNativeSubtitleSelection();
      if (this.osd.isVisible()) this.osd.render();
    });
    // The watchdog's own success condition — a decoded first frame, whether or
    // not playback was allowed to begin (autoplay can be rejected, or the user
    // can pause while the spinner is up).
    onCurrent('canplay', () => {
    });
    onCurrent('loadeddata', () => {
      this.startupPending = false;
      if (this.catchupInfo) this.catchupVariantConfirmed = true;
    });
    // Intrinsic size changes mid-stream (ABR up/down-switch) so the OSD pills
    // (resolution, and on hls.js the codec/HDR/fps) reflect the live variant.
    onCurrent('resize', () => {
      if (this.osd.isVisible()) this.osd.render();
    });
    // Some platforms populate audio/text tracks asynchronously, after loadedmetadata.
    el.audioTracks?.addEventListener?.('addtrack', () => {
      if (el !== this.videoEl) return;
      this.logLateVodTracks(el, null);
      this.tracks.applyNativeAudioSelection();
      this.tracksChanged();
    });
    el.textTracks?.addEventListener?.('addtrack', (e: TrackEvent) => {
      if (el !== this.videoEl) return;
      const track = e.track as TextTrack | null;
      this.logLateVodTracks(el, track);
      this.tracks.applyNativeSubtitleSelection();
      if (!track || !this.tracks.ownsTextTrack(track)) this.tracksChanged();
    });
    // Any unpause, the pipeline's own play() included, ends the user's pause; a
    // `play` queued before a quick re-pause finds the element paused again.
    onCurrent('play', () => {
      if (!el.paused) this.userPaused = false;
    });
    onCurrent('playing', () => {
      this.startupPending = false;
      const recovered = this.errorRetryPending;
      if (recovered) {
        this.cancelErrorAdvance();
        if (isWebOS()) this.stallWatchdog.resume();
      }
      update('playing');
      if (recovered) this.osd.render();
      log.info('playing', this.videoLabel(el), this.mediaState(el));
      if (this.catchupInfo) this.catchupVariantConfirmed = true;
      this.startupWatchdog.stop();
      this.tracks.reapplyNativeSubtitleCompositor();
      this.markTrackedLiveHealthy();
      this.confirmLiveHistory(el);
      if (this.osd.isVisible()) this.osd.resetTimer();
    });
    onCurrent('waiting', () => {
      update('buffering');
      log.debug('waiting', this.videoLabel(el), this.mediaState(el));
      this.cancelLiveHistoryTimer();
    });
    onCurrent('stalled', () => {
      log.debug('stalled event', this.videoLabel(el), this.mediaState(el));
    });
    onCurrent('timeupdate', () => {
      if (this.liveSessionActive && !this.catchupInfo && !el.paused && !el.seeking) {
        const recovered = this.stallWatchdog.observeProgress(el.currentTime);
        if (recovered && this.errorRetryPending) {
          this.cancelErrorAdvance();
          if (isWebOS()) this.stallWatchdog.resume();
          update('playing');
          this.osd.render();
        }
      }
      this.reconcileLiveDvrPosition(el);
      this.reconcilePendingSeek(el);
      this.refreshProgress();
    });
    onCurrent('progress', () => {
      this.reconcileLiveDvrPosition(el);
    });
    onCurrent('durationchange', () => {
      this.reconcileLiveDvrPosition(el);
    });
    onCurrent('seeked', () => {
      log.info('seeked', this.videoLabel(el), this.mediaState(el));
      this.reconcilePendingSeek(el, true);
      if (this.catchupInfo) this.saveCatchupProgress();
      this.refreshProgress();
    });
    onCurrent('ended', () => {
      if (this.playbackActive) this.onEnded();
    });
  }

  private playbackLabel(load = this.pipeline.currentLoadToken()): string {
    return `session=${String(this.playbackGeneration)} load=${String(load)}`;
  }

  private videoLabel(el: HTMLVideoElement): string {
    return this.pipeline.videoLabel(el);
  }

  private mediaState(el: HTMLVideoElement): string {
    return `t=${el.currentTime.toFixed(3)} duration=${String(el.duration)}` +
      ` ready=${String(el.readyState)} network=${String(el.networkState)}` +
      ` paused=${String(el.paused)} seeking=${String(el.seeking)}`;
  }

  private recoveryState(recovery: StallRecovery): string {
    const p = recovery.probe;
    return `frozen=${String(recovery.frozenMs)}ms reloads=${String(recovery.reloadCount)}` +
      `/${String(recovery.maxReloads)} t=${p.currentTime.toFixed(3)}` +
      ` ready=${String(p.readyState)} network=${String(p.networkState)}` +
      ` paused=${String(p.paused)} seeking=${String(p.seeking)}`;
  }

  suspend(): void {
    this.startupWatchdog.stop();
    if (!this.videoEl || !this.currentChannel) return;
    if (this.wasPlayingBeforeHide) return; // already suspended
    this.wasPlayingBeforeHide = !this.videoEl.paused;
    if (this.wasPlayingBeforeHide) {
      // Save catch-up position and remember it for resume() BEFORE the element is destroyed.
      // Prefer a not-yet-applied resume seek: if we suspend before loadedmetadata
      // seeks to pendingResumeSecs, currentTime is still 0 and would otherwise
      // collapse the resume point to the start on the next play().
      if (this.catchupInfo) {
        this.catchupSuspendPos = Math.max(
          this.videoEl.currentTime,
          this.pendingResumeSecs,
          this.pendingSeekTarget ?? 0,
        );
        this.saveCatchupProgress();
      }
      this.stallWatchdog.stop();
      this.tracks.suspend();
      this.pipeline.destroy();
      this.recreateVideoEl();
    }
  }

  /**
   * Hard-reset playback by swapping in a fresh <video> element. Normal channel
   * changes replace the webOS native pipeline through source + load(), but a
   * wedged or ended pipeline can remain terminal and retain its buffer. A fresh
   * element kills that pipeline and frees it.
   */
  private recreateVideoEl(): void {
    const old = this.videoEl;
    if (!old) return;
    this.userPaused = false;
    old.pause();
    old.removeAttribute('src');
    old.innerHTML = '';
    old.load();
    const fresh = document.createElement('video');
    fresh.id = old.id;
    fresh.autoplay = true;
    fresh.muted = !!old.muted;
    fresh.volume = Number.isFinite(old.volume) ? old.volume : 1;
    this.bindVideoEvents(fresh);
    old.parentNode!.replaceChild(fresh, old);
    this.videoEl = fresh;
    this.pipeline.setVideoElement(fresh);
    this.onPlaybackStateChanged();
  }

  resume(): void {
    if (!this.videoEl) return;
    if (!this.canResumePlayback()) {
      this.stop();
      return;
    }
    // A stream still starting when we were hidden gets a fresh budget. Element
    // state alone can't say that: a seek into an unbuffered region also drops
    // readyState below HAVE_CURRENT_DATA.
    if (this.startupPending && this.videoEl.readyState < 2) this.startupWatchdog.start();
    if (this.vod) {
      this.reauthorizeVod(this.vod, this.videoEl);
      return;
    }
    if (!this.currentChannel) return;
    if (this.wasPlayingBeforeHide) {
      this.wasPlayingBeforeHide = false;
      const channel = this.currentChannel;
      const index = this.currentIndex;
      const catchup = this.catchupInfo || undefined;
      const preview = this.livePreviewMode;
      // Backgrounding relocks parental controls, so a locked channel asks again
      // in full screen; a preview the user didn't start just stops.
      if (!this.authorizeLive(channel, () => this.playResolved(channel, index, catchup), preview, !preview)) {
        log.info('Resume waits for the parental PIN', 'event=parental.playback.relocked',
          'kind=live', `preview=${String(preview)}`, `catchup=${String(!!catchup)}`);
        this.stop();
        if (!preview) this.onBack();
      }
    }
  }

  private reauthorizeVod(v: VodPlayback, el: HTMLVideoElement): void {
    const resumeSecs = this.pendingSeekTarget ?? (el.currentTime || v.resumeSecs);
    const resumed: VodPlayback = { ...v, resumeSecs };
    if (this.authorizeVod(resumed, () => { if (this.vod !== v) this.playVodResolved(resumed); })) return;
    log.info('Resume waits for the parental PIN', 'event=parental.playback.relocked',
      `kind=${v.kind}`);
    this.stop();
    v.onBack();
  }

  // Resolve the playable URL for a channel, applying the catch-up template when
  // a catch-up window is active. Shared by play() and the stall reload path.
  private xtreamCatchupSources(channel: Channel): XtreamCatchupSource[] {
    if (channel.catchupSources?.length) return channel.catchupSources;
    const inferred = xtreamCredentialsFromLiveUrl(channel.url);
    const account = channel.catchupAccountId
      ? StorageService.getPlaylists()
          .find(item => item.id === channel.catchupAccountId && item.source === 'xtream')
      : undefined;
    const credentials = account?.xtream
      ? { baseUrl: account.url, ...account.xtream }
      : inferred?.credentials;
    const streamId = channel.catchupStreamId || inferred?.streamId || '';
    if (credentials && streamId) {
      const output = /\.m3u8(?:[?#]|$)/i.test(channel.catchupSource) ? 'm3u8' : 'ts';
      return buildXtreamCatchupSources(credentials, streamId, output);
    }
    const sources: XtreamCatchupSource[] = [
      { kind: 'path-ts', url: channel.catchupSource },
    ];
    return sources;
  }

  private resolveStreamUrl(channel: Channel, catchup: CatchupInfo | null): string {
    if (catchup && channel.catchupSource) {
      let source = channel.catchup === 'xtream'
        ? this.xtreamCatchupSources(channel)[this.catchupSourceIndex]?.url || channel.catchupSource
        : channel.catchupSource;
      if (channel.catchup === 'xtream') {
        const durationMinutes = Math.max(1, Math.ceil((catchup.end - catchup.start) / 60));
        source = source
          .replace('{duration}', String(durationMinutes))
          .replace('{start}', formatXtreamCatchupStart(
            catchup.start,
            channel.catchupTimeZone,
            channel.catchupTimeOffsetMinutes,
          ));
      }
      return source
        .replace('{channel-id}', encodeURIComponent(channel.id || channel.name))
        .replace('{utc}', String(catchup.start))
        .replace('{utcend}', String(catchup.end));
    }
    return channel.url;
  }

  private startPlaybackGeneration(): void {
    this.cancelLiveHistoryTimer();
    this.cancelErrorAdvance();
    this.playbackGeneration++;
    this.healthStartedAt = Date.now();
    this.liveHistoryGeneration = -1;
  }

  private cancelErrorAdvance(): void {
    if (this.errorAdvanceTimer !== null) {
      clearTimeout(this.errorAdvanceTimer);
      this.errorAdvanceTimer = null;
    }
    this.errorRetryPending = false;
  }

  private cancelLiveHistoryTimer(): void {
    if (this.liveHistoryTimer === null) return;
    clearTimeout(this.liveHistoryTimer);
    this.liveHistoryTimer = null;
  }

  private confirmLiveHistory(el: HTMLVideoElement): void {
    if (el !== this.videoEl || this.vod || this.catchupInfo || !this.currentChannel) return;
    const generation = this.playbackGeneration;
    if (this.liveHistoryGeneration === generation || this.liveHistoryTimer !== null) return;
    const channel = this.currentChannel;
    this.liveHistoryTimer = setTimeout(() => {
      this.liveHistoryTimer = null;
      if (generation !== this.playbackGeneration || el !== this.videoEl || el.paused ||
          this.vod || this.catchupInfo || this.currentChannel !== channel) return;
      StorageService.touchRecentlyWatchedLive(channelKey(channel));
      this.liveHistoryGeneration = generation;
    }, CONFIG.RECENTLY_WATCHED.LIVE_CONFIRM_MS);
  }

  // scope: omit to keep whatever scope is already playing (channelUp/Down's
  // own internal calls do this); pass a ChannelScope to set a new one, or
  // null to explicitly clear it (e.g. a global number-entry jump).
  play(
    channelIndex: number,
    catchup?: CatchupInfo,
    scope?: ChannelScope | null,
    preview = this.livePreviewMode,
  ): void {
    const channel = PlaylistService.getByIndex(channelIndex);
    if (!channel || !this.videoEl) {
      log.warn('play() ignored — no channel or video element', { channelIndex, hasChannel: !!channel });
      return;
    }
    this.authorizeLive(
      channel,
      () => this.playResolved(channel, channelIndex, catchup, scope),
      preview,
    );
  }

  private playResolved(
    channel: Channel,
    channelIndex: number,
    catchup?: CatchupInfo,
    scope?: ChannelScope | null,
  ): void {
    if (!this.videoEl) return;
    if (this.liveSessionActive) this.rememberLiveAudio();
    this.playbackActive = true;
    this.stallWatchdog.stop();
    this.startPlaybackGeneration();

    // Save progress for the outgoing catch-up session (channel switch, stopping catch-up).
    // Skip when resuming from suspend: catchupSuspendPos >= 0 means the element is fresh
    // (currentTime=0) and we already saved the real position in suspend().
    if (this.catchupSuspendPos < 0) this.saveCatchupProgress();

    // Determine resume position: prefer the pre-suspend position if available, else the
    // position requested by the caller (CatchupInfo.resumeSecs). Reset for live channels.
    if (this.catchupSuspendPos >= 0) {
      this.pendingResumeSecs = this.catchupSuspendPos;
      this.catchupSuspendPos = -1;
    } else {
      this.pendingResumeSecs = catchup?.resumeSecs ?? 0;
    }
    this.pendingSeekTarget = null;

    log.info('play index', channelIndex, '|', channel.name, catchup ? '(catchup)' : '');
    this.currentChannel = channel;
    this.currentIndex = channelIndex;
    if (channelIndex >= 0) this.currentIndexAnchor = channelIndex;
    if (scope !== undefined) this.currentScope = scope;
    this.catchupInfo = catchup || null;
    this.liveSessionActive = !catchup;
    this.livePlaybackStatus = 'loading';
    this.onTvPlaybackChanged(channelIndex, catchup ? catchup.start * 1000 : null);
    this.catchupSourceIndex = 0;
    this.catchupVariantConfirmed = false;
    this.vod = null;
    this.videoEl.muted = this.livePreviewMode && this.previewMuteOverride !== null
      ? this.previewMuteOverride
      : this.liveMuted;
    this.videoEl.volume = this.liveVolume;
    this.catchupCheckpointAt = Date.now(); // reset periodic-save timer for the new session
    this.osd.clearFailedIcons();

    const url = this.resolveStreamUrl(channel, catchup || null);
    if (catchup) log.debug('catchup URL:', diagnosticStreamUrl(url));

    this.videoEl.classList.add('active');
    this.onPlaybackStateChanged();
    this.loadStream(url, channel.extras);
    this.picker.hide();
    this.osd.deactivate();
    this.showOSD();
    if (!this.livePreviewMode) show(this.container);
    this.stallWatchdog.start(isWebOS(), StorageService.getLiveReconnectAttempts());
  }

  isVod(): boolean { return this.vod !== null; }

  pickerVisible(): boolean {
    return this.picker.visible;
  }

  /**
   * Back inside the player, before it stops playback: it closes a track
   * picker, then hides the controls. VOD controls always step aside first;
   * live ones when they own the keys or when the user paused, since a paused
   * stream's controls never auto-hide. A reconnect or error message would
   * only re-show, so Back stops right away then.
   */
  handleBack(): boolean {
    if (this.picker.visible) {
      this.picker.hide();
      return true;
    }
    if (!this.osd.isVisible() || this.osd.showsMessage() || this.tracks.isSubtitleSearchOpen()
        || this.upNextTimer !== null) return false;
    const paused = this.userPaused && !!this.videoEl?.paused && !InputMode.keyAfterPointer;
    if (!this.vod && !this.osd.isActive() && !paused) return false;
    // Back skips handleAction, which drops a stale pointer before OK seeks to it.
    // A paused live DVR keeps its tick, so the controls are current when OK
    // shows them again.
    this.osd.clearPointer();
    this.osd.hide();
    return true;
  }

  /** Whether a live channel's controls are on screen (Green toggles its favorite). */
  liveControlsShown(): boolean {
    return !this.vod && this.currentChannel !== null && this.osd.isVisible() && !this.osd.showsMessage();
  }

  /** Whether Left acts inside the player rather than opening the channel list. */
  claimsLeft(): boolean {
    return this.picker.visible || this.osd.isActive() || this.canSeek();
  }

  // `audio=none` means the engine lacks the audioTracks API, unlike an empty
  // list; under MSE the element's audioTracks don't describe the stream.
  private logVodTracks(el: HTMLVideoElement, phase?: 'late'): void {
    log.info('VOD tracks', 'event=vod.tracks', ...(phase ? [`phase=${phase}`] : []),
      `audio=${el.audioTracks ? el.audioTracks.length : 'none'}`,
      `text=${this.tracks.nativeTextTrackCount(el.textTracks)}`,
      `mse=${this.pipeline.isMseActive() ? 1 : 0}`);
  }

  // Tracks can arrive after loadedmetadata; report the first such add once per load.
  private logLateVodTracks(el: HTMLVideoElement, track: TextTrack | null): void {
    if (!this.vod || !this.vodTracksLatePending) return;
    if (track && this.tracks.ownsTextTrack(track)) return;
    this.vodTracksLatePending = false;
    this.logVodTracks(el, 'late');
  }

  playVod(v: VodPlayback): void {
    this.authorizeVod(v, () => this.playVodResolved(v));
  }

  private playVodResolved(v: VodPlayback): void {
    if (this.liveSessionActive) this.rememberLiveAudio();
    this.playbackActive = true;
    this.livePreviewMode = false;
    this.restoreLiveMute();
    this.liveSessionActive = false;
    this.stallWatchdog.stop();
    if (!this.videoEl) { log.warn('playVod ignored — no video element'); return; }
    this.startPlaybackGeneration();
    log.info('playVod', v.title, '| resume', v.resumeSecs);
    this.saveCatchupProgress(); // save any active catch-up before switching to VOD
    this.currentChannel = null;
    this.currentIndex = -1;
    this.currentScope = null;
    this.catchupInfo = null;
    this.vod = v;
    this.pendingResumeSecs = v.resumeSecs > 0 ? v.resumeSecs : 0;
    this.pendingSeekTarget = null;
    this.osd.clearFailedIcons();
    this.videoEl.classList.add('active');
    this.loadStream(v.url, null, { direct: true });
    this.tracks.attachVod(v);
    // Read codec/fps/HDR from the container header — the video element can't
    // expose them on webOS. Fires once, off the playback path; re-renders the OSD
    // when it resolves. Guarded so a stale probe can't clobber a newer VOD.
    this.vodInfo = null;
    void probeMedia(v.url, `${v.accountId}|media_probe|${v.kind}|${v.itemId}`).then((info) => {
      if (this.vod !== v || !info) return;
      this.vodInfo = info;
      if (this.osd.isVisible()) this.osd.render();
    });
    this.showOSD();
    show(this.container);
  }

  private tracksChanged(): void {
    if (this.osd.isVisible()) this.osd.render();
    this.picker.refresh();
  }

  private saveVodResume(): void {
    const v = this.vod;
    const el = this.videoEl;
    if (!v || !el) return;
    const dur = Number.isFinite(el.duration) ? el.duration : 0;
    if (dur <= 0) return; // metadata not loaded yet — currentTime is 0/unknown; don't clobber the stored point
    StorageService.setResume({
      accountId: v.accountId, kind: v.kind, itemId: v.itemId,
      name: v.title, poster: v.poster, ext: extFromUrl(v.url),
      position: this.pendingSeekTarget ?? (el.currentTime || 0),
      duration: dur,
      updatedAt: Date.now(),
      episodeQueue: v.episodeQueue,
      previousEpisodes: v.previousEpisodes,
      watchlistOwner: v.watchlistOwner,
      categoryId: v.categoryId,
    });
  }

  private saveCatchupProgress(opts?: { completed?: boolean }): void {
    const info = this.catchupInfo;
    const ch = this.currentChannel;
    if (!info || !ch || !ch.catchupSource) return;
    const el = this.videoEl;
    const pos = this.pendingSeekTarget ?? (el ? (el.currentTime || 0) : 0);
    const progStartMs = info.start * 1000;
    const progEndMs = info.end * 1000;
    const epgDur = info.end - info.start; // seconds, as fallback when media duration unknown
    const dur = el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : epgDur;
    const isCompleted = (opts?.completed ?? false) || (dur > 0 && pos >= dur - CONFIG.CATCHUP.FINISH_PAD);
    // Avoid writing a sub-threshold position that would delete a valid stored entry.
    if (!isCompleted && pos < CONFIG.CATCHUP.RESUME_MIN_SECS) return;
    StorageService.setCatchupProgress({
      channelKey: channelKey(ch),
      progStart: progStartMs,
      progEnd: progEndMs,
      epgSourceUrl: info.epgSourceUrl,
      title: info.title,
      description: info.description,
      icon: info.icon,
      position: pos,
      duration: dur,
      updatedAt: Date.now(),
      completed: isCompleted,
    }, ch.catchupDays);
  }

  private handleVodAction(action: Action): void {
    if (this.tracks.handleAction(action)) return;
    if (this.upNextTimer) {
      if (action === 'select' || action === 'play') this.playNextItem();
      else if (action === 'back' || action === 'stop') this.cancelNextItem();
      return;
    }
    const onControls = this.osd.isActive() && this.osd.focused() !== 'seek';
    switch (action) {
      case 'back':
      case 'stop': {
        const back = this.vod?.onBack;
        this.stop();       // saves the resume point, clears VOD state
        back?.();
        break;
      }
      case 'select':
        {
          const pointer = this.osd.pointerPosition();
          if (this.osd.seekAtPointer(pointer.x, pointer.y)) break;
        }
        if (onControls) this.osd.activateFocused();
        else this.pauseToggle();
        break;
      case 'left':
      case 'right':
        // Left/Right skip, with the controls hidden too, unless focus is on
        // the controls' buttons, where they move between them.
        if (onControls) this.osd.move(action);
        else this.seekKey(action === 'left' ? -1 : 1);
        break;
      case 'rewind':
      case 'fast_forward':
        this.seekKey(action === 'rewind' ? -1 : 1);
        break;
      case 'up':
      case 'down':
        // Show the controls without pausing; once up, Down steps into the
        // buttons and Up back to the bar.
        if (!this.osd.isActive()) this.showOSD();
        else this.osd.move(action);
        break;
      case 'play':
        if (this.videoEl?.paused) this.pauseToggle();
        break;
      case 'pause':
        if (this.videoEl && !this.videoEl.paused) this.pauseToggle();
        break;
      case 'yellow':
        this.showOSD();
        break;
      default:
        break; // channel_up/channel_down are no-ops (no channels in VOD)
    }
  }

  closeSubtitleSearch(): void {
    this.tracks.closeSubtitleSearch();
  }

  openSubtitleSearch(): void {
    void this.tracks.openSubtitleSearch();
  }

  openSubtitleOffset(): void {
    this.tracks.openSubtitleOffset();
  }

  closeSubtitleOffset(): void {
    this.tracks.closeSubtitleOffset();
  }

  setSubtitleOffset(seconds: number): void {
    this.tracks.setSubtitleOffset(seconds);
  }

  // Stall watchdog recovery: swap in a fresh <video> (kills the wedged native
  // pipeline) and reload the current channel WITHOUT going through play() — that
  // would reset the watchdog's reload budget and prevent escalation.
  private reloadCurrentStream(): void {
    if (!this.currentChannel) return;
    this.osd.updateMessage(t('player.reconnecting'));
    this.recreateVideoEl();
    this.videoEl?.classList.add('active');
    this.loadStream(
      this.resolveStreamUrl(this.currentChannel, this.catchupInfo),
      this.currentChannel.extras,
    );
  }

  // A finished catch-up VOD would otherwise freeze on its last frame; fall back
  // to the channel's live stream instead.
  private onEnded(): void {
    if (this.vod) {
      const v = this.vod;
      this.vod = null; // before stop(), so it doesn't re-save a resume point for a finished movie
      StorageService.clearResume(v.accountId, v.kind, v.itemId);
      StorageService.markWatched(v.accountId, v.kind, v.itemId);
      if (v.kind === 'vod') {
        StorageService.removeWatchlist(v.accountId, 'vod', v.itemId);
      } else if ((v.episodeQueue?.length ?? 0) === 0 && v.watchlistOwner) {
        StorageService.removeWatchlist(v.accountId, v.watchlistOwner.kind, v.watchlistOwner.itemId);
      }
      this.stop();
      const queue = v.kind === 'episode' ? v.episodeQueue : v.watchlistQueue;
      const next = queue?.[0];
      if (next) {
        this.startNextItem(next, queue?.slice(1) ?? [], v.kind === 'episode', v.onBack, v);
        return;
      }
      v.onBack();
      return;
    }
    if (this.catchupInfo && this.currentChannel) {
      log.info('catch-up ended — resuming live');
      this.saveCatchupProgress({ completed: true });
      const idx = this.currentIndex;
      const channel = this.currentChannel;
      this.catchupInfo = null; // clear before play() so it doesn't re-save with pos=0
      this.recreateVideoEl();
      this.playResolved(channel, idx);
    }
  }

  stop(): void {
    if (this.liveSessionActive) this.rememberLiveAudio();
    this.liveSessionActive = false;
    this.livePreviewMode = false;
    this.restoreLiveMute();
    this.playbackActive = false;
    this.wasPlayingBeforeHide = false;
    this.userPaused = false;
    this.startPlaybackGeneration();
    this.clearUpNextTimer();
    this.vodTracksLatePending = false;
    this.picker.hide();
    if (this.vod) this.saveVodResume();
    this.saveCatchupProgress(); // save before the video element is torn down
    this.stallWatchdog.stop();
    this.startupPending = false;
    this.startupWatchdog.stop();
    this.tracks.stop();
    this.pipeline.destroy();
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.removeAttribute('src');
      this.videoEl.innerHTML = '';
      this.videoEl.load();
      this.videoEl.classList.remove('active');
    }
    this.hideOSD();
    hide(this.container);
    this.vod = null;
    this.pendingResumeSecs = 0;
    this.pendingSeekTarget = null;
    this.catchupCheckpointAt = 0;
    this.catchupSuspendPos = -1;
    this.catchupSourceIndex = 0;
    this.catchupVariantConfirmed = false;
    this.clearSeekBubble();
    this.seekHold = null;
    this.onPlaybackStateChanged();
  }

  private startNextItem(
    next: VodQueueItem,
    remaining: VodQueueItem[],
    isEpisodeQueue: boolean,
    onBack: () => void,
    finished: VodPlayback,
  ): void {
    this.recreateVideoEl();
    // The PIN unlocked the whole series, so its next episode continues.
    this.upNextAuthorized = isEpisodeQueue && sameParentalItem(finished, next);
    this.vod = {
      ...next,
      resumeSecs: 0,
      episodeQueue: isEpisodeQueue ? remaining : undefined,
      previousEpisodes: isEpisodeQueue
        ? (finished.previousEpisodes ?? []).concat(queueItem(finished))
        : undefined,
      watchlistQueue: isEpisodeQueue ? undefined : remaining,
      onBack,
    };
    this.upNextSeconds = CONFIG.PLAYER.UP_NEXT_COUNTDOWN;
    this.osd.show();
    show(this.container);
    this.upNextTimer = setInterval(() => {
      this.upNextSeconds--;
      if (this.upNextSeconds <= 0) this.playNextItem();
      else this.osd.render();
    }, 1000);
  }

  private clearUpNextTimer(): void {
    this.upNextAuthorized = false;
    if (this.upNextTimer) clearInterval(this.upNextTimer);
    this.upNextTimer = null;
    this.upNextSeconds = 0;
  }

  private playNextItem(): void {
    const next = this.vod;
    if (!next || !this.upNextTimer) return;
    const authorized = this.upNextAuthorized;
    log.debug('Up next starting', 'event=parental.upnext', `kind=${next.kind}`,
      `sameItem=${String(authorized)}`);
    this.clearUpNextTimer();
    if (authorized) {
      this.playVodResolved(next);
      return;
    }
    // A locked next item waits for the PIN off the player, as a live resume
    // does, so cancelling the prompt can't strand a blank up-next screen.
    if (!this.authorizeVod(next, () => this.playVodResolved(next))) this.cancelNextItem();
  }

  private cancelNextItem(): void {
    const back = this.vod?.onBack;
    this.stop();
    back?.();
  }

  private hasPreviousEpisode(): boolean {
    return this.vod?.kind === 'episode' && (this.vod.previousEpisodes?.length ?? 0) > 0;
  }

  private hasNextEpisode(): boolean {
    return this.vod?.kind === 'episode' && (this.vod.episodeQueue?.length ?? 0) > 0;
  }

  /** Previous restarts the episode; near its start it plays the one before. */
  private previousEpisode(): void {
    const v = this.vod;
    const before = v?.previousEpisodes;
    if (!v || !before?.length || !this.hasPreviousEpisode()) return;
    const position = this.pendingSeekTarget ?? this.videoEl?.currentTime ?? 0;
    if (position >= CONFIG.PLAYER.PREVIOUS_EPISODE_WINDOW) {
      this.seekTo(0);
      return;
    }
    this.switchEpisode(before[before.length - 1], {
      previousEpisodes: before.slice(0, -1),
      episodeQueue: [queueItem(v)].concat(v.episodeQueue ?? []),
    });
  }

  private nextEpisode(): void {
    const v = this.vod;
    const queue = v?.episodeQueue;
    if (!v || !queue?.length || !this.hasNextEpisode()) return;
    this.switchEpisode(queue[0], {
      previousEpisodes: (v.previousEpisodes ?? []).concat(queueItem(v)),
      episodeQueue: queue.slice(1),
    });
  }

  // Leave this episode for another of the series at once, as Up Next does
  // when it counts down: the resume point of the one left is saved.
  private switchEpisode(
    target: VodQueueItem,
    lists: Pick<VodPlayback, 'previousEpisodes' | 'episodeQueue'>,
  ): void {
    const current = this.vod;
    if (!current) return;
    const next: VodPlayback = { ...target, resumeSecs: 0, ...lists, onBack: current.onBack };
    log.info('Episode switch', 'event=vod.episode.switch', `sameItem=${String(sameParentalItem(current, target))}`);
    this.stop();
    this.recreateVideoEl();
    if (sameParentalItem(current, target)) {
      this.playVodResolved(next);
      return;
    }
    if (!this.authorizeVod(next, () => this.playVodResolved(next))) current.onBack();
  }

  private loadStream(url: string, extras: Record<string, string> | null, opts?: { direct?: boolean }): void {
    this.tracks.resetForLoad();
    this.vodTracksLatePending = false;
    this.manifestVariants = [];
    this.userPaused = false;
    this.startupPending = true;
    this.startupWatchdog.stop();
    this.pipeline.load(url, extras, opts);
  }

  /**
   * A stream that never produced a frame. `unsupported` means the element
   * rejected every source it was offered — a reload would re-offer the same one,
   * so surface it. A `timeout` on live/catch-up belongs to the stall watchdog,
   * whose in-place reload can still recover a transient failure; record it and
   * leave that recovery alone.
   */
  private onStartupFailure(
    failure: StartupFailure,
    probe: StartupProbe,
    elapsedMs: number,
  ): void {
    const v = this.videoEl;
    const source = v?.querySelector('source');
    const declaredType = source?.getAttribute('type') ?? '';
    // A source rejected on its declared type never becomes currentSrc.
    const url = v?.currentSrc || source?.getAttribute('src') ||
      this.vod?.url || this.currentChannel?.url || '';
    const deferred = failure === 'timeout' && !this.vod;
    const detail = [
      `reason=${failure}`,
      `handled=${deferred ? 'deferred' : 'error'}`,
      `elapsedMs=${String(elapsedMs)}`,
      `ready=${String(probe.readyState)}`,
      `network=${String(probe.networkState)}`,
      `type=${declaredType || '(none)'}`,
      `extension=${extFromUrl(url) || '(none)'}`,
      `canPlayType=${declaredType && v ? v.canPlayType(declaredType) || '(rejected)' : 'n/a'}`,
      `url=${diagnosticStreamUrl(url)}`,
    ];
    if (deferred) {
      log.warn('Stream produced no frame', 'event=playback.startup.failed',
        this.playbackLabel(), ...detail);
      return;
    }
    log.error('Stream never started', 'event=playback.startup.failed',
      this.playbackLabel(), ...detail);
    this.startupPending = false;
    this.onError('unsupported');
  }

  private applyPipelineManifest(manifest: PipelineManifest): void {
    this.manifestVariants = manifest.variants;
    this.tracks.applyManifest(manifest);
    // The manifest names the tracks the native path offers: the controls
    // gain Audio or Subtitles once there is a choice.
    this.tracksChanged();
  }

  private onError(reason?: 'unsupported'): void {
    if (!this.playbackActive || this.wasPlayingBeforeHide) return;
    if (this.errorAdvanceTimer !== null) return;
    if (this.liveSessionActive) {
      this.livePlaybackStatus = 'error';
      this.onPlaybackStateChanged();
    }
    this.cancelLiveHistoryTimer();
    if (this.vod) {
      const v = this.vod;
      this.vod = null;            // so stop() won't overwrite/wipe the resume point on error
      log.warn('VOD playback error', 'event=playback.vod.error',
        this.playbackLabel(), v.title);
      this.stop();
      showToast(t('player.unableToPlay'));
      v.onBack();
      return;
    }
    if (this.catchupInfo && this.currentChannel?.catchup === 'xtream' &&
        !this.catchupVariantConfirmed) {
      const sources = this.xtreamCatchupSources(this.currentChannel);
      const nextIndex = this.catchupSourceIndex + 1;
      if (nextIndex < sources.length) {
        const position = this.videoEl?.currentTime ?? 0;
        if (position > 0) this.pendingResumeSecs = Math.max(this.pendingResumeSecs, position);
        this.catchupSourceIndex = nextIndex;
        this.catchupVariantConfirmed = false;
        log.warn('Xtream catch-up failed; trying the next endpoint',
          'event=xtream.catchup.variant.attempted',
          `variant=${sources[nextIndex].kind}`,
          `attempt=${nextIndex + 1}`,
          `total=${sources.length}`,
          this.playbackLabel());
        this.osd.updateMessage(t('player.retryingCatchup'));
        this.recreateVideoEl();
        this.videoEl?.classList.add('active');
        this.loadStream(
          this.resolveStreamUrl(this.currentChannel, this.catchupInfo),
          this.currentChannel.extras,
        );
        return;
      }
      const current = sources[this.catchupSourceIndex];
      log.warn(
        'Xtream catch-up endpoint variants exhausted',
        'event=xtream.catchup.variant.failed',
        `variant=${current?.kind || 'unknown'}`,
        `attempt=${this.catchupSourceIndex + 1}`,
        `total=${sources.length}`,
        this.playbackLabel(),
      );
    }
    const v = this.videoEl;
    log.error('Video playback error', 'event=playback.video.error',
      this.playbackLabel(),
      v ? this.mediaState(v) : 'no video element',
      v?.error ? { code: v.error.code, message: v.error.message } : 'no error info',
      '| channel:', this.currentChannel?.name,
      '| url:', diagnosticStreamUrl(v?.currentSrc || this.currentChannel?.url || ''));
    if (this.liveSessionActive && !this.catchupInfo && reason !== 'unsupported') {
      this.stallWatchdog.pause();
      this.errorRetryPending = true;
      this.livePlaybackStatus = 'buffering';
      this.onPlaybackStateChanged();
      this.osd.updateMessage(t('player.reconnecting'));
      this.errorAdvanceTimer = setTimeout(() => {
        this.errorAdvanceTimer = null;
        this.errorRetryPending = false;
        if (this.stallWatchdog.recoverFromError() && isWebOS()) {
          this.stallWatchdog.resume();
        }
      }, 2000);
      return;
    }
    this.stallWatchdog.stop();
    this.markLiveUnavailable('playback_error');
    if (this.failLivePreview()) return;
    this.osd.updateMessage(t('player.streamError'));
    this.errorAdvanceTimer = setTimeout(() => {
      this.errorAdvanceTimer = null;
      if (!this.failLivePreview()) this.channelUp();
    }, 2000);
  }

  // Live's preview follows the focused row, so a dead channel shows its
  // failure there; moving on to the next channel would leave focus behind.
  private failLivePreview(): boolean {
    if (!this.livePreviewMode || !this.liveSessionActive) return false;
    this.stallWatchdog.stop();
    this.livePlaybackStatus = 'error';
    this.onPlaybackStateChanged();
    return true;
  }

  private markLiveUnavailable(reason: string): void {
    if (!this.currentChannel || this.catchupInfo || this.vod) return;
    void ChannelHealthService.recordPlaybackFailure(this.currentChannel, reason)
      .then(() => this.onChannelHealthChanged())
      .catch(err => log.error(
        'Channel health playback update failed',
        'event=channel.health.playback.write.failed',
        err,
      ));
  }

  private markTrackedLiveHealthy(): void {
    if (!this.currentChannel || this.catchupInfo || this.vod
        || this.healthSuccessGeneration === this.playbackGeneration) return;
    this.healthSuccessGeneration = this.playbackGeneration;
    const latencyMs = Math.max(0, Date.now() - this.healthStartedAt);
    void ChannelHealthService.recordPlaybackSuccess(this.currentChannel, latencyMs)
      .then(changed => {
        if (changed) this.onChannelHealthChanged();
      })
      .catch(err => log.error(
        'Channel health playback update failed',
        'event=channel.health.playback.write.failed',
        err,
      ));
  }

  showOSD(): void {
    if (this.livePreviewMode) return;
    this.osd.show();
  }

  getVideoElement(): HTMLVideoElement | null { return this.videoEl; }

  isInLivePreview(): boolean { return this.livePreviewMode; }

  enterLivePreview(): void {
    if (this.livePreviewMode) return;
    if (this.liveSessionActive) this.rememberLiveAudio();
    this.previewMuteOverride = null;
    this.livePreviewMode = true;
    this.hideOSD();
    hide(this.container);
    const win = this.liveDvrWindow();
    if (win && !dvrState(
      win, this.videoEl?.currentTime ?? win.end, CONFIG.PLAYER.DVR_LIVE_EDGE,
    ).atLiveEdge) {
      this.seekTo(win.end, false);
    }
  }

  exitLivePreview(): void {
    if (!this.livePreviewMode) return;
    this.livePreviewMode = false;
    this.restoreLiveMute();
  }

  getLivePlaybackSnapshot(): LivePlaybackSnapshot | null {
    if (!this.liveSessionActive || !this.currentChannel || !this.videoEl || this.vod || this.catchupInfo) return null;
    return {
      channel: this.currentChannel,
      muted: this.videoEl.muted,
      status: this.livePlaybackStatus,
    };
  }

  private rememberLiveAudio(): void {
    if (!this.videoEl) return;
    if (this.livePreviewMode) this.previewMuteOverride = !!this.videoEl.muted;
    else this.liveMuted = !!this.videoEl.muted;
    this.liveVolume = Number.isFinite(this.videoEl.volume) ? this.videoEl.volume : 1;
  }

  private restoreLiveMute(): void {
    this.previewMuteOverride = null;
    if (this.videoEl) this.videoEl.muted = this.liveMuted;
  }

  /** The live DVR window (seekable timeshift) when playing live with a usable
   *  retained window; null for catch-up VOD or a non-DVR live stream. */
  private liveDvrWindow(): DvrWindow | null {
    const v = this.videoEl;
    if (!v || this.catchupInfo) return null;
    return dvrWindow(v.seekable, v.duration, CONFIG.PLAYER.DVR_MIN_WINDOW);
  }

  isLiveDvr(): boolean {
    return !!this.liveDvrWindow();
  }

  /** Whether the stream has a seekable range: VOD, catch-up, or live DVR. */
  private seekable(): boolean {
    const v = this.videoEl;
    if (!v) return false;
    if (this.vod || this.catchupInfo) return Number.isFinite(v.duration) && v.duration > 0;
    return this.isLiveDvr();
  }

  /** Seekable while the OSD (the seek UI) shows. */
  canSeek(): boolean {
    return this.osd.isVisible() && this.seekable();
  }

  seekBy(seconds: number): void {
    this.seekTo((this.pendingSeekTarget ?? this.videoEl?.currentTime ?? 0) + seconds);
  }

  /**
   * One Left/Right skip. A held key repeats: it skips SEEK_STEP for the first
   * SEEK_HOLD_MEDIUM_MS, then larger steps, at most once per
   * SEEK_HOLD_REPEAT_MS. A fresh press always skips SEEK_STEP. Playing or
   * paused stays as it was.
   */
  private seekKey(direction: 1 | -1): void {
    if (!this.seekable()) {
      this.showOSD();
      return;
    }
    const P = CONFIG.PLAYER;
    const now = Date.now();
    const hold = this.seekHold;
    let step: number = P.SEEK_STEP;
    if (InputMode.keyRepeat && hold && hold.direction === direction) {
      if (now - hold.steppedAt < P.SEEK_HOLD_REPEAT_MS) return;
      const held = now - hold.startedAt;
      step = held >= P.SEEK_HOLD_FAST_MS ? P.SEEK_HOLD_FAST_STEP
        : held >= P.SEEK_HOLD_MEDIUM_MS ? P.SEEK_HOLD_MEDIUM_STEP : P.SEEK_STEP;
      hold.steppedAt = now;
    } else {
      this.seekHold = { direction, startedAt: now, steppedAt: now };
    }
    const before = this.pendingSeekTarget ?? this.videoEl?.currentTime ?? 0;
    this.seekBy(direction * step);
    const after = this.pendingSeekTarget ?? before;
    this.seekDelta = (this.seekDelta ?? 0) + after - before;
    if (this.seekBubbleTimer) clearTimeout(this.seekBubbleTimer);
    this.seekBubbleTimer = setTimeout(() => {
      this.clearSeekBubble();
      if (this.osd.isVisible()) this.osd.render();
    }, P.SEEK_BUBBLE_MS);
    if (this.osd.isVisible()) this.osd.render();
  }

  private clearSeekBubble(): void {
    if (this.seekBubbleTimer) clearTimeout(this.seekBubbleTimer);
    this.seekBubbleTimer = null;
    this.seekDelta = null;
  }

  /** Seek to a fraction (0..1) of the seekable range (DVR window or VOD duration). */
  private seekToFraction(fraction: number): void {
    const v = this.videoEl;
    if (!v) return;
    const f = Math.max(0, Math.min(1, fraction));
    const win = this.liveDvrWindow();
    if (win) this.seekTo(win.start + f * win.length);
    else if (Number.isFinite(v.duration)) this.seekTo(f * v.duration);
  }

  private seekTo(time: number, showControls = true): void {
    const v = this.videoEl;
    if (!v) return;
    const win = this.liveDvrWindow();
    if (win) {
      // Live DVR: seeking near the end snaps to the live edge (a small pad back
      // so playback does not stall at the tip), while rewinding stays inside
      // the oldest edge of the sliding manifest.
      const liveEdge = win.end - CONFIG.PLAYER.DVR_GO_LIVE_PAD;
      const oldest = this.oldestDvrTarget(win);
      this.pendingSeekTarget = time >= liveEdge ? liveEdge : Math.max(oldest, time);
    } else if (Number.isFinite(v.duration) && v.duration > 0) {
      this.pendingSeekTarget = Math.max(0, Math.min(v.duration, time));
    } else {
      return;
    }
    v.currentTime = this.pendingSeekTarget;
    if (showControls) {
      if (this.osd.isVisible()) this.osd.resetTimer(); else this.showOSD();
    }
    this.refreshProgress();
  }

  private reconcilePendingSeek(el: HTMLVideoElement, retry = false): void {
    if (el !== this.videoEl || this.pendingSeekTarget === null) return;
    if (Math.abs(el.currentTime - this.pendingSeekTarget) <= 1) {
      this.pendingSeekTarget = null;
    } else if (retry) {
      // webOS may discard currentTime assignments made while an earlier seek is
      // active. Re-submit the accumulated target once that seek completes.
      el.currentTime = this.pendingSeekTarget;
    }
  }

  private oldestDvrTarget(win: DvrWindow): number {
    const liveEdge = win.end - CONFIG.PLAYER.DVR_GO_LIVE_PAD;
    return Math.min(liveEdge, win.start + Math.min(
      CONFIG.PLAYER.DVR_OLDEST_PAD,
      win.length / 2,
    ));
  }

  private reconcileLiveDvrPosition(el: HTMLVideoElement): void {
    if (el !== this.videoEl || el.paused || el.seeking) return;
    const win = this.liveDvrWindow();
    if (!win || el.currentTime >= win.start) return;
    const target = this.oldestDvrTarget(win);
    this.pendingSeekTarget = target;
    el.currentTime = target;
  }

  private goToLive(): void {
    const win = this.liveDvrWindow();
    if (win) this.seekTo(win.end);
  }

  private goToOldest(): void {
    const win = this.liveDvrWindow();
    if (win) this.seekTo(this.oldestDvrTarget(win));
  }

  /** Pause/resume. On live DVR, if the retained window rolled past the paused
   *  point, resume from the oldest available point rather than a dropped segment. */
  private pauseToggle(): void {
    const v = this.videoEl;
    if (!v) return;
    if (v.paused) {
      const win = this.liveDvrWindow();
      if (win && v.currentTime < win.start) {
        v.currentTime = this.oldestDvrTarget(win);
      }
      this.userPaused = false;
      v.play?.().catch(() => {});
      this.stopDvrPauseTick();
    } else {
      this.userPaused = true;
      v.pause?.();
      if (this.catchupInfo) this.saveCatchupProgress();
      if (this.isLiveDvr()) this.startDvrPauseTick();
    }
    if (this.osd.isVisible()) {
      this.osd.render();
      this.osd.resetTimer();
    } else {
      this.showOSD();
    }
  }

  // While paused on live DVR the window keeps rolling forward, so tick the OSD
  // to keep "behind live" and the cursor accurate (timeupdate is silent paused).
  private startDvrPauseTick(): void {
    this.stopDvrPauseTick();
    this.dvrPauseTick = setInterval(() => {
      if (!this.videoEl?.paused || !this.isLiveDvr()) this.stopDvrPauseTick();
      else if (this.osd.isVisible()) this.refreshProgress();
    }, 1000);
  }

  private stopDvrPauseTick(): void {
    if (this.dvrPauseTick) { clearInterval(this.dvrPauseTick); this.dvrPauseTick = null; }
  }

  /** Live-update the bar + labels in place (on timeupdate / after a seek). */
  private refreshProgress(): void {
    const v = this.videoEl;
    if (!v) return;
    // Throttled periodic catch-up checkpoint — runs regardless of OSD visibility
    // so progress is saved even when the OSD has auto-hidden.
    if (this.catchupInfo) {
      const now = Date.now();
      if (now - this.catchupCheckpointAt >= CONFIG.CATCHUP.CHECKPOINT_INTERVAL) {
        this.catchupCheckpointAt = now;
        this.saveCatchupProgress();
      }
    }
    this.osd.refreshProgress();
  }

  hideOSD(): void {
    this.picker.hide();
    this.osd.hide();
    this.stopDvrPauseTick();
  }

  // Resolution comes from the video element; other fields use the active MSE
  // rendition, native manifest metadata or the VOD container probe.
  private streamInfo(): PlayerOsdStreamInfo | null {
    const v = this.videoEl;
    const lvl = this.pipeline.streamInfo();
    const info = this.vod ? this.vodInfo : null; // container-header readout for VOD; null on the Live path
    const badge = resolutionBadge((v ? v.videoHeight : 0) || info?.height || 0);
    const variant = !this.pipeline.isMseActive() && v
      ? pickVariant(this.manifestVariants, v.videoWidth, v.videoHeight)
      : null;
    const vCodec = codecName(lvl?.videoCodec ?? variant?.videoCodec ?? info?.videoCodec ?? '');
    const aCodecName = codecName(lvl?.audioCodec ?? variant?.audioCodec ?? info?.audioCodec ?? '');
    // Atmos (JOC): native path from the manifest variant's audio group; hls.js from
    // the active audio track's channel layout — loadLevelObj carries no channels.
    const hlsChannels = lvl?.audioChannels ?? '';
    const atmos = lvl?.audioAtmos ?? (variant?.atmos || /\bJOC\b/i.test(hlsChannels));
    const aCodec = aCodecName && atmos ? `${aCodecName} Atmos` : aCodecName;
    const hdr = hdrLabel(lvl?.videoRange ?? variant?.videoRange ?? info?.hdr ?? '');
    const fps = frameRateLabel(lvl?.frameRate ?? variant?.frameRate ?? info?.fps ?? 0);
    const drm = this.pipeline.drmLabel();
    const audio = audioSummary(this.tracks.getAudioTracks());
    const subtitle = subtitleSummary(this.tracks.getSubtitleTracks());
    if (!(badge || hdr || drm || fps || vCodec || aCodec || audio || subtitle)) return null;
    return {
      resolution: badge,
      hdr,
      drm,
      fps,
      videoCodec: vCodec,
      audioCodec: aCodec,
      audio,
      subtitle,
    };
  }

  private osdSnapshot(): PlayerOsdSnapshot {
    const channel = this.currentChannel;
    const epgId = channel && !this.catchupInfo ? EpgService.findChannelId(channel) : null;
    const upcoming = epgId ? EpgService.getUpcoming(epgId, 3) : [];
    const win = this.liveDvrWindow();
    const video = this.videoEl;
    const position = this.pendingSeekTarget ?? video?.currentTime ?? 0;
    return {
      playback: video ? {
        position,
        duration: video.duration,
        paused: video.paused,
      } : null,
      channel,
      channelNumber: this.currentIndexAnchor + 1,
      catchup: this.catchupInfo,
      vodTitle: this.vod?.title ?? null,
      upNextSeconds: this.upNextSeconds,
      dvr: win && video
        ? dvrState(win, position, CONFIG.PLAYER.DVR_LIVE_EDGE)
        : null,
      nowPlaying: epgId ? EpgService.getNowPlaying(epgId) : null,
      upcoming,
      streamInfo: this.streamInfo(),
      controls: this.dockControls(),
      seek: this.seekDelta === null ? null : { delta: this.seekDelta },
    };
  }

  // The controls the dock offers. Audio needs a real choice (two tracks);
  // Subtitles a track to turn on or the online search to find one, the same
  // rule the subtitle picker lists rows by.
  private dockControls(): PlayerOsdControls {
    const channel = this.currentChannel;
    const live = !this.vod && channel !== null;
    return {
      episodes: this.vod?.kind === 'episode'
        ? { previous: this.hasPreviousEpisode(), next: this.hasNextEpisode() }
        : null,
      favorite: live && channel ? this.liveControls.isFavorite(channel) : null,
      pausable: this.vod !== null || this.catchupInfo !== null || this.isLiveDvr(),
      audio: this.tracks.getAudioTracks().length >= 2,
      subtitles: this.tracks.getSubtitleTracks().length >= 1 || this.tracks.subtitleSearchAvailable(),
    };
  }

  private onDockControl(control: Exclude<DockControl, 'seek' | 'info'>): void {
    switch (control) {
      case 'playpause':
        this.pauseToggle();
        break;
      case 'previous':
        this.previousEpisode();
        break;
      case 'next':
        this.nextEpisode();
        break;
      case 'favorite':
        if (this.currentChannel) this.liveControls.toggleFavorite(this.currentChannel);
        if (this.osd.isVisible()) this.osd.render();
        break;
      case 'audio':
      case 'subtitles':
        this.picker.open(control);
        break;
    }
  }

  channelUp(): void {
    if (this.shouldUseScope()) { this.scopedChannelStep(1); return; }
    this.globalChannelStep(1);
  }

  channelDown(): void {
    if (this.shouldUseScope()) { this.scopedChannelStep(-1); return; }
    this.globalChannelStep(-1);
  }

  // The settings.channelCycleMode gate: scoping applies in 'active' (the
  // default); 'global' keeps the full list even though currentScope is
  // still tracked.
  private shouldUseScope(): boolean {
    return !!this.currentScope && StorageService.getChannelCycleMode() === 'active';
  }

  private globalChannelStep(delta: 1 | -1): void {
    const channels = PlaylistService.channels;
    const len = channels.length;
    if (!len) return;
    let next = this.currentIndex >= 0
      ? ((this.currentIndex + delta) % len + len) % len
      : delta > 0
        ? Math.min(this.currentIndexAnchor, len - 1)
        : Math.max(0, Math.min(this.currentIndexAnchor - 1, len - 1));
    next = this.firstUnlocked(channels, next, delta);
    this.play(next);
  }

  // Surfing passes over parental-locked channels instead of stopping on a PIN
  // prompt; they stay reachable from the list. If every other channel is locked,
  // the next one prompts as usual.
  private firstUnlocked(list: Channel[], start: number, delta: 1 | -1): number {
    const len = list.length;
    if (!ParentalControlService.enabled) return start;
    for (let step = 0, i = start; step < len; step++, i = ((i + delta) % len + len) % len) {
      if (list[i] === this.currentChannel) break;
      if (ParentalControlService.decision(liveParentalRequest(list[i], 'play')).allowed) return i;
    }
    return start;
  }

  // channel_up/channel_down while the current channel was launched from a
  // specific view (Favorites, a group, a folder, All) and the user has
  // opted into scoped cycling: step within that view's list — recomputed
  // live on every call, so a customization change mid-playback (unfavoriting,
  // hiding, reordering) is reflected immediately — instead of the full,
  // unfiltered channel list.
  private scopedChannelStep(delta: 1 | -1): void {
    const scope = this.currentScope;
    if (!scope) return;
    const list = PlaylistService.getByGroup(scope.group, scope.playlist);
    const pos = this.currentChannel ? list.indexOf(this.currentChannel) : -1;
    if (pos < 0) {
      // The view is empty, gone, or the playing channel dropped out of it —
      // resume plain global stepping instead of a remembered position in a
      // scope that's no longer valid.
      this.currentScope = null;
      this.globalChannelStep(delta);
      return;
    }
    const len = list.length;
    const next = this.firstUnlocked(list, ((pos + delta) % len + len) % len, delta);
    const globalIndex = PlaylistService.indexOf(list[next]);
    if (globalIndex < 0) return;
    this.play(globalIndex);
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  getCurrentCatchupStart(): number | null {
    return this.catchupInfo ? this.catchupInfo.start * 1000 : null;
  }

  getCurrentChannel(): Channel | null {
    return this.currentChannel;
  }

  /** Rebind live playback after the channel catalog is rebuilt or reordered. */
  syncCurrentIndex(): void {
    if (!this.currentChannel) return;
    const resolved = PlaylistService.resolveChannelKey(channelKey(this.currentChannel));
    if (!resolved) {
      this.currentIndex = -1;
      this.onTvPlaybackChanged(-1, this.catchupInfo ? this.catchupInfo.start * 1000 : null);
      this.onPlaybackStateChanged();
      return;
    }
    if (this.liveSessionActive && !this.catchupInfo
        && this.resolveStreamUrl(this.currentChannel, null)
          !== this.resolveStreamUrl(resolved.channel, null)) {
      // Already authorized: a refreshed stream URL must not ask for the PIN.
      this.playResolved(resolved.channel, resolved.channelIndex);
      return;
    }
    this.currentChannel = resolved.channel;
    this.currentIndex = resolved.channelIndex;
    this.currentIndexAnchor = resolved.channelIndex;
    this.onTvPlaybackChanged(
      resolved.channelIndex,
      this.catchupInfo ? this.catchupInfo.start * 1000 : null,
    );
    this.onPlaybackStateChanged();
  }

  selectAudioTrack(index: number): void {
    this.tracks.selectAudioTrack(index);
    this.tracksChanged();
  }

  selectSubtitleTrack(index: number): void {
    this.tracks.selectSubtitleTrack(index);
    this.tracksChanged();
  }

  handleAction(action: Action, event?: NumberEvent): void {
    // Any non-OK button means 5-way/button input, so a tracked cursor position
    // is stale — drop it so OK toggles the OSD rather than seeking.
    if (action !== 'select') this.osd.clearPointer();
    if (this.picker.visible && action !== 'number') {
      this.picker.handleAction(action);
      return;
    }
    if (this.vod) { this.handleVodAction(action); return; }
    const active = this.osd.isActive();
    const onControls = active && this.osd.focused() !== 'seek';
    switch (action) {
      case 'back':
      case 'stop':
        this.stop();
        this.onBack();
        break;
      case 'select':
        {
          const pointer = this.osd.pointerPosition();
          if (this.osd.seekAtPointer(pointer.x, pointer.y)) break;
        }
        // OK hands the controls the keys, and once they have them presses the
        // focused one. A pausable stream (catch-up, live DVR) lands on the
        // seek bar, where OK pauses as on VOD; with its controls already
        // showing, the first OK pauses at once, as it always did.
        if (active) {
          if (this.osd.focused() === 'seek') this.pauseToggle();
          else this.osd.activateFocused();
        } else if (this.isLiveDvr() || this.catchupInfo) {
          if (this.canSeek()) this.pauseToggle();
          this.osd.activate('seek');
        } else {
          this.osd.activate();
        }
        break;
      case 'left':
      case 'right':
        // The controls' buttons take Left/Right; otherwise they skip while
        // the controls show on a seekable stream (catch-up, live DVR).
        if (onControls) this.osd.move(action);
        else if (this.canSeek()) this.seekKey(action === 'left' ? -1 : 1);
        break;
      case 'up':
      case 'down':
        if (active) this.osd.move(action);
        else if (action === 'up') this.channelUp();
        else this.channelDown();
        break;
      case 'channel_up':
        this.channelUp();
        break;
      case 'channel_down':
        this.channelDown();
        break;
      case 'yellow':
        this.showOSD();
        break;
      case 'play':
        if (this.videoEl?.paused) this.pauseToggle();
        break;
      case 'pause':
        if (this.videoEl && !this.videoEl.paused) this.pauseToggle();
        break;
      case 'rewind':
        this.goToOldest();
        break;
      case 'fast_forward':
        this.goToLive();
        break;
      case 'number':
        if (event) this.playChannelNumber(event.number);
        break;
    }
  }

  // Channel numbers are 1-based, matching the OSD readout (currentIndexAnchor + 1).
  private playChannelNumber(number: number): void {
    const index = number - 1;
    if (index < 0 || index >= PlaylistService.channels.length) {
      log.debug('Channel number out of range', 'event=key.number.rejected',
        `number=${number}`, 'reason=out_of_range');
      this.showOSD();
      return;
    }
    log.debug('Channel number jump', 'event=key.number.accepted',
      `number=${number}`, `index=${index}`);
    // A typed absolute channel number is a deliberate "go anywhere" jump —
    // clear any active view scope so a following channel_up/down resumes
    // plain global stepping, not whatever view was active before this jump.
    this.play(index, undefined, null);
  }
}

// The queue entry for a playing item: its playback-only fields dropped.
function queueItem(v: VodPlayback): VodQueueItem {
  return {
    url: v.url,
    title: v.title,
    poster: v.poster,
    accountId: v.accountId,
    itemId: v.itemId,
    kind: v.kind,
    categoryId: v.categoryId,
    parentalItemId: v.parentalItemId,
    subtitles: v.subtitles,
    searchMeta: v.searchMeta,
    watchlistOwner: v.watchlistOwner,
  };
}

function sameParentalItem(a: VodQueueItem, b: VodQueueItem): boolean {
  return a.accountId === b.accountId && a.kind === b.kind && !!a.parentalItemId
    && a.parentalItemId === b.parentalItemId && a.categoryId === b.categoryId;
}
