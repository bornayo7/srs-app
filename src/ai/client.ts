import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { aiConfigReady, getAiConfig, type AiConfig } from './config';

/**
 * Provider-agnostic AI calls, browser-direct with the user's own key.
 * - Anthropic: structured outputs via messages.parse + zodOutputFormat.
 * - OpenAI-compatible (OpenAI, Gemini, OpenRouter, Ollama, …): JSON mode with
 *   zod validation and one self-correction retry; request features degrade
 *   gracefully for servers that reject max_completion_tokens/response_format.
 */

export interface AiCallOpts {
  system: string;
  /**
   * Large, stable context (a course's source material) sent as a second
   * system block. On Anthropic it carries a cache breakpoint, so repeated
   * calls with the same material within the cache window pay a fraction for
   * it; elsewhere it is simply appended to the system prompt.
   */
  cacheableSystem?: string;
  user: string;
  maxTokens: number;
}

function anthropicSystem(opts: AiCallOpts): string | Anthropic.TextBlockParam[] {
  if (!opts.cacheableSystem) return opts.system;
  return [
    { type: 'text', text: opts.system },
    { type: 'text', text: opts.cacheableSystem, cache_control: { type: 'ephemeral' } },
  ];
}

function flatSystem(opts: AiCallOpts): string {
  return opts.cacheableSystem ? `${opts.system}\n\n${opts.cacheableSystem}` : opts.system;
}

async function requireConfig(): Promise<AiConfig> {
  const cfg = await getAiConfig();
  if (!aiConfigReady(cfg)) {
    throw new Error(
      cfg.provider === 'anthropic'
        ? 'No Anthropic API key set — add it in Settings → AI.'
        : 'Set a model name (and an API key, unless the endpoint is keyless like Ollama) in Settings → AI.',
    );
  }
  return cfg;
}

// ---------- Anthropic ----------

function anthropicClient(cfg: AiConfig): Anthropic {
  return new Anthropic({ apiKey: cfg.anthropic.apiKey!, dangerouslyAllowBrowser: true });
}

async function anthropicObject<S extends z.ZodType>(
  cfg: AiConfig,
  schema: S,
  opts: AiCallOpts,
): Promise<z.infer<S>> {
  const client = anthropicClient(cfg);
  const response = await client.messages.parse({
    model: cfg.anthropic.model,
    max_tokens: opts.maxTokens,
    system: anthropicSystem(opts),
    messages: [{ role: 'user', content: opts.user }],
    output_config: { format: zodOutputFormat(schema) },
  });
  if (response.stop_reason === 'refusal') {
    throw new Error('The model declined this request — try rephrasing it.');
  }
  if (!response.parsed_output) {
    throw new Error('The model returned no usable output — try again.');
  }
  return response.parsed_output;
}

async function anthropicText(cfg: AiConfig, opts: AiCallOpts): Promise<string> {
  const client = anthropicClient(cfg);
  const response = await client.messages.create({
    model: cfg.anthropic.model,
    max_tokens: opts.maxTokens,
    system: anthropicSystem(opts),
    messages: [{ role: 'user', content: opts.user }],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error('The model declined — try again.');
  }
  const text = response.content.find((b) => b.type === 'text');
  return text?.text.trim() ?? '';
}

// ---------- OpenAI-compatible ----------

function openaiClient(cfg: AiConfig): OpenAI {
  return new OpenAI({
    // keyless endpoints (Ollama etc.) still need a non-empty string
    apiKey: cfg.openai.apiKey ?? 'not-needed',
    baseURL: cfg.openai.baseUrl,
    dangerouslyAllowBrowser: true,
  });
}

function stripFences(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : raw).trim();
}

