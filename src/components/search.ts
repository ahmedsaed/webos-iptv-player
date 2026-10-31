import type { Action, CatchupInfo, Channel, PlaylistEntry, Programme, VodItem, SeriesItem } from '../types';
import { SpatialNav, isFocusMove } from '../navigation/spatial-nav';
import { Focus, type FocusScope } from '../navigation/focus-scope';
import { html, raw, type Safe } from '../utils/dom';
import { channelLockBadge, seriesLockBadge, vodLockBadge } from './parental-badge';
import { morph } from '../utils/morph';
import { PlaylistService } from '../services/playlist-service';
import { EpgService } from '../services/epg-service';
import { ReminderService } from '../services/reminder-service';
import { StorageService } from '../services/storage-service';
import { XtreamArchiveService } from '../services/xtream-archive';
import { persistSearchIndexes } from '../services/search-index-store';
import {
  getSearchCatalogExpiresAt,
  loadAllSeries,
  loadAllVodStreams,
  onCatalogListRefreshed,
} from '../services/xtream-catalog';
import {
  prepareNameSearchItems,
  prepareSearchItems,
  rankPreparedNamesTopK,
  rankPreparedTopK,
  searchMatchRanges,
} from '../utils/channel-search';
import { channelKey, legacyChannelKey } from '../utils/channel';
import { formatDayLabel, formatTime } from '../utils/time';
import { showToast } from './toast';
import { CLOCK_ICON, TRASH_ICON } from './icons';
import { CatchupResumePrompt } from './catchup-resume-prompt';
import { SearchIndicator } from './search-indicator';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import { t } from '../i18n';
import { VirtualList } from '../utils/virtual-list';
import { VirtualScrollGuard, type VirtualScrollAxis } from '../utils/virtual-scroll';
import { runInFrameSlices } from '../utils/frame-slices';
import {
  appWorkerGeneration,
  retainAppWorker,
  runAppWorkerTask,
} from '../workers/app-worker-client';
import {
  catalogParentalRequest,
  isSeriesConcealed,
  isVodConcealed,
  liveParentalRequest,
  ParentalControlService,
} from '../services/parental-control';
import type {
  SearchCachedNames,
  SearchIndexChunk,
  SearchIndexRequest,
  SearchIndexSource,
  SearchQueryBoost,
  SearchQueryRequest,
  SearchQueryResponse,
} from '../workers/tasks';
import {
  cachedChannelsRequest,
  cachedNamesRequest,
  channelDocument,
  ProgrammeRuns,
  sampleDocuments,
  selectCatalogItems,
} from './search-cache-source';
import { uiPx } from '../utils/ui-scale';

const log = createLogger('Search');
const SEARCH_RAIL_VIEWPORT = 1760;
const SEARCH_RAIL_OVERSCAN = 4;
// Card width plus the gap between cards, per rail.
const CHANNEL_STRIDE = 322;
const PROGRAM_STRIDE = 442;
const POSTER_STRIDE = 202;

type RailKey = 'channels' | 'programmes' | 'movies' | 'series';
const RAIL_KEYS: RailKey[] = ['channels', 'programmes', 'movies', 'series'];
const RAIL_STRIDES: Record<RailKey, number> = {
  channels: CHANNEL_STRIDE,
  programmes: PROGRAM_STRIDE,
  movies: POSTER_STRIDE,
  series: POSTER_STRIDE,
};

function railKey(value: string | undefined): RailKey | null {
  return RAIL_KEYS.indexOf(value as RailKey) >= 0 ? value as RailKey : null;
}

export interface SearchHandlers {
  // Up off the top result, or nothing to land on yet: the query box.
  onFocusBox: () => void;
  // A result arrived after the remote waited in the box: let it go.
  onReleaseBox: () => void;
  // A submitted query has nothing to focus yet, or matched nothing: the box
  // keeps the keys with the on-screen keyboard closed.
  onHoldBox: () => void;
  // Whether the box still holds the keys it was given while waiting.
  boxHeld: () => boolean;
  onBack: () => void;
  // OK on a recent search: run it.
  onPickRecent: (query: string) => void;
  onPlayChannel: (index: number, catchup?: CatchupInfo) => void;
  onOpenMovie: (account: PlaylistEntry, vod: VodItem) => void;
  onOpenSeries: (account: PlaylistEntry, series: SeriesItem) => void;
}

interface ProgramResult {
  channel: Channel;
  channelIndex: number;
  programme: Programme;
}

function programDocument(result: ProgramResult): string[] {
  return [
    result.programme.title,
    result.programme.category,
    result.programme.description,
    result.channel.name,
    result.channel.group,
  ];
}

type CatalogLoadResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: unknown };

interface CatalogSources {
  movies: boolean;
  series: boolean;
}

// Sources still on their way to the worker in this session.
interface PendingIndex {
  channels: boolean;
  programmes: boolean;
  catalog: boolean;
}

interface SourcePost {
  id: number;
  // Settles once this post stops sending chunks.
  sent: Promise<void>;
  result: Promise<boolean>;
}

function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function captureCatalogLoad<T>(promise: Promise<T>): Promise<CatalogLoadResult<T>> {
  return promise.then(
    (data) => ({ ok: true, data }),
    (error: unknown) => ({ ok: false, error }),
  );
}

function sameCatalogSource(left: SearchCachedNames | null, right: SearchCachedNames | null): boolean {
  if (!left || !right || left.record.key !== right.record.key
    || left.record.timestamp !== right.record.timestamp || left.length !== right.length) return false;
  if (!left.selection || !right.selection) return left.selection === right.selection;
  if (left.selection.length !== right.selection.length) return false;
  for (let i = 0; i < left.selection.length; i++) {
    if (left.selection[i] !== right.selection[i]) return false;
  }
  return true;
}

// The Search section: one query box over Channels / Programs / Movies / Series.
// Results are relevance-ranked and capped; movies and series match the account's
// full catalogs, loaded once on open and cached.
// The query box (SearchBox) sits above the results; Up from the top result
// and Back return to it.
export class Search {
  private nav: SpatialNav;
  readonly focusScope: FocusScope;
  private account: PlaylistEntry | null = null;
  private query = '';
  private allVod: VodItem[] = [];
  private allSeries: SeriesItem[] = [];
  private programIndex: ProgramResult[] = [];
  private programRuns = new ProgrammeRuns();
  // The catalog-cache selections behind allVod / allSeries, when available.
  private vodCache: SearchCachedNames | null = null;
  private seriesCache: SearchCachedNames | null = null;
  // The channel list whose documents the worker holds in this session.
  private workerChannels: Channel[] | null = null;
  private indexedChannels: Channel[] | null = null;
  private indexedProgrammes: Record<string, Programme[]> | null = null;
  private loadedFor: string | null = null;
  private catalogExpiresAt = 0;
  private visibleChannels: Channel[] = [];
  private visiblePrograms: ProgramResult[] = [];
  private visibleMovies: VodItem[] = [];
  private visibleSeries: SeriesItem[] = [];
  // Every match per section, beyond the ranked results kept.
  private totals: Record<RailKey, number> = { channels: 0, programmes: 0, movies: 0, series: 0 };
  // Each catalog list's item positions by id, for ranking boosts.
  private readonly idIndexes = new WeakMap<object, Map<string, number>>();
  private resumePrompt = new CatchupResumePrompt('prompt.search');
  private readonly channelVirtualizer = this.createVirtualizer(CHANNEL_STRIDE);
  private readonly programVirtualizer = this.createVirtualizer(PROGRAM_STRIDE);
  private readonly movieVirtualizer = this.createVirtualizer(POSTER_STRIDE);
  private readonly seriesVirtualizer = this.createVirtualizer(POSTER_STRIDE);
  private scrollFrame: number | null = null;
  // The window each virtual rail last rendered; its cells sit at fixed
  // offsets, so a scroll inside the window needs no render.
  private readonly railWindows = new Map<string, string>();
  private queryFrame: number | null = null;
  private queryGeneration = 0;
  private queryPending = false;
  // Down/Enter handed focus over before the results existed; focus them once a query renders.
  private focusPending = false;
  private focusWaitingInBox = false;
  private readonly indicator = new SearchIndicator(() => { if (this.active) this.render(); });
  private catalogController: AbortController | null = null;
  // Shared by a reopen, so closing Search does not restart the load.
  private catalogLoad: { accountId: string; promise: Promise<CatalogSources> } | null = null;
  private catalogLoading = false;
  // Opened before the channels load: the results area says so until the
  // app opens the index over them.
  private channelsLoading = false;
  // Until every source is indexed, queries wait and the results show a hint.
  private pendingIndex: PendingIndex | null = null;
  private active = false;
  private programIndexGeneration = 0;
  private resultLimit: number = CONFIG.SEARCH.INITIAL_RESULTS;
  private hasMoreResults = false;
  private expandingGeneration: number | null = null;
  private workerSession = 0;
  private workerIndexReady = false;
  // A post failed, so the worker may hold a partial index; the next query rebuilds it.
  private workerIndexLost = false;
  // One rebuild of a lost index per session; queries meanwhile wait for it.
  private recovery: { sessionId: number; done: Promise<boolean> } | null = null;
  // A rebuild of the session's lost index failed: until `at`, its queries rank
  // on the main thread rather than post the whole index to that worker again.
  // `logged`: the failure was logged, and is not again until a rebuild succeeds.
  private recoveryRetry: {
    sessionId: number;
    at: number;
    generation: number | null;
    logged: boolean;
  } | null = null;
  // The catalog lists the worker ranks, which can trail allVod/allSeries
  // while a refresh is posted; worker indices map onto these.
  private indexedVod: VodItem[] = [];
  private indexedSeries: SeriesItem[] = [];
  // How this session's index reached the worker, for its diagnostic event.
  private indexStats = { startedAt: 0, hintAt: 0, persisted: 0, built: 0, posted: 0 };
  // The latest chunked post of each source; a source posts one sequence at a time.
  private sourcePosts: Partial<Record<SearchIndexSource, SourcePost>> = {};
  private sourcePostId = 0;
  private workerIndexedChannels: Channel[] | null = null;
  private workerIndexedProgrammes: Record<string, Programme[]> | null = null;
  private workerIndexedAccountId: string | null = null;
  private workerIndexedGeneration: number | null = null;
  private workerResetGeneration: number | null = null;
  private workerIndexedVod: VodItem[] | null = null;
  private workerIndexedSeries: SeriesItem[] | null = null;
  private releaseWorker: (() => void) | null = null;
  private readonly scrollGuard = new VirtualScrollGuard();

