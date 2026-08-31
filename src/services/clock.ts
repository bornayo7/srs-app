import { db } from '@/db/db';

// Dev-only time travel for exercising the SRS loop without waiting hours.
// The offset lives in meta and is only ever READ in dev builds, so it cannot
// leak into production scheduling.

let offsetMs = 0;

export function now(): number {
  return Date.now() + offsetMs;
}

export function clockOffset(): number {
  return offsetMs;
}

export async function initClock(): Promise<void> {
  if (!import.meta.env.DEV) return;
  const row = await db.meta.get('devClockOffsetMs');
  offsetMs = typeof row?.value === 'number' ? row.value : 0;
}

export async function setClockOffset(ms: number): Promise<void> {
  offsetMs = ms;
  await db.meta.put({ key: 'devClockOffsetMs', value: ms });
}
