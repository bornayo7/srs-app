import { beforeEach, expect, it } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { createCourseWithType } from '@/services/contentCommands';
import { deleteCourse } from '@/db/repo/courses';
import { parsePacket } from './schema';
import { applyPacket } from './importPacket';

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()));
  await ensurePresets();
});

it('never retargets a packet to another course when its explicit target id was deleted', async () => {
  const input = { name: 'Same name', ladderPresetId: 'preset-classic' };
  const original = await createCourseWithType(input, 100);
  const packet = parsePacket({
    format: 'srs-packet',
    version: 2,
    kind: 'add-items',
    courseId: original.id,
    courseName: original.name,
    items: [{ fields: { Front: 'q', Back: 'a' } }],
  });
  await deleteCourse(original.id);
  const replacement = await createCourseWithType(input, 200);
  await expect(applyPacket(packet, 300)).rejects.toThrow(/not found/i);
  expect(await db.items.where('courseId').equals(replacement.id).count()).toBe(0);
});

it('still supports an unambiguous name when the packet has no target id', async () => {
  const course = await createCourseWithType(
    { name: 'Named target', ladderPresetId: 'preset-classic' },
    100,
  );
  const packet = parsePacket({
    format: 'srs-packet',
    version: 2,
    kind: 'add-items',
    courseName: course.name,
    items: [{ fields: { Front: 'q', Back: 'a' } }],
  });
  expect((await applyPacket(packet, 200)).courseId).toBe(course.id);
});
