import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { createCourse, deleteCourse } from '@/db/repo/courses';
import { createItem, deleteItem, saveItemEdit } from '@/db/repo/items';
import { createItemType, type SimpleTypeSpec } from '@/db/repo/itemTypes';
import { exportAll } from '@/db/export';
import { importAll } from '@/db/import';
import {
  clearMediaUrlCache,
  collectMediaIds,
  deleteOrphanMedia,
  mediaUrl,
  mediaUsage,
  purgeOrphanMedia,
} from './media';
import type { MediaAsset } from '@/engine/types';

const NOW = Date.UTC(2026, 0, 15, 10, 23);

async function wipe() {
  clearMediaUrlCache();
  vi.restoreAllMocks();
  await Promise.all(db.tables.map((t) => t.clear()));
  await ensurePresets();
}
beforeEach(wipe);

function asset(id: string, bytes = [1, 2, 3, 250]): MediaAsset {
  return {
    id,
    blob: new Blob([new Uint8Array(bytes)], { type: 'image/webp' }),
    mimeType: 'image/webp',
    name: `${id}.webp`,
    createdAt: NOW,
  };
}

/** A picture-prompt type: the image is shown, the name is typed. */
const pictureSpec = (): SimpleTypeSpec => ({
  name: 'Picture',
  color: '#0af',
  icon: '🖼️',
  fields: [
    { name: 'Photo', kind: 'image' },
    { name: 'Name', kind: 'text' },
  ],
  templates: [
    {
      name: 'Name it',
      promptFieldNames: ['Photo'],
      answerFieldName: 'Name',
      grading: { mode: 'typed', answerLang: 'latin', typoTolerance: true },
    },
  ],
});

async function seedPictureItem(mediaId: string) {
  const course = await createCourse({ name: 'Faces', ladderPresetId: 'preset-gentle' }, NOW);
  const type = await createItemType(course.id, pictureSpec(), NOW);
  await db.media.add(asset(mediaId));
  const item = await createItem(
    {
      courseId: course.id,
      typeId: type.id,
      fieldValues: { [type.fields[0].id]: mediaId, [type.fields[1].id]: 'Ada' },
    },
    NOW,
  );
  return { course, type, item };
}

describe('media references', () => {
  it('collects only the media fields of a type', async () => {
    const { type, item } = await seedPictureItem('m1');
    expect(collectMediaIds(item, type)).toEqual(['m1']);
  });

  it('keeps assets an item still points at, deletes the rest', async () => {
    await seedPictureItem('m1');
    await db.media.add(asset('loose'));

    expect(await deleteOrphanMedia(['m1'])).toBe(0);
    expect(await db.media.get('m1')).toBeTruthy();
    expect(await purgeOrphanMedia()).toBe(1);
    expect(await db.media.get('loose')).toBeUndefined();
    expect(await db.media.get('m1')).toBeTruthy();
  });

  it('deleting an item frees its image', async () => {
    const { item } = await seedPictureItem('m1');
    await deleteItem(item.id, NOW);
    expect(await db.media.get('m1')).toBeUndefined();
  });

  it('keeps shared media until the last referencing item is removed', async () => {
    const { course, type, item } = await seedPictureItem('shared');
    const other = await createItem(
      { courseId: course.id, typeId: type.id, fieldValues: item.fieldValues },
      NOW,
    );
    await deleteItem(item.id, NOW);
    expect(await db.media.get('shared')).toBeDefined();
    await deleteItem(other.id, NOW);
    expect(await db.media.get('shared')).toBeUndefined();
  });

  it('rolls back media deletion without revoking a displayed URL', async () => {
    const { item } = await seedPictureItem('displayed');
    const url = await mediaUrl('displayed');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    await expect(
      db.transaction('rw', db.tables, async () => {
        await deleteItem(item.id, NOW);
        throw new Error('later command failed');
      }),
    ).rejects.toThrow(/later command/);
    expect(await db.media.get('displayed')).toBeDefined();
    expect(await mediaUrl('displayed')).toBe(url);
    expect(revoke).not.toHaveBeenCalled();
    await deleteItem(item.id, NOW);
    expect(revoke).toHaveBeenCalledWith(url);
  });

  it('deleting a course frees the images its items held, and nothing else', async () => {
    const { course } = await seedPictureItem('m1');
    await db.media.add(asset('unrelated'));
    await deleteCourse(course.id);
    expect(await db.media.get('m1')).toBeUndefined();
    expect(await db.media.get('unrelated')).toBeTruthy();
    expect(await db.items.count()).toBe(0);
  });

  it('replacing an image in the editor frees the old one', async () => {
    const { type, item } = await seedPictureItem('m1');
    await db.media.add(asset('m2'));
    await saveItemEdit(
      { ...item, fieldValues: { ...item.fieldValues, [type.fields[0].id]: 'm2' } },
      NOW + 1,
    );
    expect(await db.media.get('m1')).toBeUndefined();
    expect(await db.media.get('m2')).toBeTruthy();
  });

  it('reports usage', async () => {
    await db.media.add(asset('a', [1, 2, 3]));
    await db.media.add(asset('b', [1, 2, 3, 4, 5]));
    expect(await mediaUsage()).toEqual({ count: 2, bytes: 8 });
  });
});

describe('backups carry media', () => {
  it('round-trips blobs through base64 JSON', async () => {
    const { item, type } = await seedPictureItem('m1');
    const backup = await exportAll(NOW + 5);
    // through JSON, exactly as the file on disk would be
    await importAll(JSON.parse(JSON.stringify(backup)));

    const restored = await db.media.get('m1');
    expect(restored).toBeTruthy();
    expect(restored!.mimeType).toBe('image/webp');
    expect(new Uint8Array(await restored!.blob.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 250]),
    );
    expect((await db.items.get(item.id))!.fieldValues[type.fields[0].id]).toBe('m1');
  });

  it('a backup written before media existed still imports', async () => {
    const backup = await exportAll(NOW);
    backup.formatVersion = 1;
    delete (backup.data as { media?: unknown[] }).media;
    await expect(importAll(JSON.parse(JSON.stringify(backup)))).resolves.toBeTruthy();
  });

  it('replaces cached bytes when a backup reuses a media id', async () => {
    await seedPictureItem('same-id');
    const before = await mediaUrl('same-id');
    const backup = await exportAll(NOW);
    (backup.data.media![0] as { data: string }).data = btoa('replacement bytes');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    await importAll(backup);
    expect(revoke).toHaveBeenCalledWith(before);
    expect(await mediaUrl('same-id')).not.toBe(before);
    expect(await (await db.media.get('same-id'))!.blob.text()).toBe('replacement bytes');
  });
});
