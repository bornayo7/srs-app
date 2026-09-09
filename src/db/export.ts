import { db } from './db';
import { blobToBase64 } from './blobCodec';
import { downloadBlob } from '@/services/download';
import { isLocalOnlyMetaKey } from './metaKeys';

export const EXPORT_FORMAT_VERSION = 2;

/**
 * Meta rows that must never leave this browser:
 * - the exchange dir handle is a FileSystemDirectoryHandle (structured-cloneable
 *   for IndexedDB but NOT JSON-serializable — it would export as {} and restore
 *   as a dead handle)
 * - AI keys are secrets; backup files get shared, keys should not.
 */

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
    plans?: unknown[]; // P4
    proposals?: unknown[]; // P4
    cardTombstones?: unknown[];
    packetReceipts?: unknown[];
    dailyLessons?: unknown[];
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
  // Capture all rows and Blob references in one snapshot; encode afterward.
  const captured = await db.transaction('r', db.tables, async () => ({
    courses: await db.courses.toArray(),
    ladders: await db.ladders.toArray(),
    itemTypes: await db.itemTypes.toArray(),
    items: await db.items.toArray(),
    cards: await db.cards.toArray(),
    reviewLogs: await db.reviewLogs.toArray(),
    meta: (await db.meta.toArray()).filter((row) => !isLocalOnlyMetaKey(row.key)),
    captures: await db.captures.toArray(),
    media: await db.media.toArray(),
    plans: await db.plans.toArray(),
    proposals: await db.proposals.toArray(),
    cardTombstones: await db.cardTombstones.toArray(),
    packetReceipts: await db.packetReceipts.toArray(),
    dailyLessons: await db.dailyLessons.toArray(),
  }));
  const media: ExportedMedia[] = await Promise.all(
    captured.media.map(async (m) => ({
      id: m.id,
      mimeType: m.mimeType,
      name: m.name,
      createdAt: m.createdAt,
      data: await blobToBase64(m.blob),
    })),
  );
  return {
    app: 'srs-app' as const,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: now,
    data: { ...captured, media },
  };
}

export function downloadBackup(backup: BackupFile): void {
  const stamp = new Date(backup.exportedAt).toISOString().slice(0, 10);
  downloadBlob(
    new Blob([JSON.stringify(backup)], { type: 'application/json' }),
    `srs-backup-${stamp}.json`,
  );
}
