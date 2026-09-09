import { beforeEach, expect, it } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { exportAll } from '@/db/export';
import { importAll } from '@/db/import';
import { parsePacket } from './schema';
import { applyPacket } from './importPacket';

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()));
  await ensurePresets();
});
const packet = (mimeType: string, data: string) => ({
  format: 'srs-packet',
  version: 2,
  kind: 'create-course',
  course: { name: 'Media integrity' },
  itemTypes: [
    {
      name: 'Basic',
      fields: [{ name: 'Front' }, { name: 'Back' }],
      templates: [{ name: 'Recall', promptFields: ['Front'], answerField: 'Back' }],
    },
  ],
  items: [{ fields: { Front: 'q', Back: 'a' } }],
  media: [{ key: 'unused', name: 'attachment', mimeType, data }],
});

it('rejects unsupported MIME types even for unreferenced packaged attachments', async () => {
  await expect(
    Promise.resolve().then(() =>
      applyPacket(parsePacket(packet('text/plain', btoa('unused'))), 100),
    ),
  ).rejects.toThrow(/media|type/i);
  expect(await db.courses.count()).toBe(0);
  expect(await db.media.count()).toBe(0);
});

it('rejects malformed base64 at the packet boundary before writing a course', () => {
  for (const data of ['not base64!', 'a', 'a===', 'YW Jj']) {
    expect(() => parsePacket(packet('image/png', data))).toThrow(/base64/i);
  }
});

it('every accepted packaged attachment can round-trip in a study backup', async () => {
  await applyPacket(parsePacket(packet('audio/ogg', btoa('test bytes'))), 100);
  await expect(importAll(await exportAll(200))).resolves.toEqual({ courses: 1, items: 1 });
  expect((await db.media.toArray())[0].mimeType).toBe('audio/ogg');
});
