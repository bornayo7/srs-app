import { z } from 'zod';
import type { AiConfig } from './config';
import type { AiCallOpts } from './client';

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly param?: string,
  ) {
    super(message);
  }
}

const errorBody = z.object({
  error: z.object({ message: z.string(), param: z.string().nullish() }),
});
const openaiReply = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({ content: z.string().nullish(), refusal: z.string().nullish() }),
      }),
    )
    .min(1),
});
const anthropicReply = z.object({
  stop_reason: z.string().nullish(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorBody.safeParse(raw);
    throw new ProviderError(
      response.status,
      error.success
        ? error.data.error.message
        : response.statusText || 'Unexpected provider response',
      error.success ? (error.data.error.param ?? undefined) : undefined,
    );
  }
  return raw;
}

/** Unsupported grammar constraints remain in the prompt and in local validation. */
function grammarSchema(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const unsupported = new Set([
    '$schema',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'multipleOf',
    'format',
  ]);
  const maps = new Set([
    'properties',
    'patternProperties',
    '$defs',
    'definitions',
    'dependentSchemas',
  ]);
  const children = new Set([
    'items',
    'additionalProperties',
    'additionalItems',
    'contains',
    'propertyNames',
    'not',
    'if',
    'then',
    'else',
    'unevaluatedProperties',
    'unevaluatedItems',
  ]);
  const arrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !unsupported.has(key))
      .map(([key, val]) => {
        // Property names and literal enum/const values are data, even when they
        // happen to be named after a schema keyword (e.g. "minimum").
        if (maps.has(key) && val && typeof val === 'object') {
          return [
            key,
            Object.fromEntries(
              Object.entries(val).map(([name, schema]) => [name, grammarSchema(schema)]),
            ),
          ];
        }
        if (children.has(key)) return [key, grammarSchema(val)];
        if (arrays.has(key) && Array.isArray(val)) return [key, val.map(grammarSchema)];
        return [key, val];
      }),
  );
}

function checkedText(
  text: string | null | undefined,
  stop: string | null | undefined,
  refused = false,
): string {
  if (refused || stop === 'refusal' || stop === 'content_filter')
    throw new Error('The model declined this request — try rephrasing it.');
  if (stop === 'length' || stop === 'max_tokens')
    throw new Error('The response was cut off. Request fewer items or a shorter response.');
  if (!text?.trim()) throw new Error('The model returned no usable output — try again.');
  return text.trim();
}

/** Bounded compatibility negotiation; generic failures are never replayed. */
export async function providerText(
  config: AiConfig,
  opts: AiCallOpts,
  messages: AiMessage[],
  schema?: unknown,
): Promise<string> {
  if (config.provider === 'anthropic') {
    const system = opts.cacheableSystem
      ? [
          { type: 'text', text: opts.system },
          { type: 'text', text: opts.cacheableSystem, cache_control: { type: 'ephemeral' } },
        ]
      : opts.system;
    const raw = await post(
      'https://api.anthropic.com/v1/messages',
      {
        'x-api-key': config.anthropic.apiKey!,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      {
        model: config.anthropic.model,
        max_tokens: opts.maxTokens,
        system,
        messages,
        ...(schema
          ? { output_config: { format: { type: 'json_schema', schema: grammarSchema(schema) } } }
          : {}),
      },
      opts.signal,
    );
    const result = anthropicReply.safeParse(raw);
    if (!result.success) throw new Error('The provider returned an unreadable response.');
    return checkedText(
      result.data.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n'),
      result.data.stop_reason,
    );
  }

  let tokenParam = 'max_completion_tokens';
  let jsonMode = schema !== undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await post(
        `${config.openai.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        config.openai.apiKey ? { authorization: `Bearer ${config.openai.apiKey}` } : {},
        {
          model: config.openai.model,
          messages: [
            {
              role: 'system',
              content: [opts.system, opts.cacheableSystem].filter(Boolean).join('\n\n'),
            },
            ...messages,
          ],
          [tokenParam]: opts.maxTokens,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        },
        opts.signal,
      );
      const result = openaiReply.safeParse(raw);
      if (!result.success) throw new Error('The provider returned an unreadable response.');
      const choice = result.data.choices[0];
      return checkedText(choice.message.content, choice.finish_reason, !!choice.message.refusal);
    } catch (error) {
      if (
        !(error instanceof ProviderError) ||
        error.status !== 400 ||
        !/unsupported|not supported|unknown|unrecognized/i.test(error.message)
      )
        throw error;
      const mentions = (name: string) => error.param === name || error.message.includes(name);
      if (tokenParam === 'max_completion_tokens' && mentions(tokenParam)) tokenParam = 'max_tokens';
      else if (jsonMode && mentions('response_format')) jsonMode = false;
      else throw error;
      if (attempt === 2) throw error;
    }
  }
  throw new Error('The endpoint does not support this request format.');
}
