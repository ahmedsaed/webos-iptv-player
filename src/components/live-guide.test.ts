// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, Programme } from '../types';

const { data, reminders, toast } = vi.hoisted(() => {
  const mk = (id: string, name: string, catchupSource = ''): Channel => ({
    id, name, logo: '', group: 'Group 1', url: `http://host/${id}`, extras: null,
    playlistIds: ['p1'], catchup: '', catchupSource, catchupDays: catchupSource ? 7 : 0,
  });
  return {
    data: {
      channels: [mk('ch1', 'ch1', 'http://host/ch1?utc={utc}'), mk('ch2', 'ch2'), mk('ch3', 'ch3')],
      programmes: {} as Record<string, Programme[]>,
    },
    reminders: new Set<string>(),
    toast: vi.fn(),
  };
});

vi.mock('../services/playlist-service', () => ({
  PlaylistService: {
    getByGroup: () => data.channels,
    indexOf: (ch: Channel) => data.channels.indexOf(ch),
  },
}));
vi.mock('../services/epg-service', () => ({
  EpgService: {
    findChannelId: (ch: Channel) => ch.id,
    getProgrammesIntersectingRange: (id: string, from: number, to: number) =>
      (data.programmes[id] ?? []).filter(p => p.stop.getTime() > from && p.start.getTime() < to),
    getSourceUrl: () => null,
  },
}));
vi.mock('../services/reminder-service', () => ({
  ReminderService: {
    has: (key: string, start: number) => reminders.has(`${key}:${start}`),
    add: vi.fn((r: { channelKey: string; startMs: number }) => reminders.add(`${r.channelKey}:${r.startMs}`)),
    remove: vi.fn((key: string, start: number) => reminders.delete(`${key}:${start}`)),
  },
}));
vi.mock('../services/xtream-archive', () => ({
  XtreamArchiveService: {
    isAvailable: (ch: Channel) => !!ch.catchupSource,
    load: vi.fn(async () => null),
  },
}));
const hiddenUrls = new Set<string>();
vi.mock('../services/channel-customization', () => ({
  ChannelCustomizationService: { isChannelHidden: (ch: Channel) => hiddenUrls.has(ch.url) },
}));
vi.mock('./toast', () => ({ showToast: toast }));
vi.mock('../services/storage-service', () => ({
  StorageService: { getCatchupProgressList: () => [], clearCatchupProgress: vi.fn() },
}));

import { LiveGuide } from './live-guide';
import { Focus } from '../navigation/focus-scope';

const at = (h: number, m = 0) => new Date(2026, 8, 15, h, m);
const prog = (title: string, from: Date, to: Date): Programme =>
  ({ title, start: from, stop: to, description: '', category: '', icon: '' });

let container: HTMLElement;
let guide: LiveGuide;
let handlers: {
  play: ReturnType<typeof vi.fn>;
  onLeaveLeft: ReturnType<typeof vi.fn>;
  onLeaveUp: ReturnType<typeof vi.fn>;
};

const focusedKey = () => {
  Focus.flush();
  return container.querySelector<HTMLElement>('.guide-cell.focused')?.dataset.key ?? null;
};
const times = () => Array.from(container.querySelectorAll('.guide-time')).map(el => el.textContent);
const cell = (title: string) => Array.from(container.querySelectorAll<HTMLElement>('.guide-cell'))
  .find(el => el.querySelector('.guide-cell-title')?.textContent?.includes(title)) ?? null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(20, 42));
  reminders.clear();
  toast.mockClear();
  data.programmes = {
    ch1: [
      prog('Program 1', at(19), at(20)),
      prog('Program 2', at(20), at(21)),
      prog('Program 3', at(21), at(21, 30)),
      prog('Program 4', at(21, 30), at(23)),
    ],
    ch2: [prog('Program 5', at(20, 30), at(21, 30)), prog('Program 6', at(21, 30), at(22, 30))],
    ch3: [],
  };
  document.body.innerHTML = '<div class="view"><section id="g"></section></div>';
  container = document.getElementById('g')!;
  handlers = { play: vi.fn(), onLeaveLeft: vi.fn(), onLeaveUp: vi.fn() };
  guide = new LiveGuide(container, {
    scope: () => ({ group: 'builtin:all' }),
    play: handlers.play,
    watching: () => 1,
    onLeaveLeft: handlers.onLeaveLeft,
    onLeaveUp: handlers.onLeaveUp,
  });
  Focus.setBase(() => guide.focusScope);
  Focus.install();
  guide.show(0);
  guide.enter();
});

afterEach(() => {
  Focus.uninstall();
  vi.useRealTimers();
});

