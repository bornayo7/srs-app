import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { db } from '@/db/db';
import { aiConfigReady, getAiConfig, saveAiSettings } from './config';

beforeEach(async () => {
  await db.meta.clear();
});
afterEach(() => vi.restoreAllMocks());
const openai = {
  provider: 'openai' as const,
  anthropicModel: 'unused',
  openaiBaseUrl: 'http://localhost:11434/v1',
  openaiModel: 'local-model',
};

it('rejects unsafe endpoints before changing the active configuration', async () => {
  const before = await getAiConfig();
  await expect(
    saveAiSettings({
      ...openai,
      openaiBaseUrl: 'https://user:password@example.com/v1',
      apiKey: 'placeholder',
    }),
  ).rejects.toThrow('without credentials');
  expect(await getAiConfig()).toEqual(before);
});

it('rolls back destination and credentials when saving any setting fails', async () => {
  await saveAiSettings({
    ...openai,
    provider: 'anthropic',
    anthropicModel: 'original-model',
    apiKey: 'original-placeholder',
  });
  const before = await getAiConfig();
  const put = db.meta.put.bind(db.meta);
  vi.spyOn(db.meta, 'put').mockImplementation((row, ...rest) => {
    if (row.key === 'ai:openaiModel') throw new Error('Storage unavailable');
    return put(row, ...rest);
  });
  await expect(saveAiSettings({ ...openai, apiKey: 'new-placeholder' })).rejects.toThrow(
    'Storage unavailable',
  );
  expect(await getAiConfig()).toEqual(before);
});

it('preserves an omitted key, removes an explicit empty key, and checks the exact OpenAI hostname', async () => {
  await saveAiSettings({ ...openai, apiKey: 'placeholder' });
  await saveAiSettings(openai);
  expect((await getAiConfig()).openai.apiKey).toBe('placeholder');
  await saveAiSettings({ ...openai, apiKey: '' });
  const local = await getAiConfig();
  expect(local.openai.apiKey).toBeNull();
  expect(aiConfigReady(local)).toBe(true);
  expect(
    aiConfigReady({ ...local, openai: { ...local.openai, baseUrl: 'https://api.openai.com/v1' } }),
  ).toBe(false);
  expect(
    aiConfigReady({
      ...local,
      openai: { ...local.openai, baseUrl: 'https://api.openai.com.example.test/v1' },
    }),
  ).toBe(true);
});
