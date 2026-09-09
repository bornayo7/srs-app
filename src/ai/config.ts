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
  return db.transaction('r', db.meta, async () => {
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
  });
}

/** Is the ACTIVE provider fully configured? */
export function aiConfigReady(cfg: AiConfig): boolean {
  if (cfg.provider === 'anthropic')
    return !!cfg.anthropic.apiKey?.trim() && !!cfg.anthropic.model.trim();
  if (cfg.openai.model.trim().length === 0) return false;
  try {
    const url = validEndpoint(cfg.openai.baseUrl);
    return !!cfg.openai.apiKey?.trim() || url.hostname !== 'api.openai.com';
  } catch {
    return false;
  }
}

function validEndpoint(value: string): URL {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Use an HTTP or HTTPS endpoint without credentials, query parameters, or a fragment.',
    );
  }
  return url;
}

async function setMeta(key: string, value: string): Promise<void> {
  if (value.trim()) await db.meta.put({ key, value: value.trim() });
  else await db.meta.delete(key);
}

export const setProvider = (p: AiProvider) => setMeta('ai:provider', p);
export const setAnthropicKey = (key: string) => setMeta('ai:apiKey', key);
export const setAnthropicModel = (model: string) => setMeta('ai:model', model);
export const setOpenaiKey = (key: string) => setMeta('ai:openaiKey', key);
export const setOpenaiBaseUrl = (url: string) => {
  if (url.trim()) validEndpoint(url.trim());
  return setMeta('ai:openaiBaseUrl', url);
};
export const setOpenaiModel = (model: string) => setMeta('ai:openaiModel', model);

/** Save the active destination and its key as one local configuration change. */
export async function saveAiSettings(input: {
  provider: AiProvider;
  anthropicModel: string;
  openaiBaseUrl: string;
  openaiModel: string;
  /** Omitted preserves the active key; an explicit empty string removes it. */
  apiKey?: string;
}): Promise<void> {
  if (!['anthropic', 'openai'].includes(input.provider))
    throw new Error('Choose a supported provider.');
  const model =
    input.provider === 'anthropic' ? input.anthropicModel.trim() : input.openaiModel.trim();
  if (!model) throw new Error('Enter a model name.');
  if (input.provider === 'openai') validEndpoint(input.openaiBaseUrl.trim());
  await db.transaction('rw', db.meta, async () => {
    await setMeta('ai:provider', input.provider);
    await setMeta(input.provider === 'anthropic' ? 'ai:model' : 'ai:openaiModel', model);
    if (input.provider === 'openai') await setMeta('ai:openaiBaseUrl', input.openaiBaseUrl);
    if (input.apiKey !== undefined)
      await setMeta(input.provider === 'anthropic' ? 'ai:apiKey' : 'ai:openaiKey', input.apiKey);
  });
}
