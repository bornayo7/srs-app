import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';

/** true = key configured, false = no key, undefined = still loading. */
export function useAiReady(): boolean | undefined {
  return useLiveQuery(async () => {
    const row = await db.meta.get('ai:apiKey');
    return typeof row?.value === 'string' && row.value.length > 0;
  }, []);
}
