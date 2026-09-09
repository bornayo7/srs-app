import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildForecast } from './forecast';
import {
  DAY,
  HOUR,
  MINUTE,
  floorToHour,
  formatDuration,
  localDayAfter,
  startOfLocalDay,
  startOfNextLocalDay,
} from './time';
import { dueForStage } from './scheduler/ladder';
import { LADDER_PRESETS } from './scheduler/presets';

afterEach(() => vi.unstubAllEnvs());

describe('time', () => {
  it('floorToHour returns the top of the hour', () => {
    const t = Date.UTC(2026, 4, 3, 16, 59, 59, 999);
    expect(floorToHour(t)).toBe(Date.UTC(2026, 4, 3, 16, 0, 0, 0));
    expect(floorToHour(Date.UTC(2026, 4, 3, 16))).toBe(Date.UTC(2026, 4, 3, 16));
    expect(floorToHour(t) % HOUR).toBe(0);
    expect(floorToHour(t)).toBeLessThanOrEqual(t);
  });
  it('interval math is pure duration — DST cannot corrupt it', () => {
    const before = Date.UTC(2026, 2, 8, 1, 0);
    expect(before + 4 * HOUR - before).toBe(4 * HOUR);
    expect(before + DAY - before).toBe(DAY);
  });
  it('startOfLocalDay is midnight local time and idempotent', () => {
    const t = Date.now();
    const s = startOfLocalDay(t);
    const d = new Date(s);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(startOfLocalDay(s)).toBe(s);
    expect(s).toBeLessThanOrEqual(t);
  });
  it('formatDuration produces compact labels', () => {
    expect(formatDuration(30 * MINUTE)).toBe('30m');
    expect(formatDuration(4 * HOUR)).toBe('4h');
    expect(formatDuration(23 * HOUR)).toBe('23h');
    expect(formatDuration(2 * DAY)).toBe('2d');
    expect(formatDuration(7 * DAY)).toBe('7d');
    expect(formatDuration(14 * DAY)).toBe('2w');
    expect(formatDuration(21 * DAY)).toBe('3w');
    expect(formatDuration(30 * DAY)).toBe('1mo');
    expect(formatDuration(60 * DAY)).toBe('2mo');
    expect(formatDuration(180 * DAY)).toBe('6mo');
  });
});

describe('elapsed scheduling and local calendar boundaries', () => {
  it.each([0, 23, 40, 59])(
    'preserves short delays at minute %i, while longer stages stay hour-aligned',
    (minute) => {
      const at = Date.UTC(2026, 8, 8, 10, minute, 45);
      const base = LADDER_PRESETS[0];
      for (const delay of [1, 30, 59, 60]) {
        const ladder = { ...base, stages: [{ ...base.stages[0], intervalMinutes: delay }] };
        expect(dueForStage(ladder, 0, at)).toBe(at + delay * 60_000);
      }
      const long = { ...base, stages: [{ ...base.stages[0], intervalMinutes: 240 }] };
      expect(dueForStage(long, 0, at)).toBe(Date.UTC(2026, 8, 8, 14));
    },
  );

  it.each([
    [2026, 2, 8, 23],
    [2026, 10, 1, 25],
  ])('uses midnight across DST on %i-%i-%i (%ih day)', (year, month, day, hours) => {
    vi.stubEnv('TZ', 'America/Chicago');
    const at = new Date(year, month, day, 12).getTime();
    const start = startOfLocalDay(at);
    const next = startOfNextLocalDay(at);
    expect(next - start).toBe(hours * HOUR);
    expect(new Date(next).getHours()).toBe(0);
    const forecast = buildForecast(
      [
        { state: 'review', dueAt: next - 1 },
        { state: 'review', dueAt: next },
        { state: 'review', dueAt: localDayAfter(at, 2) },
      ],
      at,
      3,
    );
    expect(forecast.days.map((d) => new Date(d.dayStart).getHours())).toEqual([0, 0, 0]);
    expect(forecast.days.map((d) => d.count)).toEqual([1, 1, 1]);
  });
});