async function openaiChat(
  cfg: AiConfig,
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  maxTokens: number,
  wantJson: boolean,
): Promise<string> {
  const client = openaiClient(cfg);
  // degrade for servers that reject newer params: full → legacy max_tokens → bare
  const variants: Array<Record<string, unknown>> = [
    { max_completion_tokens: maxTokens, ...(wantJson ? { response_format: { type: 'json_object' } } : {}) },
    { max_tokens: maxTokens, ...(wantJson ? { response_format: { type: 'json_object' } } : {}) },
    { max_tokens: maxTokens },
  ];
  let lastErr: unknown;
  for (const extra of variants) {
    try {
      const res = await client.chat.completions.create({
        model: cfg.openai.model,
        messages,
        ...extra,
      } as never);
      const choice = (res as OpenAI.ChatCompletion).choices?.[0];
      if (choice?.message?.refusal) {
        throw new Error('The model declined this request — try rephrasing it.');
      }
      return choice?.message?.content?.trim() ?? '';
    } catch (err) {
      lastErr = err;
      if (err instanceof OpenAI.BadRequestError) continue; // try the next variant
      throw err;
    }
  }
  throw lastErr;
}

async function openaiObject<S extends z.ZodType>(
  cfg: AiConfig,
  schema: S,
  opts: AiCallOpts,
): Promise<z.infer<S>> {
  const system = `${flatSystem(opts)}\nRespond with a SINGLE valid JSON object and nothing else.`;
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: system },
    { role: 'user', content: opts.user },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await openaiChat(cfg, messages, opts.maxTokens, true);
    let parsed: unknown;
    let problem: string;
    try {
      parsed = JSON.parse(stripFences(raw));
      const result = schema.safeParse(parsed);
      if (result.success) return result.data;
      problem = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
    } catch (err) {
      problem = `not valid JSON (${(err as Error).message.slice(0, 80)})`;
    }
    messages.push(
      { role: 'assistant', content: raw.slice(0, 4000) },
      {
        role: 'user',
        content: `That reply was invalid: ${problem}. Reply again with ONLY the corrected JSON object.`,
      },
    );
  }
  throw new Error('The model could not produce valid JSON for this request — try a different model.');
}

// ---------- Public API ----------

export async function aiGenerateObject<S extends z.ZodType>(
  schema: S,
  opts: AiCallOpts,
): Promise<z.infer<S>> {
  const cfg = await requireConfig();
  return cfg.provider === 'anthropic'
    ? anthropicObject(cfg, schema, opts)
    : openaiObject(cfg, schema, opts);
}

export async function aiGenerateText(opts: AiCallOpts): Promise<string> {
  const cfg = await requireConfig();
  if (cfg.provider === 'anthropic') return anthropicText(cfg, opts);
  return openaiChat(
    cfg,
    [
      { role: 'system', content: flatSystem(opts) },
      { role: 'user', content: opts.user },
    ],
    opts.maxTokens,
    false,
  );
}

/** Map SDK errors (either provider) to messages the UI can show directly. */
export function aiErrorMessage(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError || err instanceof OpenAI.AuthenticationError) {
    return 'The provider rejected the API key — check Settings → AI.';
  }
  if (err instanceof Anthropic.RateLimitError || err instanceof OpenAI.RateLimitError) {
    return 'Rate limited by the API — wait a moment and try again.';
  }
  if (err instanceof Anthropic.BadRequestError || err instanceof OpenAI.BadRequestError) {
    return `The API rejected the request: ${err.message}`;
  }
  if (err instanceof OpenAI.NotFoundError) {
    return 'Model or endpoint not found — check the model name and base URL in Settings → AI.';
  }
  if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError) {
    return 'Could not reach the API endpoint — check your connection (and base URL/CORS for custom endpoints).';
  }
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) {
    return `API error ${(err as { status?: number }).status}: ${(err as Error).message}`;
  }
  return (err as Error).message || 'Unknown error';
}

/** Cheap connectivity/key check for the Settings panel. */
export async function testConnection(): Promise<string> {
  const cfg = await requireConfig();
  const reply = await aiGenerateText({
    system: 'You are a connectivity check.',
    user: 'Reply with the single word: ok',
    maxTokens: 256,
  });
  const model = cfg.provider === 'anthropic' ? cfg.anthropic.model : cfg.openai.model;
  return `Connected — ${model} answered${reply ? ` “${reply.slice(0, 40)}”` : ''}.`;
}
