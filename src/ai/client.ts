import Anthropic from '@anthropic-ai/sdk';
import { getAiConfig } from './config';

/**
 * Browser-direct Anthropic client. The key is the user's own, stored locally
 * in IndexedDB and sent only to api.anthropic.com — there is no app server.
 */
export async function makeClient(): Promise<{ client: Anthropic; model: string }> {
  const { apiKey, model } = await getAiConfig();
  if (!apiKey) {
    throw new Error('No API key set — add your Anthropic API key in Settings → AI.');
  }
  return { client: new Anthropic({ apiKey, dangerouslyAllowBrowser: true }), model };
}

/** Map SDK errors to messages the review UI can show directly. */
export function aiErrorMessage(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Anthropic rejected the API key — check Settings → AI.';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Rate limited by the API — wait a moment and try again.';
  }
  if (err instanceof Anthropic.BadRequestError) {
    return `The API rejected the request: ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Could not reach api.anthropic.com — check your connection.';
  }
  if (err instanceof Anthropic.APIError) {
    return `API error ${err.status}: ${err.message}`;
  }
  return (err as Error).message || 'Unknown error';
}

/** Cheap connectivity/key check for the Settings panel. */
export async function testConnection(): Promise<string> {
  const { client, model } = await makeClient();
  const response = await client.messages.create({
    model,
    // adaptive thinking may spend some of the budget; keep headroom
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
  });
  const text = response.content.find((b) => b.type === 'text');
  return `Connected — ${model} answered${text ? ` “${text.text.trim().slice(0, 40)}”` : ''}.`;
}
