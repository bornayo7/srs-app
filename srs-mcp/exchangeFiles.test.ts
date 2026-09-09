import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writePacket, readSnapshot, findCourse } from './exchangeFiles';
import { parsePacket } from '../src/packages/schema';
import { snapshotCourseSchema } from '../src/exchange/snapshotSchema';

const legacyCourse = snapshotCourseSchema.parse({
  id: 'first',
  name: 'Same',
  description: '',
  scheduling: 'ladder',
  lessons: { newPerDay: 10, batchSize: 5 },
  itemTypes: [
    {
      name: 'Card',
      icon: '📘',
      fields: [
        { name: 'Front', kind: 'text' },
        { name: 'Back', kind: 'text' },
      ],
      templates: [{ name: 'Recall', promptFields: ['Front'], answerField: 'Back' }],
    },
  ],
  counts: { items: 0, lessonQueue: 0, active: 0, dueNow: 0, burnedCards: 0, pendingProposals: 0 },
  items: [],
  struggling: [],
  ladder: null,
  itemsTruncated: false,
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true });
});

it('reports published delivery success even if hidden temporary-file cleanup fails', async () => {
  const directory = await temporary();
  vi.spyOn(fs, 'unlink').mockRejectedValueOnce(new Error('Temporary cleanup denied'));
  const fileName = await writePacket(directory, 'cleanup', { format: 'srs-packet', version: 2, kind: 'propose-items', courseId: 'course', items: [{ fields: { Front: 'Q', Back: 'A' } }] });
  expect(parsePacket(JSON.parse(await fs.readFile(path.join(directory, 'inbox', fileName), 'utf8')))).toMatchObject({ kind: 'propose-items', id: expect.any(String) });
});
const temporary = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'srs-exchange-test-'));
  directories.push(directory);
  return directory;
};

it('concurrent packets publish complete JSON with unique authoritative identities', async () => {
  const directory = await temporary();
  const packet = {
    format: 'srs-packet',
    version: 2,
    id: 'caller-id',
    kind: 'propose-items',
    courseId: 'course',
    items: [{ type: 'Sentence', fields: { Sentences: [{ text: 'It is ⟦ready⟧.' }] } }],
  };
  const filenames = await Promise.all(
    Array.from({ length: 20 }, () => writePacket(directory, 'same', packet)),
  );
  expect(new Set(filenames).size).toBe(20);
  const packets = await Promise.all(
    filenames.map(async (filename) =>
      parsePacket(JSON.parse(await fs.readFile(path.join(directory, 'inbox', filename), 'utf8'))),
    ),
  );
  expect(new Set(packets.map((packet) => packet.id)).size).toBe(20);
  expect(packets.every((packet) => packet.id !== 'caller-id')).toBe(true);
  const first = packets[0];
  expect(first.kind === 'propose-items' && first.items[0]).toMatchObject({
    type: 'Sentence',
    fields: { Sentences: [{ text: 'It is ⟦ready⟧.' }] },
  });
  expect(
    (await fs.readdir(path.join(directory, 'inbox'))).filter((name) => name.endsWith('.tmp')),
  ).toEqual([]);
});

it('malformed snapshot rows cannot reach tool rendering', async () => {
  const directory = await temporary();
  await fs.writeFile(
    path.join(directory, 'snapshot.json'),
    JSON.stringify({
      format: 'srs-snapshot',
      version: 1,
      generatedAt: 1,
      courses: [{ id: 'bad' }],
    }),
  );
  await expect(readSnapshot(directory)).rejects.toThrow(/snapshot.json is invalid/);
});

it('course names must resolve unambiguously', () => {
  const course = legacyCourse;
  const snapshot = { courses: [course, { ...course, id: 'second' }] };
  expect(() => findCourse(snapshot, 'Same')).toThrow(/Several courses/);
  expect(findCourse(snapshot, 'second').id).toBe('second');
});

it('reads version-1 snapshots published before grading and hint metadata existed', async () => {
  const directory = await temporary();
  const snapshot = {
    format: 'srs-snapshot',
    version: 1,
    generatedAt: 1,
    localDay: 0,
    courses: [legacyCourse],
  };
  await fs.writeFile(path.join(directory, 'snapshot.json'), JSON.stringify(snapshot));
  expect(await readSnapshot(directory)).toEqual(snapshot);
});
