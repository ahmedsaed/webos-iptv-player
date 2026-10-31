import { describe, it, expect } from 'vitest';
import type { PlaylistEntry } from '../types';
import { firstRunLanding } from './first-run';

const playlist: PlaylistEntry = { id: 'p1', name: 'P1', url: 'http://host/a.m3u' };

describe('firstRunLanding', () => {
  it('is no first run once any source exists, even a turned-off one', () => {
    expect(firstRunLanding([playlist], 'launch')).toBeNull();
    expect(firstRunLanding([{ ...playlist, enabled: false }], 'launch')).toBeNull();
  });

  it('shows the first run on Home at launch', () => {
    expect(firstRunLanding([], 'launch')).toBe('home');
  });

  it('opens Settings for a later load', () => {
    expect(firstRunLanding([], 'quiet')).toBe('settings');
    expect(firstRunLanding([], 'live')).toBe('settings');
  });
});
