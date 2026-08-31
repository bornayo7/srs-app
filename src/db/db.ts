import Dexie, { type Table } from 'dexie';
import type {
  Capture,
  Card,
  Course,
  Item,
  ItemType,
  MediaAsset,
  MetaRow,
  ReviewLog,
  SrsLadder,
} from '@/engine/types';
import { LADDER_PRESETS } from '@/engine/scheduler/presets';

export class SrsDB extends Dexie {
  courses!: Table<Course, string>;
  ladders!: Table<SrsLadder, string>;
  itemTypes!: Table<ItemType, string>;
  items!: Table<Item, string>;
  cards!: Table<Card, string>;
  reviewLogs!: Table<ReviewLog, string>;
  media!: Table<MediaAsset, string>;
  meta!: Table<MetaRow, string>;
  captures!: Table<Capture, string>;

  constructor(name = 'srs-app') {
    super(name);
    this.version(1).stores({
      courses: 'id, updatedAt',
      ladders: 'id, courseId',
      itemTypes: 'id, courseId',
      items: 'id, courseId, typeId, *prereqIds, [courseId+status], [courseId+level]',
      cards: 'id, itemId, templateId, [courseId+state+dueAt], [state+dueAt], [courseId+state]',
      reviewLogs: 'id, cardId, ts, [courseId+ts], [sessionId+ts]',
      media: 'id',
      meta: 'key',
    });
    // v2: quick-capture inbox (additive — never edit past versions)
    this.version(2).stores({
      captures: 'id, createdAt',
    });
  }
}

export const db = new SrsDB();

/** Ensure the built-in ladder presets exist (idempotent). */
export async function ensurePresets(dbi: SrsDB = db): Promise<void> {
  await dbi.ladders.bulkPut(
    LADDER_PRESETS.filter(
      (p) => p.isPreset,
    ) /* presets are immutable rows; bulkPut refreshes them on app updates */,
  );
}

let persistRequested = false;
/** Ask the browser not to evict our IndexedDB. Call once after first real write. */
export async function requestPersistentStorage(): Promise<boolean> {
  if (persistRequested) return true;
  persistRequested = true;
  try {
    if (navigator.storage?.persist) {
      return await navigator.storage.persist();
    }
  } catch {
    // ignore — treated as not persisted
  }
  return false;
}

export async function isStoragePersisted(): Promise<boolean | null> {
  try {
    if (navigator.storage?.persisted) return await navigator.storage.persisted();
  } catch {
    // fall through
  }
  return null;
}
