import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { db } from '@/db/db';
import { aiGenerateObject, aiGenerateText } from './client';

const fetchMock = vi.fn<typeof fetch>();
const opts = { system: 'Generate', user: 'one item', maxTokens: 100 };
const schema = z.object({ answer: z.string().min(1) });
const reply = (content: string, finish_reason = 'stop') =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason }] }), {
    status: 200,
  });
beforeEach(async () => {
  await db.meta.clear();
  await db.meta.bulkPut([
    { key: 'ai:provider', value: 'openai' },
    { key: 'ai:openaiBaseUrl', value: 'http://localhost:11434/v1' },
    { key: 'ai:openaiModel', value: 'test' },
  ]);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

it('sends the schema on the first call and corrects invalid JSON once', async () => {
  fetchMock
    .mockResolvedValueOnce(reply('garbage'))
    .mockResolvedValueOnce(reply('{"answer":"yes"}'));
  expect(await aiGenerateObject(schema, opts)).toEqual({ answer: 'yes' });
  const first = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
  expect(first.messages[0].content).toContain('"required":["answer"]');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each(['length', 'content_filter'])(
  'does not accept a %s response or replay it',
  async (reason) => {
    fetchMock.mockResolvedValueOnce(reply('{"answer":"partial"}', reason));
    await expect(aiGenerateObject(schema, opts)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

it('does not retry arbitrary bad requests', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: { message: 'Invalid model' } }), { status: 400 }),
  );
  await expect(aiGenerateText(opts)).rejects.toThrow('Invalid model');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('negotiates only explicitly unsupported parameters', async () => {
  fetchMock
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message: 'Unsupported parameter max_completion_tokens',
            param: 'max_completion_tokens',
          },
        }),
        { status: 400 },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: 'Unknown parameter response_format', param: 'response_format' },
        }),
        { status: 400 },
      ),
    )
    .mockResolvedValueOnce(reply('{"answer":"yes"}'));
  expect(await aiGenerateObject(schema, opts)).toEqual({ answer: 'yes' });
  const last = JSON.parse(fetchMock.mock.calls[2][1]!.body as string);
  expect(last.max_tokens).toBe(100);
  expect(last).not.toHaveProperty('response_format');
});

it('rejects empty successful replies', async () => {
  fetchMock.mockResolvedValueOnce(reply(''));
  await expect(aiGenerateText(opts)).rejects.toThrow(/no usable output/);
});

it('preserves keyword-shaped property names in Anthropic structured output', async () => {
  await db.meta.bulkPut([
    { key: 'ai:provider', value: 'anthropic' },
    { key: 'ai:apiKey', value: 'test-placeholder' },
  ]);
  const nested = z.object({
    minimum: z.string().min(1),
    format: z.object({ maxLength: z.number().min(2) }),
  });
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"minimum":"yes","format":{"maxLength":3}}' }],
      }),
    ),
  );
  expect(
    await aiGenerateObject(nested, { ...opts, cacheableSystem: 'Reference material' }),
  ).toEqual({ minimum: 'yes', format: { maxLength: 3 } });
  const request = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
  expect(request.output_config.format.schema.properties.minimum).toEqual({ type: 'string' });
  expect(request.output_config.format.schema.properties.format.properties.maxLength).toEqual({
    type: 'number',
  });
  expect(request.system[0].text).toContain('"minLength":1');
  expect(request.system[1].cache_control.type).toBe('ephemeral');
});

it('rejects Anthropic refusals without parsing or retrying them', async () => {
  await db.meta.bulkPut([
    { key: 'ai:provider', value: 'anthropic' },
    { key: 'ai:apiKey', value: 'test-placeholder' },
  ]);
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        stop_reason: 'refusal',
        content: [{ type: 'text', text: '{"answer":"no"}' }],
      }),
    ),
  );
  await expect(aiGenerateObject(schema, opts)).rejects.toThrow('declined');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('passes cancellation through and never retries an aborted request', async () => {
  const controller = new AbortController();
  controller.abort();
  fetchMock.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
  await expect(
    aiGenerateObject(schema, { ...opts, signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchMock.mock.calls[0][1]!.signal).toBe(controller.signal);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('uses validation problems and the schema instead of echoing a partial JSON fragment', async () => {
  const invalid = JSON.stringify({ wrong: 'x'.repeat(5000) });
  fetchMock
    .mockResolvedValueOnce(reply(invalid))
    .mockResolvedValueOnce(reply('{"answer":"fixed"}'));
  expect(await aiGenerateObject(schema, opts)).toEqual({ answer: 'fixed' });
  const correction = JSON.parse(fetchMock.mock.calls[1][1]!.body as string);
  expect(correction.messages.at(-1).content).toContain('answer');
  expect(correction.messages.at(-1).content).toContain('complete replacement');
  expect(JSON.stringify(correction.messages)).not.toContain('x'.repeat(100));
});

it('preserves embedded code fences inside otherwise valid JSON strings', async () => {
  fetchMock.mockResolvedValueOnce(
    reply(JSON.stringify({ answer: 'An example uses ``` inside text.' })),
  );
  expect(await aiGenerateObject(schema, opts)).toEqual({
    answer: 'An example uses ``` inside text.',
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
