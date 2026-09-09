import { db, ensurePresets } from './db';
import { base64ToBlob } from './blobCodec';
import { decodeBackup } from './backupCodec';
import { isLocalOnlyMetaKey } from './metaKeys';
import { clearMediaUrlCache } from '@/services/media';
import { newId } from '@/engine/ids';
export { backupSchema, decodeBackup } from './backupCodec';

/** Validate a complete candidate before atomically replacing study data. */
export async function importAll(raw: unknown): Promise<{ courses: number; items: number }> {
  const { data } = decodeBackup(raw);
  // Reusing ids/counters from a backup must never revive another tab's stale command.
  const generation = newId();
  for (const rows of [data.items, data.itemTypes, data.cards])
    for (const row of rows) row.generation = generation;
  const media = data.media.map(({ data: bytes, ...asset }) => ({
    ...asset,
    blob: base64ToBlob(bytes, asset.mimeType),
  }));
  await db.transaction('rw', db.tables, async () => {
    const local = (await db.meta.toArray()).filter((row) => isLocalOnlyMetaKey(row.key));
    await Promise.all(db.tables.map((table) => table.clear()));
    await db.courses.bulkAdd(data.courses);
    await db.ladders.bulkAdd(data.ladders);
    await db.itemTypes.bulkAdd(data.itemTypes);
    await db.items.bulkAdd(data.items);
    await db.cards.bulkAdd(data.cards);
    await db.reviewLogs.bulkAdd(data.reviewLogs);
    await db.media.bulkAdd(media);
    await db.captures.bulkAdd(data.captures);
    await db.plans.bulkAdd(data.plans);
    await db.proposals.bulkAdd(data.proposals);
    // Tombstones exist only to authorize in-flight undo; restored logs are history.
    await db.packetReceipts.bulkAdd(data.packetReceipts);
    await db.dailyLessons.bulkAdd(data.dailyLessons);
    await db.meta.bulkPut(data.meta.filter((row) => !isLocalOnlyMetaKey(row.key)));
    await db.meta.bulkPut(local);
    await ensurePresets();
  });
  clearMediaUrlCache();
  return { courses: data.courses.length, items: data.items.length };
}

/** Deliberate study reset leaves this device's credentials and connections intact. */
export async function resetStudyData(): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    const local = (await db.meta.toArray()).filter((row) => isLocalOnlyMetaKey(row.key));
    await Promise.all(db.tables.map((table) => table.clear()));
    await db.meta.bulkPut(local);
    await ensurePresets();
  });
  clearMediaUrlCache();
}
