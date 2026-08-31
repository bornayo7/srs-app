import { DAY, startOfLocalDay } from './time';

export interface ForecastInput {
  state: string;
  dueAt?: number;
}

export interface ForecastDay {
  dayStart: number;
  count: number;
  cumulative: number; // includes everything due before this day's end
}

export interface Forecast {
  dueNow: number;
  days: ForecastDay[]; // starting today
  beyond: number; // due after the window
}

/** Bucket review-state cards' dueAt into local-day bins for the dashboard strip. */
export function buildForecast(cards: readonly ForecastInput[], now: number, numDays = 7): Forecast {
  const todayStart = startOfLocalDay(now);
  const days: ForecastDay[] = Array.from({ length: numDays }, (_, i) => ({
    dayStart: todayStart + i * DAY,
    count: 0,
    cumulative: 0,
  }));

  let dueNow = 0;
  let beyond = 0;
  for (const c of cards) {
    if (c.state !== 'review' || c.dueAt === undefined) continue;
    if (c.dueAt <= now) {
      dueNow++;
      continue;
    }
    // round, not floor: DST makes some local days 23h/25h long
    const idx = Math.round((startOfLocalDay(c.dueAt) - todayStart) / DAY);
    if (idx < 0) {
      dueNow++;
    } else if (idx < numDays) {
      days[idx].count++;
    } else {
      beyond++;
    }
  }

  let running = dueNow;
  for (const d of days) {
    running += d.count;
    d.cumulative = running;
  }
  return { dueNow, days, beyond };
}