  constructor(private container: HTMLElement, private handlers: SearchHandlers) {
    this.focusScope = Focus.register({
      id: 'view.search',
      root: container,
      defaultKey: () => this.navKey(),
      resolve: (key) => this.resolveKey(key),
    });
    this.nav = new SpatialNav(container, undefined, { scope: this.focusScope });
    // Activate the result under the pointer by coordinate hit-test, so it lands
    // here regardless of D-pad focus; the container is marked `data-self-activate`
    // so the global click handler skips this subtree and doesn't double-fire.
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (e: MouseEvent) => this.onPointerRelease(e.clientX, e.clientY));
    this.container.addEventListener('scroll', (e: Event) => this.onVirtualScroll(e), true);
    onCatalogListRefreshed((key, changed) => this.onCatalogRefreshed(key, changed));
  }

  private onPointerRelease(x: number, y: number): void {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-focusable]');
    if (!el || !this.container.contains(el)) return;
    this.nav.focus(el, 'pointer');
    this.onSelect();
  }

  private navKey(): string | null {
    const el = this.nav.focused;
    return el && this.container.contains(el) ? el.dataset.key ?? null : null;
  }

  // A channel can show as both a tile and a row: the ring goes on the one
  // the nav holds.
  private resolveKey(key: string): HTMLElement | null {
    const el = this.nav.focused;
    if (el && this.container.contains(el) && el.dataset.key === key) return el;
    return Array.from(this.container.querySelectorAll<HTMLElement>('[data-focusable][data-key]'))
      .find((item) => item.dataset.key === key) ?? null;
  }

  showChannelsLoading(): void {
    this.channelsLoading = true;
    this.render();
  }

  async open(account: PlaylistEntry | null, query = ''): Promise<void> {
    this.channelsLoading = false;
    this.active = true;
    // Another task may have started a new, empty worker since the index was built.
    const generation = appWorkerGeneration();
    if (generation === null || generation !== this.workerIndexedGeneration) {
      this.invalidateWorkerIndex();
    }
    const reuseWorkerIndex = this.canReuseWorkerIndex(account);
    if (!this.releaseWorker) this.releaseWorker = retainAppWorker();
    this.cancelScheduledQuery();
    if (this.catalogLoad && this.catalogLoad.accountId !== account?.id) this.abortCatalogLoad();
    if (this.loadedFor !== account?.id) {
      this.allVod = [];
      this.allSeries = [];
      this.vodCache = null;
      this.seriesCache = null;
      this.loadedFor = null;
      this.catalogExpiresAt = 0;
    }
    this.account = account;
    this.query = query;
    this.resultLimit = CONFIG.SEARCH.INITIAL_RESULTS;
    if (!reuseWorkerIndex) {
      this.pendingIndex = { channels: true, programmes: true, catalog: !!account };
      this.clearResults();
    }
    this.render();
    if (reuseWorkerIndex) {
      this.logIndexReady('reused');
      if (account && Date.now() >= this.catalogExpiresAt) this.refreshCatalogIndex(account);
      return;
    }

    const sessionId = ++this.workerSession;
    this.invalidateWorkerIndex();
    this.workerIndexLost = false;
    this.recoveryRetry = null;
    const now = Date.now();
    this.indexStats = { startedAt: now, hintAt: query.trim() ? now : 0, persisted: 0, built: 0, posted: 0 };
    this.workerChannels = null;
    const workerReset = new Promise<boolean>((resolve, reject) => {
      requestAnimationFrame(() => {
        if (!this.active || sessionId !== this.workerSession) {
          resolve(false);
          return;
        }
        this.indexWorker({ sessionId, reset: true }).then(resolve, reject);
      });
    });
    if (account) {
      this.catalogLoading = true;
      const catalogIndexed = this.loadCatalog(account).then(async (sources) => {
        if (!await workerReset || sessionId !== this.workerSession) return false;
        return this.indexCatalog(sessionId, sources.movies, sources.series);
      });
      const settled = (indexed: boolean): void => {
        if (sessionId !== this.workerSession) return;
        this.catalogLoading = false;
        if (indexed) this.indexSettled(sessionId, 'catalog');
        else this.indexLost(sessionId, 'rejected', 'catalog');
        this.applyPendingFocus();
      };
      catalogIndexed.then(settled, () => {
        if (sessionId !== this.workerSession) return;
        this.catalogLoading = false;
        this.indexLost(sessionId, 'error', 'catalog');
        this.applyPendingFocus();
      });
    }
    try {
      await this.indexChannelsAndProgrammes(sessionId, workerReset);
    } catch (error) {
      if (sessionId !== this.workerSession) return;
      // Queries rebuild a lost index themselves; don't leave the hint up.
      log.error('Search index build failed', 'event=search.worker.index.failed', error);
      this.indexLost(sessionId, 'error', 'channels', 'programmes');
    }
  }

  private async indexChannelsAndProgrammes(
    sessionId: number,
    workerReset: Promise<boolean>,
  ): Promise<void> {
    const reset = await workerReset;
    if (!reset || !this.active || sessionId !== this.workerSession) return;
    const channels = PlaylistService.channels;
    const postChannels = (): Promise<boolean> => this.postSource(
      sessionId,
      'channels',
      channels.length,
      index => channelDocument(channels[index]),
    );
    const cachedChannels = cachedChannelsRequest(channels, PlaylistService.getChannelCacheSource());
    const channelsIndexed = cachedChannels
      ? await this.indexWorkerFromCache({ sessionId, cachedChannels }, postChannels)
      : await postChannels();
    if (!channelsIndexed) {
      this.indexLost(sessionId, 'rejected', 'channels', 'programmes');
      return;
    }
    if (!this.active || sessionId !== this.workerSession) return;
    this.workerChannels = channels;
    this.indexSettled(sessionId, 'channels');
    this.programIndexDone(sessionId, await this.buildProgramIndex(false, sessionId));
  }

  /** The search box drives the query; re-render the results for it. */
  async setQuery(query: string): Promise<void> {
    this.focusPending = false;
    this.cancelScheduledQuery();
    this.query = query;
    this.resultLimit = CONFIG.SEARCH.INITIAL_RESULTS;
    if (!query.trim()) {
      this.clearResults();
      this.render();
      return;
    }
    await this.startQuery(this.queryGeneration);
  }

  scheduleQuery(query: string): void {
    this.focusPending = false;
    this.query = query;
    this.resultLimit = CONFIG.SEARCH.INITIAL_RESULTS;
    const generation = ++this.queryGeneration;
    if (this.queryFrame !== null) cancelAnimationFrame(this.queryFrame);
    if (!query.trim()) {
      this.queryFrame = null;
      this.clearResults();
      this.render();
      return;
    }
    this.queryFrame = requestAnimationFrame(() => {
      this.queryFrame = null;
      if (generation !== this.queryGeneration) return;
      void this.startQuery(generation);
    });
  }

  async refreshPrograms(): Promise<void> {
    this.programIndexGeneration++;
    this.indexedChannels = null;
    this.indexedProgrammes = null;
    if (!this.active) return;
    const sessionId = this.workerSession;
    // While sources are pending, the last one to settle runs the query.
    const wasPending = !!this.pendingIndex;
    try {
      this.programIndexDone(sessionId, await this.buildProgramIndex(true, sessionId));
    } catch (error) {
      log.error('Search program index failed', 'event=search.worker.index.failed', 'scope=programmes', error);
      this.indexLost(sessionId, 'error', 'programmes');
    }
    if (!wasPending && this.active && !this.pendingIndex && this.query.trim()) {
      await this.startQuery(++this.queryGeneration);
    }
  }

  refreshLocks(): void {
    if (this.container.querySelector('.search-view')) this.render();
  }

  // Locked content was hidden or revealed: drop the rendered results at once,
  // since their indexes point into the old channel list, then search again.
  async refreshConcealment(): Promise<void> {
    this.invalidateCatalog();
    if (!this.active) return;
    this.queryPending = !!this.query.trim();
    await this.open(this.account, this.query);
  }

  invalidateCatalog(): void {
    this.abortCatalogLoad();
    this.pendingIndex = null;
    this.workerSession++;
    this.recoveryRetry = null;
    this.allVod = [];
    this.allSeries = [];
    this.vodCache = null;
    this.seriesCache = null;
    this.loadedFor = null;
    this.nav.resetRecovery();
    this.clearResults();
    this.invalidateWorkerIndex();
  }

  dismissPrompt(): void {
    this.resumePrompt.hide();
  }

  deactivate(): void {
    this.active = false;
    this.channelsLoading = false;
    this.focusPending = false;
    this.programIndexGeneration++;
    this.recoveryRetry = null;
    this.releaseWorker?.();
    this.releaseWorker = null;
    this.queryPending = false;
    this.indicator.reset();
  }

  handleAction(action: Action): void {
    this.focusPending = false;
    if (this.resumePrompt.visible) {
      this.resumePrompt.handleAction(action);
      return;
    }
    if (isFocusMove(action) && this.nav.showConcealed()) return;
    if (this.moveRecentFocus(action)) return;
    if (this.moveVirtualFocus(action)) return;
    switch (action) {
      case 'up':
        if (!this.nav.move('up')) this.handlers.onFocusBox();
        return;
      case 'left':
      case 'down':
      case 'right':
        this.nav.move(action);
        return;
      case 'select':
        this.onSelect();
        return;
      case 'back':
        this.handlers.onBack();
        return;
      default:
        return;
    }
  }

  // Load the whole catalogs once per account (cached in IndexedDB). A reopen
  // shares the load in flight; only an account switch or a concealment change
  // aborts it, so a stale load can't clobber the current account's catalog.
  private loadCatalog(account: PlaylistEntry): Promise<CatalogSources> {
    if (this.loadedFor === account.id && Date.now() < this.catalogExpiresAt) {
      return Promise.resolve({ movies: true, series: true });
    }
    if (this.catalogLoad?.accountId === account.id) return this.catalogLoad.promise;
    const controller = new AbortController();
    this.catalogController = controller;
    const promise = this.fetchCatalog(account, controller.signal);
    const load = { accountId: account.id, promise };
    this.catalogLoad = load;
    const done = (): void => {
      if (this.catalogLoad === load) this.catalogLoad = null;
      if (this.catalogController === controller) this.catalogController = null;
    };
    promise.then(done, done);
    return promise;
  }

  private async fetchCatalog(account: PlaylistEntry, signal: AbortSignal): Promise<CatalogSources> {
    const [vod, series] = await Promise.all([
      captureCatalogLoad(loadAllVodStreams(account, signal)),
      captureCatalogLoad(loadAllSeries(account, signal)),
    ]);
    if (signal.aborted || this.account?.id !== account.id
      || this.catalogController?.signal !== signal) return { movies: false, series: false };
    const concealing = ParentalControlService.concealing;
    if (vod.ok) {
      const visible = selectCatalogItems(vod.data, concealing, isVodConcealed);
      const cache = cachedNamesRequest(vod.data, visible.items, visible.selection);
      if (!sameCatalogSource(this.vodCache, cache)) this.allVod = visible.items;
      this.vodCache = cache;
    } else {
      log.error(
        'Movie search catalog load failed',
        'event=xtream.search.load.failed',
        'resource=movies',
        vod.error,
      );
    }
    if (series.ok) {
      const visible = selectCatalogItems(series.data, concealing, isSeriesConcealed);
      const cache = cachedNamesRequest(series.data, visible.items, visible.selection);
      if (!sameCatalogSource(this.seriesCache, cache)) this.allSeries = visible.items;
      this.seriesCache = cache;
    } else {
      log.error(
        'Series search catalog load failed',
        'event=xtream.search.load.failed',
        'resource=series',
        series.error,
      );
    }
    if (vod.ok && series.ok) {
      const expiresAt = await getSearchCatalogExpiresAt(account.id) ?? 0;
      if (signal.aborted || this.account?.id !== account.id
        || this.catalogController?.signal !== signal) return { movies: false, series: false };
      this.loadedFor = account.id;
      this.catalogExpiresAt = expiresAt;
      log.debug(
        'catalog loaded',
        vod.data.length,
        'movies,',
        series.data.length,
        'series',
      );
    }
    return { movies: vod.ok, series: series.ok };
  }

  private abortCatalogLoad(): void {
    this.catalogController?.abort();
    this.catalogController = null;
    this.catalogLoad = null;
    this.catalogLoading = false;
  }

  // A stale catalog was served at once and has now been re-fetched: index the
  // new copy for an open Search, or leave it for the next open.
  private onCatalogRefreshed(key: string, changed = true): void {
    const account = this.account;
    if (!account || this.loadedFor !== account.id) return;
    if (key !== `${account.id}|vod_all` && key !== `${account.id}|series_all`) return;
    if (!changed) {
      void getSearchCatalogExpiresAt(account.id).then(expiresAt => {
        if (this.account?.id === account.id && this.loadedFor === account.id) {
          this.catalogExpiresAt = expiresAt ?? 0;
        }
      }).catch((error: unknown) => {
        log.error('Search catalog refresh failed', 'event=search.worker.index.failed', 'scope=catalog', error);
      });
      return;
    }
    this.loadedFor = null;
    this.catalogExpiresAt = 0;
    this.abortCatalogLoad();
    if (!this.active || this.pendingIndex) return;
    this.refreshCatalogIndex(account);
  }

  private refreshCatalogIndex(account: PlaylistEntry): void {
    const sessionId = this.workerSession;
    const refreshed = async (indexed: boolean, reason = 'rejected'): Promise<void> => {
      if (!this.active || sessionId !== this.workerSession || this.account?.id !== account.id) return;
      if (!indexed) this.indexLost(sessionId, reason, 'catalog');
      else if (this.workerIndexReady) this.markWorkerIndexReady(account);
      if (this.query.trim()) await this.startQuery(++this.queryGeneration);
    };
    void this.loadCatalog(account).then(async (sources) => {
      if (!this.active || sessionId !== this.workerSession || this.account?.id !== account.id) return;
      if (this.workerIndexLost) {
        // The rebuild re-reads the lists; a post of this copy could land after its own.
        if (this.query.trim()) await this.startQuery(++this.queryGeneration);
        return;
      }
      const movies = sources.movies && this.indexedVod !== this.allVod;
      const series = sources.series && this.indexedSeries !== this.allSeries;
      if (movies || series) await refreshed(await this.indexCatalog(sessionId, movies, series));
    }).catch(async (error: unknown) => {
      log.error('Search catalog refresh failed', 'event=search.worker.index.failed', 'scope=catalog', error);
      await refreshed(false, 'error');
    });
  }

  // null: a newer program index build took over and settles instead.
  private programIndexDone(sessionId: number, indexed: boolean | null): void {
    if (indexed) this.indexSettled(sessionId, 'programmes');
    else if (indexed === false) this.indexLost(sessionId, 'rejected', 'programmes');
  }

  // The sources are settled but the worker may hold a partial index: the
  // first query after the last pending source rebuilds it whole.
  private indexLost(sessionId: number, reason: string, ...sources: Array<keyof PendingIndex>): void {
    if (sessionId !== this.workerSession) return;
    for (const source of sources) {
      log.warn(
        'Search index incomplete; the next query rebuilds it',
        'event=search.index.lost',
        `session=${String(sessionId)}`,
        `source=${source}`,
        `reason=${reason}`,
      );
    }
    this.workerIndexLost = true;
    this.indexSettled(sessionId, ...sources);
  }

  private logIndexReady(mode: string): void {
    const stats = this.indexStats;
    const now = Date.now();
    const fields = mode === 'reused'
      ? []
      : [
        `persisted=${String(stats.persisted)}`,
        `built=${String(stats.built)}`,
        `posted=${String(stats.posted)}`,
        `elapsedMs=${String(now - stats.startedAt)}`,
        `hintMs=${String(stats.hintAt ? now - stats.hintAt : 0)}`,
      ];
    log.info(
      'Search index ready',
      'event=search.index.ready',
      `session=${String(this.workerSession)}`,
      `mode=${mode}`,
      `channels=${String(PlaylistService.channels.length)}`,
      `programmes=${String(this.programIndex.length)}`,
      `items=${String(this.allVod.length + this.allSeries.length)}`,
      ...fields,
    );
  }

  private indexMode(): string {
    const stats = this.indexStats;
    if (this.workerIndexLost) return 'lost';
    if (stats.posted) return 'fallback';
    if (stats.built) return 'cache';
    return 'persisted';
  }

  private indexSettled(sessionId: number, ...sources: Array<keyof PendingIndex>): void {
    const pending = this.pendingIndex;
    if (!pending || sessionId !== this.workerSession) return;
    for (const source of sources) pending[source] = false;
    if (pending.channels || pending.programmes || pending.catalog) return;
    this.pendingIndex = null;
    this.logIndexReady(this.indexMode());
    if (!this.workerIndexLost) this.markWorkerIndexReady(this.account);
    if (!this.active) return;
    if (this.query.trim()) void this.startQuery(++this.queryGeneration);
    else this.render();
  }

  // Recent searches: Up from the top row goes straight to the box, past the
  // clear button, so Up then OK can't wipe the history; Right reaches it.
  private moveRecentFocus(action: Action): boolean {
    const focused = this.nav.focused;
    if (!focused || !this.container.contains(focused)) return false;
    const clear = this.container.querySelector<HTMLElement>('[data-history-clear]');
    if (focused === clear) {
      if (action === 'up') this.handlers.onFocusBox();
      else if (action === 'down' || action === 'left') this.nav.focus(this.firstRecent());
      else return action === 'right';
      return true;
    }
    if (!focused.classList.contains('search-recent-chip')) return false;
    if (action === 'up') {
      if (this.inTopRecentRow(focused) || !this.nav.move('up') || this.nav.focused === clear) {
        this.handlers.onFocusBox();
      }
      return true;
    }
    if (action === 'right') {
      if (!this.nav.move('right') && this.inTopRecentRow(focused)) this.nav.focus(clear);
      return true;
    }
    return false;
  }

  private firstRecent(): HTMLElement | null {
    return this.container.querySelector<HTMLElement>('.search-recent-chip');
  }

  private inTopRecentRow(el: HTMLElement): boolean {
    const first = this.firstRecent();
    return !!first && el.offsetTop === first.offsetTop;
  }

  /** The box handed off with an empty query: land on the first recent search. */
  focusRecent(): boolean {
    const first = this.firstRecent();
    if (!first) return false;
    this.nav.focus(first);
    return true;
  }

  private onSelect(): void {
    const el = this.nav.focused;
    // A result a re-render removed opens nothing; the next arrow recovers focus.
    if (!el || !this.container.contains(el)) return;
    if (el.dataset.historyQuery !== undefined) {
      const query = el.dataset.historyQuery;
      const history = StorageService.getSearchHistory();
      // Position only: the query text itself stays out of the logs.
      log.debug(
        'Recent search picked',
        'event=search.history.picked',
        `count=${String(history.indexOf(query) + 1)}`,
        `items=${String(history.length)}`,
      );
      this.nav.focus(null);
      this.handlers.onPickRecent(query);
      return;
    }
    if (el.hasAttribute('data-history-clear')) {
      const items = StorageService.getSearchHistory().length;
      if (!StorageService.clearSearchHistory()) return;
      log.debug('Recent searches cleared', 'event=search.history.cleared', `items=${String(items)}`);
      this.nav.focus(null);
      this.render();
      this.handlers.onFocusBox();
      return;
    }
    // Only a query that opened something is worth remembering, not every keystroke.
    const query = this.query;
    if (el.dataset.channelIndex !== undefined) {
      const index = parseInt(el.dataset.channelIndex, 10);
      const channel = PlaylistService.channels[index];
      if (channel) rememberQuery(query, liveParentalRequest(channel));
      this.handlers.onPlayChannel(index);
    } else if (el.dataset.programIndex !== undefined) {
      void this.activateProgram(parseInt(el.dataset.programIndex, 10), query);
    } else if (this.account && el.dataset.streamId !== undefined) {
      const v = this.allVod.find((x) => x.streamId === el.dataset.streamId);
      if (!v) return;
      rememberQuery(query, catalogParentalRequest('vod', { ...v, id: v.streamId }));
      this.handlers.onOpenMovie(this.account, v);
    } else if (this.account && el.dataset.seriesId !== undefined) {
      const s = this.allSeries.find((x) => x.seriesId === el.dataset.seriesId);
      if (!s) return;
      rememberQuery(query, catalogParentalRequest('series', { ...s, id: s.seriesId }));
      this.handlers.onOpenSeries(this.account, s);
    }
  }

  /** Move focus into the first result (called when the search box hands off
   *  with Enter / Down). */
  focusFirstResult(): void {
    this.focusPending = true;
    this.focusWaitingInBox = false;
    if (this.queryFrame !== null) {
      this.cancelScheduledQuery();
      void this.startQuery(this.queryGeneration);
      return;
    }
    this.applyPendingFocus();
  }

  // Waits out superseded queries and a catalog still loading: only a render of
  // the latest query with something to focus completes the handoff.
  private applyPendingFocus(): void {
    if (!this.focusPending || !this.active || this.queryPending) return;
    const first = this.container.querySelector<HTMLElement>('.search-results [data-focusable]');
    if (!first && (this.catalogLoading || this.pendingIndex)) {
      // Wait in the search box, not on a blank screen, for the catalog.
      if (!this.focusWaitingInBox) {
        this.focusWaitingInBox = true;
        this.handlers.onHoldBox();
      }
      return;
    }
    const waited = this.focusWaitingInBox;
    this.focusWaitingInBox = false;
    this.focusPending = false;
    // Nothing matched: keep the remote in the search box, not on a blank screen.
    if (!first) {
      if (!waited) this.handlers.onHoldBox();
      return;
    }
    if (waited) {
      // The remote moved on from the box meanwhile: don't pull it back.
      if (!this.handlers.boxHeld()) return;
      this.handlers.onReleaseBox();
    }
    this.nav.focus(first);
  }

  private posterCell(name: string, poster: string): Safe {
    return poster
      ? html`<img class="catalog-poster" src="${poster}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : html`<div class="catalog-poster catalog-poster-empty">${name.charAt(0)}</div>`;
  }

  // One result section: a titled, counted, horizontally virtualized rail.
  private virtualRail<T>(
    title: string,
    key: RailKey,
    items: T[],
    virtualizer: VirtualList,
    renderItem: (item: T, index: number) => Safe,
  ): Safe {
    const viewport = this.container.querySelector<HTMLElement>(
      `[data-search-virtual="${key}"]`,
    )?.clientWidth || SEARCH_RAIL_VIEWPORT;
    const range = virtualizer.getRange(items.length, viewport);
    this.railWindows.set(key, this.railWindow(items.length, range));
    return html`
      <section class="search-section search-section-${key}" data-key="section:${key}">
        <h2 class="search-section-title">${title}<span class="search-section-count">${
          String(Math.max(this.totals[key], items.length))}</span></h2>
        <div class="search-rail" data-edge-scroll data-search-virtual="${key}" data-search-axis="horizontal">
          <div class="search-rail-spacer" style="width:${virtualizer.getTotalSize(items.length)}px">
            ${items.slice(range.start, range.end).map((item, offset) => {
              const index = range.start + offset;
              return html`
                <div class="search-rail-cell"
                     data-key="${key}:${index}"
                     data-search-section="${key}" data-search-index="${index}"
                     style="left:${virtualizer.getItemOffset(index)}px">
                  ${renderItem(item, index)}
                </div>
              `;
            })}
          </div>
        </div>
      </section>
    `;
  }

  // The matched part of an untrusted name, in the accent color.
  private highlighted(text: string): Safe {
    const ranges = searchMatchRanges(text, this.query);
    if (!ranges.length) return html`${text}`;
    const parts: Safe[] = [];
    let at = 0;
    for (const range of ranges) {
      if (range.start > at) parts.push(html`${text.slice(at, range.start)}`);
      parts.push(html`<mark class="search-match">${text.slice(range.start, range.end)}</mark>`);
      at = range.end;
    }
    if (at < text.length) parts.push(html`${text.slice(at)}`);
    return html`${parts}`;
  }

  private channelCard(ch: Channel): Safe {
    const idx = PlaylistService.indexOf(ch);
    const epgId = EpgService.findChannelId(ch);
    const now = epgId ? EpgService.getNowPlaying(epgId) : null;
    return html`
      <div class="search-card search-channel-card" data-focusable data-key="ch:${String(idx)}"
           data-channel-index="${String(idx)}">
        <div class="search-card-logo">${ch.logo
          ? html`<img src="${ch.logo}" alt="" loading="lazy" onerror="this.style.display='none'">`
          : html`<span>${ch.name.charAt(0)}</span>`}</div>
        <div class="search-card-text">
          <div class="search-card-title">${raw(channelLockBadge(ch))}${this.highlighted(ch.name)}</div>
          ${now ? html`<div class="search-card-sub">${now.title}</div>` : ''}
        </div>
      </div>
    `;
  }

  private movieTile(v: VodItem): Safe {
    return html`
      <div class="catalog-tile search-poster-tile" data-focusable data-key="v:${v.streamId}" data-stream-id="${v.streamId}">
        <div class="catalog-poster-wrap">${this.posterCell(v.name, v.poster)}${
          raw(vodLockBadge(v))}</div>
        <div class="catalog-tile-name">${this.highlighted(v.name)}</div>
      </div>
    `;
  }

  private seriesTile(s: SeriesItem): Safe {
    return html`
      <div class="catalog-tile search-poster-tile" data-focusable data-key="s:${s.seriesId}" data-series-id="${s.seriesId}">
        <div class="catalog-poster-wrap">${this.posterCell(s.name, s.poster)}${
          raw(seriesLockBadge(s))}</div>
        <div class="catalog-tile-name">${this.highlighted(s.name)}</div>
      </div>
    `;
  }

  // Recent searches under the empty box: OK runs one.
  private recentSection(): Safe {
    const history = StorageService.getSearchHistory();
    if (!history.length) return html``;
    return html`
      <section class="search-recent" data-key="recent">
        <div class="search-recent-head">
          <h2 class="search-section-title">${t('search.recent')}</h2>
          <div class="search-recent-clear" data-focusable data-key="recent-clear"
               data-history-clear>${raw(TRASH_ICON)}<span>${t('search.clearHistory')}</span></div>
        </div>
        <div class="search-recent-chips">
          ${history.map(query => html`
            <div class="search-recent-chip" data-focusable data-key="recent:${query}"
                 data-history-query="${query}">${raw(CLOCK_ICON)}<span class="search-recent-label">${query}</span></div>
          `)}
        </div>
      </section>
    `;
  }

  private async buildProgramIndex(force: boolean, sessionId: number): Promise<boolean | null> {
    if (!force
        && this.indexedChannels === PlaylistService.channels
        && this.indexedProgrammes === EpgService.programmes) {
      return this.indexProgrammes(sessionId);
    }
    const generation = ++this.programIndexGeneration;
    const channels = PlaylistService.channels;
    const programmesByChannel = EpgService.programmes;
    const programs: ProgramResult[] = [];
    const runs = new ProgrammeRuns();
    let channelIndex = 0;
    let channelPrograms: Programme[] = [];
    let programmeIndex = 0;
    const shouldContinue = (): boolean =>
      this.active && generation === this.programIndexGeneration;
    const collected = await runInFrameSlices(() => {
      if (programmeIndex < channelPrograms.length) {
        programs.push({
          channel: channels[channelIndex - 1],
          channelIndex: channelIndex - 1,
          programme: channelPrograms[programmeIndex++],
        });
        return false;
      }
      if (channelIndex >= channels.length) return true;
      const channel = channels[channelIndex++];
      const epgId = EpgService.findChannelId(channel);
      channelPrograms = epgId ? programmesByChannel[epgId] ?? [] : [];
      programmeIndex = 0;
      if (epgId && channelPrograms.length) {
        runs.add(channelIndex - 1, EpgService.programmeCacheOrigin(epgId), channelPrograms.length);
      }
      return false;
    }, { shouldContinue });
    if (!collected) return null;

    this.programIndex = programs;
    this.programRuns = runs;
    this.indexedChannels = channels;
    this.indexedProgrammes = programmesByChannel;
    return this.indexProgrammes(sessionId);
  }

  private indexProgrammes(sessionId: number): Promise<boolean> {
    const programs = this.programIndex;
    const postProgrammes = (): Promise<boolean> => this.postSource(
      sessionId,
      'programmes',
      programs.length,
      index => programDocument(programs[index]),
    );
    // Cached programme documents join the worker's channel documents, so
    // they must come from the very channel list the program index walked.
    const cachedProgrammes = this.workerChannels === this.indexedChannels
      && sessionId === this.workerSession
      ? this.programRuns.request(
        sampleDocuments(programs.length, index => programDocument(programs[index])),
      )
      : null;
    return cachedProgrammes
      ? this.indexWorkerFromCache({ sessionId, cachedProgrammes }, postProgrammes)
      : postProgrammes();
  }

  private async indexCatalog(sessionId: number, movies: boolean, series: boolean): Promise<boolean> {
    const vod = this.allVod;
    const allSeries = this.allSeries;
    const adopt = (sources: SearchIndexSource[]): void => {
      if (sessionId !== this.workerSession) return;
      if (sources.indexOf('movies') >= 0) this.indexedVod = vod;
      if (sources.indexOf('series') >= 0) this.indexedSeries = allSeries;
    };
    const post = async (sources: SearchIndexSource[]): Promise<boolean> => {
      for (const source of sources) {
        const items = source === 'movies' ? vod : allSeries;
        // A newer refresh replaced this list and posts its own; an older post
        // landing after it would leave the worker on the older list.
        if (items !== (source === 'movies' ? this.allVod : this.allSeries)) continue;
        const result = this.postSource(sessionId, source, items.length, index => items[index].name);
        const own = this.sourcePosts[source];
        if (!await result) return false;
        // A newer post replaced this one and shares its outcome, not its list.
        if (this.sourcePosts[source] === own) adopt([source]);
      }
      return true;
    };
    const request: SearchIndexRequest = { sessionId };
    const posted: SearchIndexSource[] = [];
    if (movies && this.vodCache) request.cachedMovies = this.vodCache;
    else if (movies) posted.push('movies');
    if (series && this.seriesCache) request.cachedSeries = this.seriesCache;
    else if (series) posted.push('series');
    if (!request.cachedMovies && !request.cachedSeries) return post(posted);
    const cached = await this.indexWorkerFromCache(request, post, adopt);
    return cached && post(posted);
  }

  private async indexWorker(request: SearchIndexRequest): Promise<boolean> {
    const pending = runAppWorkerTask('search.index', request);
    // Record the worker that took the reset, not whichever one runs when the index is marked ready.
    const generation = appWorkerGeneration();
    const response = await pending;
    const accepted = response.accepted && request.sessionId === this.workerSession;
    if (accepted && request.reset) {
      this.workerResetGeneration = generation;
      this.indexedVod = [];
      this.indexedSeries = [];
    }
    return accepted;
  }

  // The worker reads the documents from IndexedDB; whatever it could not
  // read or verify is posted as plain arrays instead.
  private async indexWorkerFromCache(
    request: SearchIndexRequest,
    post: (sources: SearchIndexSource[]) => Promise<boolean>,
    loaded?: (sources: SearchIndexSource[]) => void,
  ): Promise<boolean> {
    const response = await runAppWorkerTask('search.index', request);
    void persistSearchIndexes(response.persist);
    if (!response.accepted || request.sessionId !== this.workerSession) return false;
    if (loaded) {
      const unresolved = (response.unresolved ?? []).map(entry => entry.source);
      const sources: SearchIndexSource[] = [];
      if (request.cachedMovies && unresolved.indexOf('movies') < 0) sources.push('movies');
      if (request.cachedSeries && unresolved.indexOf('series') < 0) sources.push('series');
      loaded(sources);
    }
    if (response.loaded) {
      this.indexStats.persisted += response.loaded.persisted;
      this.indexStats.built += response.loaded.built;
    }
    const unresolved = response.unresolved;
    if (!unresolved?.length) return true;
    for (const entry of unresolved) {
      log.info(
        'Search index cache unavailable; posting documents',
        'event=search.worker.cache.fallback',
        `session=${String(request.sessionId)}`,
        `source=${entry.source}`,
        `reason=${entry.reason}`,
      );
    }
    return post(unresolved.map(entry => entry.source));
  }

  // The worker stages one sequence per source, so posts of a source take
  // turns; one replaced by a newer post ends early and shares its outcome.
  private postSource(
    sessionId: number,
    source: SearchIndexSource,
    total: number,
    documentAt: (index: number) => string[] | string,
  ): Promise<boolean> {
    const previous = this.sourcePosts[source];
    if (total && this.pendingIndex && sessionId === this.workerSession) this.indexStats.posted++;
    let sent = (): void => undefined;
    const post: SourcePost = {
      id: ++this.sourcePostId,
      sent: new Promise<void>(resolve => { sent = resolve; }),
      result: Promise.resolve(false),
    };
    this.sourcePosts[source] = post;
    post.result = (async (): Promise<boolean> => {
      let posts: Promise<boolean>[] | null;
      try {
        if (previous) await previous.sent;
        posts = await this.postChunks(post.id, sessionId, source, total, documentAt);
      } finally {
        sent();
      }
      if (!posts) return this.sourcePosts[source]!.result;
      const accepted = await Promise.all(posts);
      return accepted.length > 0 && accepted.every(Boolean) && sessionId === this.workerSession;
    })();
    return post.result;
  }

  // Post a source in slices, one per frame, so no single message clones
  // enough text to stall an animation. null: a newer post replaced this one.
  private async postChunks(
    id: number,
    sessionId: number,
    source: SearchIndexSource,
    total: number,
    documentAt: (index: number) => string[] | string,
  ): Promise<Promise<boolean>[] | null> {
    const size = CONFIG.SEARCH.INDEX_CHUNK_SIZE;
    const posts: Promise<boolean>[] = [];
    let start = 0;
    do {
      if (start > 0) await nextFrame();
      if (this.sourcePosts[source]?.id !== id) {
        void Promise.all(posts).catch(() => undefined);
        return null;
      }
      if (sessionId !== this.workerSession) break;
      const end = Math.min(total, start + size);
      const chunk: SearchIndexChunk = { source, start, total };
      if (source === 'movies' || source === 'series') {
        const names: string[] = [];
        for (let index = start; index < end; index++) names.push(documentAt(index) as string);
        chunk.names = names;
      } else {
        const documents: string[][] = [];
        for (let index = start; index < end; index++) documents.push(documentAt(index) as string[]);
        chunk.documents = documents;
      }
      posts.push(this.indexWorker({ sessionId, chunk }));
      start = end;
    } while (start < total);
    return posts;
  }

  private startQuery(generation: number, preserveOffsets = false): Promise<void> {
    return this.runWorkerQuery(generation, preserveOffsets).catch(error => {
      log.error(
        'Search result update failed',
        'event=search.results.update.failed',
        error,
      );
    });
  }

  private async runWorkerQuery(generation: number, preserveOffsets: boolean): Promise<void> {
    const query = this.query;
    const sessionId = this.workerSession;
    if (!query.trim()) return;
    if (this.channelsLoading) {
      this.render();
      return;
    }
    if (this.pendingIndex) {
      // The ready index runs this query; until then the hint stands in.
      if (!this.indexStats.hintAt) this.indexStats.hintAt = Date.now();
      this.render();
      this.applyPendingFocus();
      return;
    }
    if (!preserveOffsets) {
      this.queryPending = true;
      this.render();
    }
    let response: SearchQueryResponse | null = null;
    let recoveryAttempted = false;
    // A rebuild failed recently: rank on the main thread, quietly, until the delay passes.
    let retryPending = false;
    const lists = this.indexedLists();
    try {
      if (this.workerIndexLost) {
        recoveryAttempted = true;
        retryPending = this.recoveryRetryPending(sessionId);
        if (!retryPending) response = await this.recoverWorkerQuery(sessionId, query, 'lost');
      } else {
        response = await runAppWorkerTask('search.query', this.queryRequest(sessionId, query));
      }
    } catch (error) {
      if (generation !== this.queryGeneration || sessionId !== this.workerSession || !this.active) return;
      recoveryAttempted = true;
      retryPending = this.recoveryRetryPending(sessionId);
      if (!retryPending) {
        log.error(
          'Search worker query failed; rebuilding its index',
          'event=search.worker.query.failed',
          'scope=unified',
          `session=${String(sessionId)}`,
          error,
        );
        response = await this.recoverWorkerQuery(sessionId, query, 'query_failed');
      }
    }
    if (generation !== this.queryGeneration || sessionId !== this.workerSession || !this.active) {
      return;
    }
    if (!response && !recoveryAttempted) {
      retryPending = this.recoveryRetryPending(sessionId);
    }
    if (!response && !recoveryAttempted && !retryPending) {
      log.warn(
        'Search worker lost its index; rebuilding it',
        'event=search.worker.index.missing',
        'scope=unified',
        `session=${String(sessionId)}`,
      );
      response = await this.recoverWorkerQuery(sessionId, query, 'missing');
      if (generation !== this.queryGeneration || sessionId !== this.workerSession || !this.active) {
        return;
      }
    }
    if (response && !sameLists(lists, this.indexedLists())) {
      // The lists changed under the reply, so its indices may not map onto them.
      return this.runWorkerQuery(generation, preserveOffsets);
    }
    if (response) {
      this.applyQueryResponse(response, this.indexedVod, this.indexedSeries);
    } else {
      if (!retryPending) {
        log.warn(
          'Worker search failed; using main-thread fallback',
          'event=search.worker.fallback.used',
          'scope=unified',
          `session=${String(sessionId)}`,
        );
      }
      this.applyQueryResponse(this.queryLocally(query), this.allVod, this.allSeries);
    }
    this.queryPending = false;
    if (!preserveOffsets) this.resetVirtualOffsets();
    this.render();
    this.applyPendingFocus();
  }

  private queryRequest(sessionId: number, query: string): SearchQueryRequest {
    return {
      sessionId,
      query,
      limit: this.resultLimit,
      includeCatalog: !!this.account,
      fuzzyBelow: CONFIG.SEARCH.INITIAL_RESULTS,
      boost: this.boost(this.indexedVod, this.indexedSeries),
    };
  }

  // Recently watched and favorite items rank first within their match tier,
  // as indices into the given lists.
  private boost(vod: VodItem[], series: SeriesItem[]): SearchQueryBoost {
    const channelIndices = new Set<number>();
    for (const channel of PlaylistService.getByGroup('builtin:favorites')) {
      channelIndices.add(PlaylistService.indexOf(channel));
    }
    for (const entry of StorageService.getRecentlyWatchedLive()) {
      const resolved = PlaylistService.resolveChannelKey(entry.channelKey);
      if (resolved) channelIndices.add(resolved.channelIndex);
    }
    const movieIds = new Set<string>();
    const seriesIds = new Set<string>();
    const account = this.account;
    if (account) {
      for (const entry of StorageService.getResumeList(account.id)) {
        if (entry.kind === 'vod') movieIds.add(entry.itemId);
        else if (entry.watchlistOwner) seriesIds.add(entry.watchlistOwner.itemId);
      }
      for (const entry of StorageService.getWatchlist(account.id, 'vod')) movieIds.add(entry.itemId);
      for (const entry of StorageService.getWatchlist(account.id, 'series')) seriesIds.add(entry.itemId);
    }
    return {
      channels: Array.from(channelIndices).filter(index => index >= 0),
      movies: this.indicesOfIds(vod, movieIds, item => item.streamId),
      series: this.indicesOfIds(series, seriesIds, item => item.seriesId),
    };
  }

  private indicesOfIds<T>(items: T[], ids: Set<string>, idOf: (item: T) => string): number[] {
    if (!ids.size || !items.length) return [];
    let byId = this.idIndexes.get(items);
    if (!byId) {
      byId = new Map();
      for (let index = 0; index < items.length; index++) byId.set(idOf(items[index]), index);
      this.idIndexes.set(items, byId);
    }
    const indices: number[] = [];
    ids.forEach((id) => {
      const index = byId!.get(id);
      if (index !== undefined) indices.push(index);
    });
    return indices;
  }

  private queryLocally(query: string): SearchQueryResponse {
    const boost = this.boost(this.allVod, this.allSeries);
    const boostedChannels = new Set(boost.channels.map(index => PlaylistService.channels[index]));
    const boostedMovies = new Set(boost.movies.map(index => this.allVod[index]));
    const boostedSeries = new Set(boost.series.map(index => this.allSeries[index]));
    const fuzzyBelow = CONFIG.SEARCH.INITIAL_RESULTS;
    const channels = PlaylistService.searchLocalRanked(query, this.resultLimit, undefined, {
      fuzzyBelow,
      boosted: channel => boostedChannels.has(channel),
    });
    const programmes = rankPreparedTopK(
      prepareSearchItems(this.programIndex, programDocument),
      query,
      this.resultLimit,
      true,
      { fuzzyBelow },
    );
    const empty = { items: [], hasMore: false, total: 0 };
    const movies = this.account
      ? rankPreparedNamesTopK(prepareNameSearchItems(this.allVod), query, this.resultLimit,
        { boosted: item => boostedMovies.has(item) })
      : empty;
    const series = this.account
      ? rankPreparedNamesTopK(prepareNameSearchItems(this.allSeries), query, this.resultLimit,
        { boosted: item => boostedSeries.has(item) })
      : empty;
    return {
      channels: {
        indices: channels.items.map(channel => PlaylistService.indexOf(channel)),
        hasMore: channels.hasMore,
        total: channels.total,
      },
      programmes: {
        indices: indicesOf(this.programIndex, programmes.items),
        hasMore: programmes.hasMore,
        total: programmes.total,
      },
      movies: {
        indices: indicesOf(this.allVod, movies.items),
        hasMore: movies.hasMore,
        total: movies.total,
      },
      series: {
        indices: indicesOf(this.allSeries, series.items),
        hasMore: series.hasMore,
        total: series.total,
      },
    };
  }

  private indexedLists(): unknown[] {
    return [PlaylistService.channels, this.programIndex, this.indexedVod, this.indexedSeries];
  }

  private async recoverWorkerQuery(
    sessionId: number,
    query: string,
    reason: string,
  ): Promise<SearchQueryResponse | null> {
    const startedAt = Date.now();
    try {
      let recovery = this.recovery;
      const owner = !recovery || recovery.sessionId !== sessionId;
      if (!recovery || owner) {
        const rebuilt = this.rebuildWorkerIndex(sessionId);
        const current = { sessionId, done: rebuilt };
        const clear = (): void => {
          if (this.recovery === current) this.recovery = null;
        };
        // Recorded before any query waiting on the rebuild resumes.
        const failed = (): void => this.recoveryFailed(sessionId);
        rebuilt.then(done => { if (!done) failed(); }, failed);
        current.done.then(clear, clear);
        this.recovery = current;
        recovery = current;
      }
      if (!await recovery.done) return null;
      const response = await runAppWorkerTask('search.query', this.queryRequest(sessionId, query));
      if (response && owner) {
        log.info(
          'Search worker recovery completed',
          'event=search.worker.recovery.completed',
          'scope=unified',
          `session=${String(sessionId)}`,
          `reason=${reason}`,
          `elapsedMs=${String(Date.now() - startedAt)}`,
        );
      }
      return response;
    } catch (error) {
      const retry = this.recoveryRetry;
      if (retry?.sessionId === sessionId) {
        if (retry.logged) return null;
        retry.logged = true;
      }
      log.error(
        'Search worker recovery failed',
        'event=search.worker.recovery.failed',
        'scope=unified',
        `session=${String(sessionId)}`,
        `reason=${reason}`,
        error,
      );
      return null;
    }
  }

  private recoveryRetryPending(sessionId: number): boolean {
    const retry = this.recoveryRetry;
    // A new worker replaced the one the rebuild failed on, so it may succeed now.
    return !!retry
      && retry.sessionId === sessionId
      && retry.generation === appWorkerGeneration()
      && performance.now() < retry.at;
  }

  private recoveryFailed(sessionId: number): void {
    if (sessionId !== this.workerSession) return;
    const retry = this.recoveryRetry;
    this.recoveryRetry = {
      sessionId,
      at: performance.now() + CONFIG.SEARCH.INDEX_RETRY_DELAY_MS,
      generation: appWorkerGeneration(),
      logged: retry?.sessionId === sessionId && retry.logged,
    };
  }

  private async rebuildWorkerIndex(sessionId: number): Promise<boolean> {
    // Its reset would wipe the newer session's index.
    if (sessionId !== this.workerSession) return false;
    // Partial until every source below is in: no refresh may mark it ready
    // or a reopen reuse it, and queries wait for this rebuild.
    this.invalidateWorkerIndex();
    this.workerIndexLost = true;
    if (!await this.indexWorker({ sessionId, reset: true })) return false;
    // Any list may be replaced meanwhile, and a newer post of a source may
    // carry an older list: post until the worker holds the current lists,
    // each from this rebuild's own post.
    const posted: Partial<Record<SearchIndexSource, { list: unknown[]; post?: SourcePost }>> = {};
    let channels: Channel[];
    let changed: boolean;
    do {
      changed = false;
      const current = PlaylistService.channels;
      const programs = this.programIndex;
      const movies = this.allVod;
      const series = this.allSeries;
      channels = current;
      const sources: Array<[SearchIndexSource, unknown[], (index: number) => string[] | string]> = [
        ['channels', current, index => channelDocument(current[index])],
        ['programmes', programs, index => programDocument(programs[index])],
        ['movies', movies, index => movies[index].name],
        ['series', series, index => series[index].name],
      ];
      for (const [source, list, documentAt] of sources) {
        const last = posted[source];
        if (last && last.list === list && last.post === this.sourcePosts[source]) continue;
        changed = true;
        const result = this.postSource(sessionId, source, list.length, documentAt);
        const post = this.sourcePosts[source];
        if (!await result || sessionId !== this.workerSession) return false;
        posted[source] = { list, post };
        if (this.sourcePosts[source] !== post) continue;
        if (source === 'movies') this.indexedVod = movies;
        if (source === 'series') this.indexedSeries = series;
      }
    } while (changed);
    // A post lost meanwhile left its source changed, so the loop reposted it.
    this.workerIndexLost = false;
    this.recoveryRetry = null;
    this.workerChannels = channels;
    this.markWorkerIndexReady(this.account);
    return true;
  }

  private applyQueryResponse(
    response: SearchQueryResponse,
    vod: VodItem[],
    series: SeriesItem[],
  ): void {
    this.visibleChannels = itemsAt(PlaylistService.channels, response.channels.indices);
    this.visiblePrograms = itemsAt(this.programIndex, response.programmes.indices);
    this.visibleMovies = itemsAt(vod, response.movies.indices);
    this.visibleSeries = itemsAt(series, response.series.indices);
    this.totals = {
      channels: response.channels.total ?? this.visibleChannels.length,
      programmes: response.programmes.total ?? this.visiblePrograms.length,
      movies: response.movies.total ?? this.visibleMovies.length,
      series: response.series.total ?? this.visibleSeries.length,
    };
    this.hasMoreResults = response.channels.hasMore || response.programmes.hasMore
      || response.movies.hasMore || response.series.hasMore;
  }

  private clearResults(): void {
    this.visibleChannels = [];
    this.visiblePrograms = [];
    this.visibleMovies = [];
    this.visibleSeries = [];
    this.totals = { channels: 0, programmes: 0, movies: 0, series: 0 };
    this.hasMoreResults = false;
    this.queryPending = false;
    this.resetVirtualOffsets();
  }

  private canReuseWorkerIndex(account: PlaylistEntry | null): boolean {
    return this.workerIndexReady
      && !this.workerIndexLost
      && this.workerIndexedChannels === PlaylistService.channels
      && this.workerIndexedProgrammes === EpgService.programmes
      && this.workerIndexedAccountId === (account?.id ?? null)
      && (!account
        || (this.loadedFor === account.id
          && this.workerIndexedVod === this.allVod
          && this.workerIndexedSeries === this.allSeries));
  }

  private markWorkerIndexReady(account: PlaylistEntry | null): void {
    this.workerIndexReady = true;
    // What the worker holds: the channels posted and the guide data the
    // posted program index was built from, which can trail the services'.
    this.workerIndexedChannels = this.workerChannels;
    this.workerIndexedProgrammes = this.indexedChannels === this.workerChannels
      ? this.indexedProgrammes
      : null;
    this.workerIndexedAccountId = account?.id ?? null;
    this.workerIndexedGeneration = this.workerResetGeneration;
    // What the worker holds, which trails allVod/allSeries while a refresh posts.
    this.workerIndexedVod = this.indexedVod;
    this.workerIndexedSeries = this.indexedSeries;
    log.info(
      'Search worker index ready',
      'event=search.worker.index.ready',
      'scope=unified',
      `session=${String(this.workerSession)}`,
      `channels=${String(PlaylistService.channels.length)}`,
      `programmes=${String(this.programIndex.length)}`,
      `movies=${String(this.allVod.length)}`,
      `series=${String(this.allSeries.length)}`,
    );
  }

  private invalidateWorkerIndex(): void {
    const wasReady = this.workerIndexReady;
    this.workerIndexReady = false;
    this.workerIndexedChannels = null;
    this.workerIndexedProgrammes = null;
    this.workerIndexedAccountId = null;
    this.workerIndexedGeneration = null;
    this.workerIndexedVod = null;
    this.workerIndexedSeries = null;
    if (wasReady) {
      log.debug(
        'Search worker index invalidated',
        'event=search.worker.index.released',
        'scope=unified',
        `session=${String(this.workerSession)}`,
      );
    }
  }

  private programCard(result: ProgramResult, index: number): Safe {
    const { channel, programme } = result;
    const now = Date.now();
    const state = programme.stop.getTime() <= now ? 'past' : programme.start.getTime() > now ? 'future' : 'live';
    const day = formatDayLabel(programme.start);
    const action = state === 'live'
      ? t('search.liveNow')
      : state === 'future'
        ? (ReminderService.has(channelKey(channel), programme.start.getTime()) ? t('search.reminderSet') : t('search.setReminder'))
        : XtreamArchiveService.isAvailable(channel, programme.start.getTime()) ? t('search.catchUp') : t('search.openChannel');
    return html`
      <div class="search-card search-program-card state-${state}" data-focusable
           data-key="p:${String(result.channelIndex)}:${String(programme.start.getTime())}"
           data-program-index="${String(index)}">
        <div class="search-card-text">
          <div class="search-card-title">${this.highlighted(programme.title)}</div>
          <div class="search-card-sub">${day.weekday} ${day.date} ${formatTime(programme.start)} · ${channel.name}</div>
          <div class="search-program-action">${action}</div>
        </div>
      </div>
    `;
  }

  private async activateProgram(index: number, query: string): Promise<void> {
    const result = this.visiblePrograms[index];
    if (!result) return;
    const { channel, programme } = result;
    const now = Date.now();
    if (programme.start.getTime() > now) {
      const key = channelKey(channel);
      const startMs = programme.start.getTime();
      if (ReminderService.has(key, startMs)) {
        ReminderService.remove(key, startMs);
        showToast(t('epg.reminderRemoved'));
      } else {
        ReminderService.add({
          channelKey: key,
          channelName: channel.name,
          playlistIds: channel.playlistIds.slice(),
          epgSourceUrl: EpgService.getSourceUrl(channel) ?? undefined,
          title: programme.title,
          startMs,
          stopMs: programme.stop.getTime(),
        });
        showToast(t('epg.reminderSet'));
      }
      this.render();
      return;
    }

    if (programme.stop.getTime() <= now && channel.catchupAccountId && channel.catchupStreamId) {
      await XtreamArchiveService.load(channel);
      if (!XtreamArchiveService.isAvailable(channel, programme.start.getTime())) {
        showToast(t('epg.catchupUnavailable'));
        this.render();
        return;
      }
    }

    if (programme.stop.getTime() <= now &&
        XtreamArchiveService.isAvailable(channel, programme.start.getTime())) {
      const key = channelKey(channel);
      const startMs = programme.start.getTime();
      const progress = StorageService.getCatchupProgressList(
        key,
        undefined,
        legacyChannelKey(channel),
      )
        .find(entry => entry.progStart === startMs && !entry.completed);
      if (progress) {
        this.resumePrompt.show(programme.title, progress.position, {
          onResume: () => this.playProgram(result, query, progress.position),
          onStartOver: () => {
            StorageService.clearCatchupProgress(key, startMs);
            this.playProgram(result, query);
          },
          onCancel: () => { /* keep Search open */ },
        });
        return;
      }
    }
    this.playProgram(result, query);
  }

  private playProgram(result: ProgramResult, query: string, resumeSecs?: number): void {
    const { channel, channelIndex, programme } = result;
    rememberQuery(query, liveParentalRequest(channel));
    let catchup: CatchupInfo | undefined;
    if (programme.stop.getTime() <= Date.now() &&
        XtreamArchiveService.isAvailable(channel, programme.start.getTime())) {
      catchup = {
        start: Math.floor(programme.start.getTime() / 1000),
        end: Math.floor(programme.stop.getTime() / 1000),
        title: programme.title,
        description: programme.description,
        icon: programme.icon,
        epgSourceUrl: EpgService.getSourceUrl(channel) ?? undefined,
        resumeSecs,
      };
    }
    this.handlers.onPlayChannel(channelIndex, catchup);
  }

  private render(): void {
    const q = this.query.trim();
    const hasResults = this.visibleChannels.length > 0 || this.visiblePrograms.length > 0
      || this.visibleMovies.length > 0 || this.visibleSeries.length > 0;
    this.indicator.set(!q || this.channelsLoading ? null
      : this.pendingIndex ? 'preparing' : this.queryPending ? 'searching' : null);
    const resultsBody = this.channelsLoading
      ? html`
          <div class="search-busy" role="status" data-search-busy="channels">
            <span class="search-busy-spinner" aria-hidden="true"></span>
            <span class="search-busy-text">${t('app.loadingChannels')}</span>
          </div>`
      : !q
      ? this.recentSection()
      : this.pendingIndex || this.queryPending
        ? this.busyIndicator()
        : !hasResults
            ? html`<p class="search-hint">${t('search.empty')}</p>`
            : html`
                ${this.visibleChannels.length
                  ? this.virtualRail(t('common.channels'), 'channels', this.visibleChannels,
                    this.channelVirtualizer, (ch) => this.channelCard(ch))
                  : ''}
                ${this.visiblePrograms.length
                  ? this.virtualRail(t('search.programs'), 'programmes', this.visiblePrograms,
                    this.programVirtualizer, (result, index) => this.programCard(result, index))
                  : ''}
                ${this.visibleMovies.length
                  ? this.virtualRail(t('common.movies'), 'movies', this.visibleMovies,
                    this.movieVirtualizer, (v) => this.movieTile(v))
                  : ''}
                ${this.visibleSeries.length
                  ? this.virtualRail(t('common.series'), 'series', this.visibleSeries,
                    this.seriesVirtualizer, (series) => this.seriesTile(series))
                  : ''}
              `;

    // The query box sits above, outside this container; this renders results only.
    morph(this.container, html`
      <div class="search-view" data-nav-container data-search-query="${q}"
           data-search-pending="${this.queryPending ? 'true' : 'false'}">
        <div class="search-results">${resultsBody}</div>
      </div>
    `);
    this.restoreVirtualOffsets();
  }

  // A spinner where the results will be, after a short delay; preparing
  // the index says so beside it.
  private busyIndicator(): Safe {
    const busy = this.indicator.shown;
    if (!busy) return html``;
    return html`
      <div class="search-busy" role="status" data-search-busy="${busy}">
        <span class="search-busy-spinner" aria-hidden="true"></span>
        ${busy === 'preparing' ? html`<span class="search-busy-text">${t('search.preparing')}</span>` : ''}
      </div>
    `;
  }

  private createVirtualizer(itemSize: number): VirtualList {
    return new VirtualList({
      itemSize: () => uiPx(itemSize),
      overscan: SEARCH_RAIL_OVERSCAN,
      fallbackViewportSize: SEARCH_RAIL_VIEWPORT,
    });
  }

  private virtualizers(): Record<RailKey, VirtualList> {
    return {
      channels: this.channelVirtualizer,
      programmes: this.programVirtualizer,
      movies: this.movieVirtualizer,
      series: this.seriesVirtualizer,
    };
  }

  private resetVirtualOffsets(): void {
    const virtualizers = this.virtualizers();
    RAIL_KEYS.forEach(key => virtualizers[key].setScrollOffset(0));
    this.container.querySelectorAll<HTMLElement>('[data-search-virtual]').forEach((el) => {
      this.scrollGuard.syncOffset(el, 'horizontal', 0);
    });
  }

  private restoreVirtualOffsets(): void {
    const virtualizers = this.virtualizers();
    RAIL_KEYS.forEach((key) => {
      const el = this.container.querySelector<HTMLElement>(`[data-search-virtual="${key}"]`);
      if (el) this.scrollGuard.syncOffset(el, 'horizontal', virtualizers[key].scrollOffset);
    });
  }

  private onVirtualScroll(event: Event): void {
    const target = event.target as HTMLElement;
    const key = railKey(target.dataset.searchVirtual);
    if (!key) return;
    const virtualizer = this.virtualizers()[key];
    const axis: VirtualScrollAxis = 'horizontal';
    const offset = this.scrollGuard.readUserOffset(target, axis);
    if (offset === null) return;
    virtualizer.setScrollOffset(offset);
    if (this.scrollFrame !== null) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = null;
      const latest = this.scrollGuard.readUserOffset(target, axis);
      if (latest !== null) virtualizer.setScrollOffset(latest);
      const viewport = target.clientWidth;
      const count = this.resultItems(key).length;
      const total = virtualizer.getTotalSize(count);
      if (virtualizer.scrollOffset + viewport >= total - uiPx(RAIL_STRIDES[key]) * 2) {
        this.expandResults();
      }
      if (this.railWindows.get(key) === this.railWindow(
        count,
        virtualizer.getRange(count, target.clientWidth || SEARCH_RAIL_VIEWPORT),
      )) return;
      this.render();
    });
  }

  private railWindow(count: number, range: { start: number; end: number }): string {
    return `${String(count)}:${String(range.start)}:${String(range.end)}`;
  }

  private moveVirtualFocus(action: Action): boolean {
    if (action !== 'left' && action !== 'right') return false;
    const focused = this.nav.focused;
    // Focus a re-render removed recovers through the nav first.
    if (!focused || !this.container.contains(focused)) return false;
    const cell = focused.closest<HTMLElement>('[data-search-section]');
    const key = railKey(cell?.dataset.searchSection);
    const rawIndex = cell?.dataset.searchIndex;
    if (!key || rawIndex === undefined) return false;
    const current = parseInt(rawIndex, 10);
    let next = current + (action === 'left' ? -1 : 1);
    if (next >= this.resultItems(key).length && this.expandResults()) next = current + 1;
    if (next < 0 || next >= this.resultItems(key).length) return false;
    const scroll = this.container.querySelector<HTMLElement>(`[data-search-virtual="${key}"]`);
    this.virtualizers()[key].ensureVisible(next, this.railContentWidth(scroll));
    this.render();
    this.nav.focus(
      this.container.querySelector<HTMLElement>(
        `[data-search-section="${key}"][data-search-index="${next}"] [data-focusable]`,
      ),
    );
    return true;
  }

  // Item offsets start after the rail's padding, so a tile kept in view
  // rests on the left keyline and clears the right edge's ring gutter.
  private railContentWidth(rail: HTMLElement | null): number {
    if (!rail?.clientWidth) return SEARCH_RAIL_VIEWPORT;
    const style = getComputedStyle(rail);
    return rail.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  }

  private resultItems(key: RailKey): unknown[] {
    if (key === 'channels') return this.visibleChannels;
    if (key === 'programmes') return this.visiblePrograms;
    if (key === 'movies') return this.visibleMovies;
    return this.visibleSeries;
  }

  private expandResults(): boolean {
    if (!this.hasMoreResults || this.resultLimit >= CONFIG.SEARCH.RESULT_CAP
        // A scroll keeps asking each frame until the batch it asked for lands.
        || this.expandingGeneration === this.queryGeneration) {
      return false;
    }
    this.resultLimit = Math.min(
      CONFIG.SEARCH.RESULT_CAP,
      this.resultLimit * CONFIG.SEARCH.EXPANSION_FACTOR,
    );
    const generation = ++this.queryGeneration;
    this.expandingGeneration = generation;
    const settle = (): void => {
      if (this.expandingGeneration === generation) this.expandingGeneration = null;
    };
    this.startQuery(generation, true).then(settle, settle);
    return true;
  }

  private cancelScheduledQuery(): void {
    this.queryGeneration++;
    if (this.queryFrame !== null) cancelAnimationFrame(this.queryFrame);
    this.queryFrame = null;
  }
}

function sameLists(before: unknown[], after: unknown[]): boolean {
  return before.every((list, index) => list === after[index]);
}

function itemsAt<T>(items: T[], indices: number[]): T[] {
  const selected: T[] = [];
  for (const index of indices) {
    const item = items[index];
    if (item !== undefined) selected.push(item);
  }
  return selected;
}

function indicesOf<T>(items: T[], selected: T[]): number[] {
  const byItem = new Map<T, number>();
  for (let index = 0; index < items.length; index++) byItem.set(items[index], index);
  return selected.map(item => byItem.get(item) ?? -1);
}

// A query that led to PIN-guarded content stays out of recent searches, which
// anyone can see once the session is locked again (or the PIN was canceled).
function rememberQuery(query: string, request: Parameters<typeof ParentalControlService.protects>[0]): void {
  if (!ParentalControlService.protects(request)) StorageService.addSearchHistory(query);
}