describe('LiveGuide', () => {
  it('opens on two and a half hours from the half hour before the current one', () => {
    expect(times()).toEqual(['20:00', '20:30', '21:00', '21:30', '22:00']);
    expect(container.querySelector('.guide-now-pill')?.textContent).toBe('20:42');
    expect(container.querySelector('.guide-day')?.textContent).toBe('Today');
    expect(focusedKey()).toBe(`cell:0:${at(20).getTime()}`);
  });

  it('draws each program as a cell of its share of the window, with its state', () => {
    const live = cell('Program 2')!;
    expect(live.style.left).toBe('0%');
    expect(live.style.width).toBe('40%');
    expect(live.classList.contains('live')).toBe(true);
    expect(live.querySelector('.guide-cell-progress')).not.toBeNull();
    expect(cell('Program 4')!.classList.contains('future')).toBe(true);
    expect(cell('Program 4')!.querySelector('.guide-cell-time')?.textContent).toBe('21:30–23:00');
    // Program 1 ended before the window.
    expect(cell('Program 1')).toBeNull();
    // The watched channel is marked in the channel column.
    expect(container.querySelectorAll('.guide-channel.watching')).toHaveLength(1);
  });

  it('escapes program titles and channel names from the feed', () => {
    data.programmes.ch1[1] = prog('<img src=x onerror="window.hit=1">', at(20), at(21));
    data.channels[1].name = '<b>ch2</b>';
    guide.render();
    expect(container.querySelector('img[onerror], b')).toBeNull();
    expect(cell('<img src=x')).not.toBeNull();
    expect(container.textContent).toContain('<b>ch2</b>');
    data.channels[1].name = 'ch2';
  });

  it('dims a hidden channel shown by Show hidden channels, as the list does', () => {
    hiddenUrls.add(data.channels[1].url);
    try {
      guide.render();
      const rows = container.querySelectorAll('.guide-row');
      expect(rows[0].classList.contains('hidden-entry')).toBe(false);
      expect(rows[1].classList.contains('hidden-entry')).toBe(true);
    } finally {
      hiddenUrls.clear();
    }
  });

  it('renders a bounded window of rows for a large playlist', () => {
    const saved = data.channels;
    data.channels = Array.from({ length: 50_000 }, (_, i) => ({
      ...saved[1], id: `c${String(i)}`, name: `Channel ${String(i)}`, url: `http://host/c${String(i)}`,
    }));
    try {
      guide.groupChanged();
      const rows = container.querySelectorAll('.guide-row').length;
      expect(rows).toBeGreaterThan(0);
      expect(rows).toBeLessThan(60);
    } finally {
      data.channels = saved;
    }
  });

  it('labels a row without guide data once, in its first cell', () => {
    const row = container.querySelector('[data-key="row:2"]')!;
    const titles = Array.from(row.querySelectorAll('.guide-cell-title')).map(el => el.textContent);
    expect(titles[0]).toBe('No program information available.');
    expect(titles.slice(1).every(text => text === '')).toBe(true);
  });

  it('moves through programs with Left and Right, paging the window by half hours', () => {
    guide.handleAction('right');
    expect(focusedKey()).toBe(`cell:0:${at(21).getTime()}`);
    guide.handleAction('right');
    expect(focusedKey()).toBe(`cell:0:${at(21, 30).getTime()}`);
    expect(times()[0]).toBe('20:00');
    guide.handleAction('right');
    // Past the row's data, focus pages on through empty half hours.
    expect(focusedKey()).toBe(`cell:0:e${at(23).getTime()}`);
    expect(times()[0]).toBe('22:00');
    guide.handleAction('left');
    expect(focusedKey()).toBe(`cell:0:${at(21, 30).getTime()}`);
  });

  it('goes into the past only on a channel with catch-up, else leaves for the groups', () => {
    guide.handleAction('left');
    expect(focusedKey()).toBe(`cell:0:${at(19).getTime()}`);
    expect(times()[0]).toBe('19:00');
    expect(handlers.onLeaveLeft).not.toHaveBeenCalled();
    guide.handleAction('down');
    guide.handleAction('left');
    expect(handlers.onLeaveLeft).toHaveBeenCalledOnce();
  });

  it('keeps the time moving up and down, and hands Up off the first row to the header', () => {
    guide.handleAction('right');
    guide.handleAction('down');
    expect(focusedKey()).toBe(`cell:1:${at(20, 30).getTime()}`);
    guide.handleAction('down');
    guide.handleAction('down');
    expect(focusedKey()).toBe(`cell:2:e${at(21).getTime()}`);
    guide.handleAction('up');
    guide.handleAction('up');
    guide.handleAction('up');
    expect(handlers.onLeaveUp).toHaveBeenCalledOnce();
  });

  it('watches a live program on OK', () => {
    guide.handleAction('select');
    expect(handlers.play).toHaveBeenCalledWith(0, undefined, { group: 'builtin:all' });
  });

  it('sets and clears a future program reminder on OK', async () => {
    guide.handleAction('right');
    guide.handleAction('select');
    await vi.runAllTimersAsync();
    expect(reminders.size).toBe(1);
    expect(toast).toHaveBeenLastCalledWith('Reminder set');
    expect(cell('Program 3')!.classList.contains('reminder')).toBe(true);
    guide.handleAction('select');
    await vi.runAllTimersAsync();
    expect(reminders.size).toBe(0);
    expect(toast).toHaveBeenLastCalledWith('Reminder removed');
    expect(handlers.play).not.toHaveBeenCalled();
  });

  it('plays a past program catch-up on OK', async () => {
    guide.handleAction('left');
    guide.handleAction('select');
    await vi.runAllTimersAsync();
    expect(handlers.play).toHaveBeenCalledOnce();
    const [index, catchup] = handlers.play.mock.calls[0];
    expect(index).toBe(0);
    expect(catchup).toMatchObject({ title: 'Program 1', start: at(19).getTime() / 1000 });
  });

  it('sends Back to the groups', () => {
    expect(guide.handleAction('back')).toBe(true);
    expect(handlers.onLeaveLeft).toHaveBeenCalledOnce();
  });

  it('follows the pointer and activates the clicked cell', () => {
    cell('Program 5')!.click();
    expect(focusedKey()).toBe(`cell:1:${at(20, 30).getTime()}`);
    expect(handlers.play).toHaveBeenCalledWith(1, undefined, { group: 'builtin:all' });
  });

  it('starts a changed group at its first channel', () => {
    guide.handleAction('down');
    guide.groupChanged();
    expect(focusedKey()).toBe(`cell:0:${at(20).getTime()}`);
  });
});
