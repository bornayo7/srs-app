import { db } from './db';
import { blobToBase64 } from './blobCodec';

export const EXPORT_FORMAT_VERSION = 1;

/**
 * Meta rows that must never leave this browser:
 * - the exchange dir handle is a FileSystemDirectoryHandle (structured-cloneable
 *   for IndexedDB but NOT JSON-serializable — it would export as {} and restore
 *   as a dead handle)
 * - AI keys are secrets; backup files get shared, keys should not.
 */
const NON_EXPORTABLE_META_KEYS = new Set(['exchange:dirHandle', 'ai:apiKey', 'ai:openaiKey']);

export interface BackupFile {
  app: 'srs-app';
  formatVersion: number;
  exportedAt: number;
  data: {
    courses: unknown[];
    ladders: unknown[];
    itemTypes: unknown[];
    items: unknown[];
    cards: unknown[];
    reviewLogs: unknown[];
    meta: unknown[];
    captures?: unknown[];
    media?: unknown[];
  };
}

/** One media asset, base64-inlined so a backup stays a single JSON file. */
export interface ExportedMedia {
  id: string;
  mimeType: string;
  name: string;
  createdAt: number;
  data: string; // base64
}

/**
 * Full-database JSON backup. Media blobs are base64-inlined — they're
 * downscaled on ingest, so this stays reasonable at personal scale.
 */
export async function exportAll(now: number): Promise<BackupFile> {
  // encode outside the transaction: awaiting blob.arrayBuffer() inside a Dexie
  // transaction would let it commit out from under us
  const media: ExportedMedia[] = await Promise.all(
    (await db.media.toArray()).map(async (m) => ({
      id: m.id,
      mimeType: m.mimeType,
      name: m.name,
      createdAt: m.createdAt,
      data: await blobToBase64(m.blob),
    })),
  );
  return db.transaction(
    'r',
    [db.courses, db.ladders, db.itemTypes, db.items, db.cards, db.reviewLogs, db.meta, db.captures],
    async () => ({
      app: 'srs-app' as const,
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: now,
      data: {
        courses: await db.courses.toArray(),
        ladders: await db.ladders.toArray(),
        itemTypes: await db.itemTypes.toArray(),
        items: await db.items.toArray(),
        cards: await db.cards.toArray(),
        reviewLogs: await db.reviewLogs.toArray(),
        meta: (await db.meta.toArray()).filter((row) => !NON_EXPORTABLE_META_KEYS.has(row.key)),
        captures: await db.captures.toArray(),
        media,
      },
    }),
  );
}

export function downloadBackup(backup: BackupFile): void {
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date(backup.exportedAt).toISOString().slice(0, 10);
  a.href = url;
  a.download = `srs-backup-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
