import { useCallback, useEffect, useRef, useState } from 'react';

/** One user intent at a time, with recoverable errors and no updates after closing. */
export function useOperation() {
  const active = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    async <T>(action: () => Promise<T>, success?: string): Promise<T | undefined> => {
      if (active.current) return;
      active.current = true;
      setBusy(true);
      setError('');
      setMessage('');
      try {
        const result = await action();
        if (mounted.current && success) setMessage(success);
        return result;
      } catch (cause) {
        if (mounted.current)
          setError(
            cause instanceof Error ? cause.message : 'The change could not be saved. Try again.',
          );
        return undefined;
      } finally {
        active.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [],
  );
  return { busy, error, message, run, setError, setMessage };
}
