import { useEffect, useState } from 'react';
import { syncAllScheduledReleases } from '@/services/plans';
import { now } from '@/services/clock';

/** Calendar releases keep working on every route, including a long-open study tab. */
export function useScheduledReleases() {
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    let running = false;
    const sync = async () => {
      if (running || document.visibilityState === 'hidden') return;
      running = true;
      try {
        await syncAllScheduledReleases(now());
        if (alive) setError('');
      } catch (cause) {
        if (alive)
          setError(
            `A scheduled unit could not open. ${cause instanceof Error ? cause.message : 'Try reopening the course plan.'}`,
          );
      } finally {
        running = false;
      }
    };
    const wake = () => void sync();
    wake();
    const timer = window.setInterval(wake, 60_000);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, []);
  return error;
}
