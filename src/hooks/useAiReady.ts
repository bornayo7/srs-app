import { useLiveQuery } from 'dexie-react-hooks';
import { aiConfigReady, getAiConfig } from '@/ai/config';

/** true = active provider fully configured, false = not, undefined = loading. */
export function useAiReady(): boolean | undefined {
  return useLiveQuery(async () => aiConfigReady(await getAiConfig()), []);
}
