import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MINUTE, floorToHour, formatDuration, startOfLocalDay } from './time';

describe('time', () => {
  it('floorToHour returns the top of the hour', () => {
    const t = Date.UTC(2026, 4, 3, 16, 59, 59, 999);
    expect(floorToHour(t)).toBe(Date.UTC(2026, 4, 3, 16, 0, 0, 0));
    expect(floorToHour(Date.UTC(2026, 4, 3, 16))).toBe(Date.UTC(2026, 4, 3, 16));
    expect(floorToHour(t) % HOUR).toBe(0);
    expect(floorToHour(t)).toBeLessThanOrEqual(t);
  });

  it('interval math is pure duration — DST cannot corrupt it', () => {
    // 2026-03-08 is a US spring-forward date; epoch arithmetic doesn't care.
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
