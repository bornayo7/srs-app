import { db } from '@/db/db';

export type AiProvider = 'anthropic' | 'openai';

export const ANTHROPIC_MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 — best quality (default)' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — fast & capable' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — cheapest' },
] as const;

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** Common OpenAI-compatible base URLs, shown as suggestions in Settings. */
export const OPENAI_COMPAT_PRESETS = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1' },
] as const;

export interface AiConfig {
  provider: AiProvider;
  anthropic: { apiKey: string | null; model: string };
  openai: { apiKey: string | null; baseUrl: string; model: string };
}

async function metaString(key: string): Promise<string | null> {
  const row = await db.meta.get(key);
  return typeof row?.value === 'string' && row.value ? row.value : null;
}

export async function getAiConfig(): Promise<AiConfig> {
  const [provider, aKey, aModel, oKey, oBase, oModel] = await Promise.all([
    metaString('ai:provider'),
    metaString('ai:apiKey'),
    metaString('ai:model'),
    metaString('ai:openaiKey'),
    metaString('ai:openaiBaseUrl'),
    metaString('ai:openaiModel'),
  ]);
  return {
    provider: provider === 'openai' ? 'openai' : 'anthropic',
    anthropic: { apiKey: aKey, model: aModel ?? DEFAULT_ANTHROPIC_MODEL },
    openai: {
      apiKey: oKey,
      baseUrl: oBase ?? DEFAULT_OPENAI_BASE_URL,
      model: oModel ?? '',
    },
  };
}

/** Is the ACTIVE provider fully configured? */
export function aiConfigReady(cfg: AiConfig): boolean {
  if (cfg.provider === 'anthropic') return cfg.anthropic.apiKey !== null;
  if (cfg.openai.model.trim().length === 0) return false;
  // keyless is fine for self-hosted endpoints (Ollama etc.); openai.com needs a key
  return cfg.openai.apiKey !== null || !cfg.openai.baseUrl.includes('api.openai.com');
}

async function setMeta(key: string, value: string): Promise<void> {
  if (value.trim()) await db.meta.put({ key, value: value.trim() });
  else await db.meta.delete(key);
}

export const setProvider = (p: AiProvider) => setMeta('ai:provider', p);
export const setAnthropicKey = (key: string) => setMeta('ai:apiKey', key);
export const setAnthropicModel = (model: string) => setMeta('ai:model', model);
export const setOpenaiKey = (key: string) => setMeta('ai:openaiKey', key);
export const setOpenaiBaseUrl = (url: string) => setMeta('ai:openaiBaseUrl', url);
export const setOpenaiModel = (model: string) => setMeta('ai:openaiModel', model);
