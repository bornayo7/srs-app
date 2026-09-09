import { z } from 'zod';
import { aiConfigReady, getAiConfig, type AiConfig } from './config';
import { providerText, ProviderError, type AiMessage } from './transport';

export interface AiCallOpts {
  system: string;
  cacheableSystem?: string;
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
}

async function requireConfig(): Promise<AiConfig> {
  const config = await getAiConfig();
  if (!aiConfigReady(config))
    throw new Error('Complete the active provider, endpoint, model, and key in Settings → AI.');
  return config;
}

/** Both providers receive the actual schema; Zod remains the local authority. */
export async function aiGenerateObject<S extends z.ZodType>(
  schema: S,
  opts: AiCallOpts,
): Promise<z.infer<S>> {
  const config = await requireConfig();
  const jsonSchema = z.toJSONSchema(schema);
  const messages: AiMessage[] = [{ role: 'user', content: opts.user }];
  const system = `${opts.system}\nReturn one JSON object conforming to this schema:\n${JSON.stringify(jsonSchema)}`;
  let problem = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await providerText(config, { ...opts, system }, messages, jsonSchema);
    try {
      const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(raw);
      const result = schema.safeParse(JSON.parse(fenced ? fenced[1] : raw));
      if (result.success) return result.data;
      problem = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
    } catch {
      problem = 'The response was not valid JSON.';
    }
    messages.push({
      role: 'user',
      content: `The previous response failed local validation: ${problem}. Generate a complete replacement for the original request using the supplied schema. Return only the JSON object.`,
    });
  }
  throw new Error(`The model could not produce valid content: ${problem}`);
}

export async function aiGenerateText(opts: AiCallOpts): Promise<string> {
  return providerText(await requireConfig(), opts, [{ role: 'user', content: opts.user }]);
}

export function aiErrorMessage(error: unknown): string {
  if (error instanceof ProviderError) {
    if (error.status === 401 || error.status === 403)
      return 'The provider rejected access — check your API key in Settings → AI.';
    if (error.status === 429) return 'Rate limited by the API — wait a moment and try again.';
    if (error.status === 404) return 'Model or endpoint not found — check Settings → AI.';
    return `The API rejected the request (${error.status}): ${error.message}`;
  }
  if (error instanceof Error && error.name === 'AbortError') return 'Generation cancelled.';
  if (error instanceof TypeError)
    return 'Could not reach the API endpoint — check your connection and endpoint settings.';
  return error instanceof Error ? error.message : 'The request failed. Please try again.';
}

export async function testConnection(): Promise<string> {
  const config = await requireConfig();
  const reply = await providerText(
    config,
    {
      system: 'You are a connectivity check.',
      user: 'Reply with the single word: ok',
      maxTokens: 256,
    },
    [{ role: 'user', content: 'Reply with the single word: ok' }],
  );
  const model = config.provider === 'anthropic' ? config.anthropic.model : config.openai.model;
  return `Connected — ${model} answered “${reply.slice(0, 40)}”.`;
}
