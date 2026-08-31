import { useEffect, useState } from 'react';
import { now } from '@/services/clock';

/** Re-render every `intervalMs` so due counts stay fresh; returns the app clock. */
export function useNowTick(intervalMs = 30_000): number {
  const [t, setT] = useState(() => now());
  useEffect(() => {
    const id = setInterval(() => setT(now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return t;
}
