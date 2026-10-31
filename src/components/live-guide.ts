import type { Action, CatchupInfo, CatchupProgressEntry, Channel, ChannelScope, Programme } from '../types';
import { Focus, type FocusScope } from '../navigation/focus-scope';
import { html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { channelKey, legacyChannelKey } from '../utils/channel';
import { addDisplayDays, displayDayKey, formatDayLabel, formatTime } from '../utils/time';
import { uiPx, uiTextPx } from '../utils/ui-scale';
import { PlaylistService } from '../services/playlist-service';
import { EpgService } from '../services/epg-service';
import { ReminderService } from '../services/reminder-service';
import { StorageService } from '../services/storage-service';
import { XtreamArchiveService } from '../services/xtream-archive';
import { ChannelCustomizationService } from '../services/channel-customization';
import { CatchupResumePrompt } from './catchup-resume-prompt';
import { activateProgram } from './guide-actions';
import { bellIcon, NAV_HORIZONTAL_ICON, NOW_PLAYING_ICON, REPLAY_ICON } from './icons';
import { backKey, okHint } from './key-hints';
import { channelLockBadge } from './parental-badge';
import { t } from '../i18n';
import {
  GUIDE_SPAN_MS,
  HALF_HOUR_MS,
  alignHalfHour,
  cellBox,
  clampWindow,
  emptySlot,
  firstRowFor,
  initialWindowStart,
  pageTo,
  programAt,
  step,
} from './live-guide-math';

// Mirrors css/live-guide.css: an 80px row plus an 8px gap.
const ROW_STRIDE = 88;
const BODY_FALLBACK = 824;
// Programs read around the focus for moving along a row.
const LOOKAROUND_MS = 12 * 60 * 60 * 1000;
const AHEAD_DAYS = 7;

export interface LiveGuideOptions {
  // The group and source the Live list shows.
  scope: () => ChannelScope;
  // Watch a channel (live, or a program's catch-up).
  play: (index: number, catchup?: CatchupInfo, scope?: ChannelScope) => void;
  // The channel playing full screen, marked in the channel column.
  watching: () => number;
  // Off the grid's left (the past ends) or Back: the groups column.
  onLeaveLeft: () => void;
  // Up off the first row: the Live header.
  onLeaveUp: () => void;
}

interface Cell {
  start: number;
  stop: number;
  program: Programme | null;
}

// The Guide inside Pleione's Live: a channel column and a time grid of about
// two and a half hours. Left and Right move through programs, paging the
// window by half hours; Up and Down move through channels. Rows are
// virtualized, and only programs inside the window are drawn.
export class LiveGuide {
  readonly focusScope: FocusScope;
  private readonly prompt = new CatchupResumePrompt('prompt.live-guide');
  private channels: Channel[] = [];
  private row = 0;
  private time = 0;
  private windowStart = 0;
  private firstRow = 0;
  private shown = false;

  constructor(private readonly container: HTMLElement, private readonly options: LiveGuideOptions) {
    this.focusScope = Focus.register({
      id: 'live.guide',
      root: container,
      defaultKey: () => this.focusKey(),
      reveal: () => null,
    });
    container.setAttribute('data-self-activate', '');
    container.addEventListener('nav:hover', (e: Event) => {
      const cell = (e.target as Element | null)?.closest<HTMLElement>('[data-guide-cell]');
      if (!cell || !this.pick(cell)) return;
      this.focusScope.focus(this.focusKey(), 'pointer');
    });
    container.addEventListener('click', (e: MouseEvent) => {
      const cell = (e.target as Element | null)?.closest<HTMLElement>('[data-guide-cell]');
      if (!cell || !this.pick(cell)) return;
      this.render();
      this.focusScope.focus(this.focusKey(), 'pointer');
      void this.activate();
    });
  }

  get isShown(): boolean { return this.shown; }
  get isPromptVisible(): boolean { return this.prompt.visible; }

  dismissPrompt(): void {
    if (this.prompt.visible) this.prompt.hide();
  }

  /** Show the Guide on the current time, on `index`'s row when it is listed. */
  show(index: number): void {
    this.shown = true;
    const now = Date.now();
    this.windowStart = initialWindowStart(now);
    this.time = now;
    this.channels = this.listedChannels();
    const at = this.channels.findIndex(ch => PlaylistService.indexOf(ch) === index);
    this.row = at >= 0 ? at : Math.min(this.row, Math.max(0, this.channels.length - 1));
    this.firstRow = 0;
    this.render();
  }

  hide(): void {
    this.shown = false;
    this.dismissPrompt();
  }

  /** The Live list's group changed: start at its first channel. */
  groupChanged(): void {
    this.channels = this.listedChannels();
    this.row = 0;
    this.firstRow = 0;
    this.render();
  }

  /** Take the keys on the focused cell. */
  enter(): void {
    this.render();
    this.focusScope.focus(this.focusKey(), 'key');
  }

  /** False when the key leaves the grid (the host takes it). */
  handleAction(action: Action): boolean {
    if (!this.channels.length) {
      if (action === 'left' || action === 'back') this.options.onLeaveLeft();
      else if (action === 'up') this.options.onLeaveUp();
      return action !== 'red';
    }
    switch (action) {
      case 'up':
        if (this.row === 0) {
          this.options.onLeaveUp();
          return true;
        }
        this.moveRow(-1);
        break;
      case 'down':
        this.moveRow(1);
        break;
      case 'channel_up':
        this.moveRow(-this.visibleRows());
        break;
      case 'channel_down':
        this.moveRow(this.visibleRows());
        break;
      case 'left':
        if (!this.moveTime(-1)) {
          this.options.onLeaveLeft();
          return true;
        }
        break;
      case 'right':
        this.moveTime(1);
        break;
      case 'back':
        this.options.onLeaveLeft();
        return true;
      case 'select':
        void this.activate();
        return true;
      default:
        return false;
    }
    this.render();
    this.focusScope.focus(this.focusKey(), 'key');
    return true;
  }

  render(): void {
    if (!this.shown) return;
    if (!this.channels.length) this.channels = this.listedChannels();
    const now = Date.now();
    const visible = this.visibleRows();
    this.firstRow = firstRowFor(this.firstRow, this.row, visible, this.channels.length);
    const rows = this.channels.slice(this.firstRow, this.firstRow + visible + 1);
    const stride = uiTextPx(ROW_STRIDE);
    const nowLeft = cellBox(now, now + 1, this.windowStart, 100);
    const focus = this.focusedCell();
    const focusKey = this.focusKey();
    morph(this.container, html`
      <div class="guide">
        <div class="guide-ruler" data-key="ruler">
          <div class="guide-day">${this.dayLabel()}</div>
          <div class="guide-times">
            ${this.halfHours().map(time => html`
              <span class="guide-time" data-key="time:${time}"
                    style="left:${(time - this.windowStart) / GUIDE_SPAN_MS * 100}%">${formatTime(new Date(time))}</span>`)}
            ${nowLeft ? html`<span class="guide-now-pill" data-key="now-pill"
                    style="left:${nowLeft.left}%">${formatTime(new Date(now))}</span>` : ''}
          </div>
        </div>
        <div class="guide-body" data-key="body">
          ${nowLeft ? html`<div class="guide-now-line" data-key="now-line"><i style="left:${nowLeft.left}%"></i></div>` : ''}
          ${rows.map((channel, offset) => this.renderRow(channel, this.firstRow + offset,
            (offset) * stride, now))}
          ${this.channels.length ? '' : html`<div class="empty-state">${t('channel.empty')}</div>`}
        </div>
      </div>
      <div class="live-legend guide-legend" data-key="legend">
        ${this.okLabel(focus, now) ? okHint(this.okLabel(focus, now)) : ''}
        <span class="edit-hint">${raw(NAV_HORIZONTAL_ICON)}<span>${t('live.earlierLater')}</span></span>
        <span class="edit-hint">${backKey()}<span>${t('common.groups')}</span></span>
        <span class="edit-hint"><span class="edit-key key-red"></span><span>${t('live.list')}</span></span>
      </div>
    `);
    this.focusScope.track(focusKey);
  }

  private renderRow(channel: Channel, position: number, top: number, now: number): Safe {
    const index = PlaylistService.indexOf(channel);
    const cells = this.cellsFor(channel);
    // Catch-up already watched, by program start, for the resume markers.
    const watched = channel.catchupSource
      ? new Map(StorageService.getCatchupProgressList(channelKey(channel), undefined, legacyChannelKey(channel))
        .map(entry => [entry.progStart, entry]))
      : null;
    return html`
      <div class="guide-row ${ChannelCustomizationService.isChannelHidden(channel) ? 'hidden-entry' : ''}"
           data-key="row:${index}" style="top:${top}px">
        <div class="guide-channel ${index === this.options.watching() ? 'watching' : ''}">
          <span class="guide-number">${index + 1}</span>
          <span class="channel-logo-wrap">${channel.logo
            ? html`<img class="channel-logo" src="${channel.logo}" alt="">`
            : html`<span class="channel-logo-placeholder">${channel.name.charAt(0)}</span>`}</span>
          <span class="guide-name">${raw(channelLockBadge(channel))}${channel.name}</span>
          ${index === this.options.watching()
            ? html`<span class="live-badge-icon live-badge-watching">${raw(NOW_PLAYING_ICON)}</span>` : ''}
        </div>
        <div class="guide-cells">
          ${cells.map((cell, i) => this.renderCell(channel, index, position, cell, now,
            i === 0 && !cells.some(item => item.program), watched?.get(cell.start)))}
        </div>
      </div>`;
  }

  // `noData`: the row's first cell says the row has no guide; other empty
  // slots stay blank. `watched`: how much of a past program's catch-up was seen.
  private renderCell(
    channel: Channel, index: number, position: number, cell: Cell, now: number, noData: boolean,
    watched?: CatchupProgressEntry,
  ): Safe | string {
    const box = cellBox(cell.start, cell.stop, this.windowStart, 100);
    if (!box) return '';
    const state = cell.stop <= now ? 'past' : cell.start <= now ? 'live' : 'future';
    const program = cell.program;
    const reminder = !!program && state === 'future'
      && ReminderService.has(channelKey(channel), cell.start);
    const catchup = !!program && state !== 'future'
      && XtreamArchiveService.isAvailable(channel, cell.start);
    const progress = state === 'live' ? (now - cell.start) / (cell.stop - cell.start) : 0;
    const resume = catchup && watched ? watched : null;
    const seen = resume && !resume.completed && resume.duration > 0
      ? Math.min(100, Math.max(0, Math.round(resume.position / resume.duration * 100))) : 0;
    return html`
      <div class="guide-cell ${state} ${program ? '' : 'empty'} ${reminder ? 'reminder' : ''}"
           data-key="${this.cellKey(index, cell)}" data-focusable data-guide-cell
           data-row="${position}" data-time="${cell.start}"
           style="left:${box.left}%;width:${box.width}%">
        <span class="guide-cell-title">${catchup ? raw(REPLAY_ICON) : ''}${reminder ? raw(bellIcon(true)) : ''}<span>${
          program ? program.title : noData ? t('epg.noData') : ''}</span></span>
        ${program ? html`<span class="guide-cell-time">${formatTime(program.start)}–${formatTime(program.stop)}</span>` : ''}
        ${resume ? html`<span class="guide-cell-badge ${resume.completed ? 'watched' : 'resume'}">${
          t(resume.completed ? 'epg.watched' : 'common.resume')}</span>` : ''}
        ${state === 'live' && program ? html`<i class="guide-cell-progress" style="width:${Math.round(progress * 100)}%"></i>` : ''}
        ${seen ? html`<i class="guide-cell-progress resume" style="width:${seen}%"></i>` : ''}
      </div>`;
  }

  private okLabel(cell: Cell | null, now: number): string {
    if (!cell) return '';
    if (cell.start > now) return cell.program ? t('epg.reminder') : '';
    if (cell.stop > now) return t('live.watch');
    const channel = this.channels[this.row];
    return cell.program && channel && XtreamArchiveService.isAvailable(channel, cell.start)
      ? t('live.watch') : '';
  }

  private dayLabel(): string {
    const start = new Date(this.windowStart);
    const day = displayDayKey(start);
    const today = new Date();
    if (day === displayDayKey(today)) return t('common.today');
    if (day === displayDayKey(addDisplayDays(today, 1))) return t('common.tomorrow');
    const label = formatDayLabel(start);
    return `${label.weekday} ${label.date}`;
  }

  private halfHours(): number[] {
    const times: number[] = [];
    for (let time = this.windowStart; time < this.windowStart + GUIDE_SPAN_MS; time += HALF_HOUR_MS) {
      times.push(time);
    }
    return times;
  }

  private listedChannels(): Channel[] {
    const scope = this.options.scope();
    return PlaylistService.getByGroup(scope.group ?? 'builtin:all', scope.playlist);
  }

  private programsAround(channel: Channel, time: number): Programme[] {
    const id = EpgService.findChannelId(channel);
    if (!id) return [];
    return EpgService.getProgrammesIntersectingRange(id, time - LOOKAROUND_MS, time + LOOKAROUND_MS)
      .filter(program => program.stop.getTime() > program.start.getTime());
  }

  private asTimes(programs: Programme[]): { start: number; stop: number; program: Programme }[] {
    return programs.map(program => ({
      start: program.start.getTime(), stop: program.stop.getTime(), program,
    }));
  }

  // The cells a row draws in the window: its programs, and empty slots
  // between them.
  private cellsFor(channel: Channel): Cell[] {
    const end = this.windowStart + GUIDE_SPAN_MS;
    const programs = this.asTimes(this.programsAround(channel, this.windowStart + GUIDE_SPAN_MS / 2));
    const cells: Cell[] = [];
    let time = this.windowStart;
    while (time < end) {
      const program = programAt(programs, time);
      if (program) {
        cells.push(program);
        time = program.stop;
      } else {
        const slot = emptySlot(programs, time);
        cells.push({ start: slot.start, stop: slot.stop, program: null });
        time = slot.stop;
      }
    }
    return cells;
  }

  private lookupTime(): number {
    return Math.max(this.time, this.windowStart);
  }

  private focusedCell(): Cell | null {
    const channel = this.channels[this.row];
    if (!channel) return null;
    const time = this.lookupTime();
    const programs = this.asTimes(this.programsAround(channel, time));
    const program = programAt(programs, time);
    if (program) return program;
    const slot = emptySlot(programs, time);
    return { start: slot.start, stop: slot.stop, program: null };
  }

  private cellKey(index: number, cell: Cell): string {
    return `cell:${index}:${cell.program ? '' : 'e'}${cell.start}`;
  }

  private focusKey(): string | null {
    const channel = this.channels[this.row];
    const cell = this.focusedCell();
    return channel && cell ? this.cellKey(PlaylistService.indexOf(channel), cell) : null;
  }

  private visibleRows(): number {
    const body = this.container.querySelector<HTMLElement>('.guide-body');
    const height = body?.clientHeight || uiPx(BODY_FALLBACK);
    return Math.max(1, Math.floor((height + uiTextPx(8)) / uiTextPx(ROW_STRIDE)));
  }

  private moveRow(delta: number): void {
    this.row = Math.max(0, Math.min(this.channels.length - 1, this.row + delta));
  }

  // The earliest time a row may show: its catch-up window, or the live slot.
  private backLimit(channel: Channel, now: number): number {
    if (!channel.catchupSource) return alignHalfHour(now);
    const days = channel.catchupDays > 0 ? channel.catchupDays : 7;
    return alignHalfHour(now - days * 24 * 60 * 60 * 1000);
  }

  private moveTime(dir: -1 | 1): boolean {
    const channel = this.channels[this.row];
    const cell = this.focusedCell();
    if (!channel || !cell) return false;
    const now = Date.now();
    const programs = this.asTimes(this.programsAround(channel, cell.start));
    const next = step(programs, cell.start, dir);
    const nextStop = next.program ? next.program.stop : emptySlot(programs, next.time).stop;
    if (dir < 0 && nextStop <= this.backLimit(channel, now)) return false;
    const limit = alignHalfHour(now + AHEAD_DAYS * 24 * 60 * 60 * 1000);
    if (dir > 0 && next.time >= limit) return true;
    this.time = next.time;
    this.windowStart = clampWindow(pageTo(this.windowStart, next.time, nextStop), now, 7, AHEAD_DAYS);
    return true;
  }

  // The pointer picked a cell: focus follows it.
  private pick(cell: HTMLElement): boolean {
    const position = Number(cell.dataset.row);
    const time = Number(cell.dataset.time);
    if (!(position >= 0) || !(time > 0)) return false;
    this.row = position;
    this.time = time;
    return true;
  }

  private async activate(): Promise<void> {
    const channel = this.channels[this.row];
    const cell = this.focusedCell();
    if (!channel || !cell) return;
    const index = PlaylistService.indexOf(channel);
    const scope = this.options.scope();
    const now = Date.now();
    if (!cell.program) {
      if (cell.start <= now && cell.stop > now) this.options.play(index, undefined, scope);
      return;
    }
    await activateProgram({
      channel,
      index,
      prog: cell.program,
      scope,
      play: this.options.play,
      prompt: this.prompt,
      stillCurrent: () => this.channels[this.row] === channel,
      rerender: () => this.render(),
    });
  }
}
