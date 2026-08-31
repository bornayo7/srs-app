import { db } from '@/db/db';

export const AI_MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 — best quality (default)' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — fast & capable' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — cheapest' },
] as const;

export const DEFAULT_MODEL = 'claude-opus-5';

export interface AiConfig {
  apiKey: string | null;
  model: string;
}

export async function getAiConfig(): Promise<AiConfig> {
  const [keyRow, modelRow] = await Promise.all([db.meta.get('ai:apiKey'), db.meta.get('ai:model')]);
  return {
    apiKey: typeof keyRow?.value === 'string' && keyRow.value ? keyRow.value : null,
    model: typeof modelRow?.value === 'string' && modelRow.value ? modelRow.value : DEFAULT_MODEL,
  };
}

export async function setApiKey(key: string): Promise<void> {
  if (key.trim()) await db.meta.put({ key: 'ai:apiKey', value: key.trim() });
  else await db.meta.delete('ai:apiKey');
}

export async function setModel(model: string): Promise<void> {
  await db.meta.put({ key: 'ai:model', value: model });
}
