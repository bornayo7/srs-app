// Time helpers. Everything stores epoch milliseconds; intervals are durations,
// so DST can never corrupt scheduling. Local time appears only at display and
// day-bucketing boundaries (startOfLocalDay).

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Reviews become available on the hour (WaniKani behavior). */
export function floorToHour(ts: number): number {
  return ts - (ts % HOUR);
}

/** Local midnight for the day containing ts — lesson limits, heatmaps, streaks. */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function minutesToMs(minutes: number): number {
  return minutes * MINUTE;
}

/** "4h", "23h", "2d", "1w", "2mo" — compact duration label for stage intervals. */
export function formatDuration(ms: number): string {
  const mins = Math.round(ms / MINUTE);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 10) return `${days}d`;
  if (days < 28) return `${Math.round(days / 7)}w`;
  const months = Math.round(days / 30);
  return `${months}mo`;
}
