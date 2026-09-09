import Dexie, { type Table } from 'dexie';
import type {
  Capture,
  CardTombstone,
  Card,
  Course,
  CoursePlan,
  DailyLesson,
  Item,
  ItemType,
  MediaAsset,
  MetaRow,
  Proposal,
  PacketReceipt,
  ReviewLog,
  SrsLadder,
} from '@/engine/types';
import { LADDER_PRESETS } from '@/engine/scheduler/presets';
import { localDayKey } from '@/engine/time';
import { LEGACY_GENERATION } from '@/engine/revision';

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
  plans!: Table<CoursePlan, string>;
  proposals!: Table<Proposal, string>;
  cardTombstones!: Table<CardTombstone, string>;
  packetReceipts!: Table<PacketReceipt, string>;
  dailyLessons!: Table<DailyLesson, string>;

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
    // v3: progressive course plans + the AI proposal review queue (additive)
    this.version(3).stores({
      plans: 'id, courseId',
      proposals: 'id, courseId, planId, [courseId+status], [courseId+level+status]',
    });
    this.version(4)
      .stores({
        reviewLogs: 'id, cardId, itemId, courseId, ts, [courseId+ts], [sessionId+ts]',
        cardTombstones: 'id, itemId, courseId, templateId',
        packetReceipts: 'id, *courseIds',
      })
      .upgrade(async (tx) => {
        // Old logs remain readable but cannot authorize undo. Their timestamps
        // cannot establish which operation is still current.
        for (const table of ['cards', 'items', 'itemTypes']) {
          await tx.table(table).toCollection().modify({ rev: 0 });
        }
      });
    this.version(5)
      .stores({ dailyLessons: 'id, courseId' })
      .upgrade(async (tx) => {
        const days = new Map<string, DailyLesson>();
        for (const log of await tx.table<ReviewLog>('reviewLogs').toArray()) {
          if (log.kind !== 'lesson') continue;
          const day = localDayKey(log.ts);
          const id = `${log.courseId}:${day}`;
          const row = days.get(id) ?? { id, courseId: log.courseId, day, itemIds: [] };
          if (!row.itemIds.includes(log.itemId)) row.itemIds.push(log.itemId);
          days.set(id, row);
        }
        await tx.table('dailyLessons').bulkAdd([...days.values()]);
      });
    this.version(6)
      .stores({})
      .upgrade(async (tx) => {
        for (const table of ['cards', 'items', 'itemTypes', 'cardTombstones']) {
          await tx.table(table).toCollection().modify({ generation: LEGACY_GENERATION });
        }
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

let persistenceRequest: Promise<boolean> | null = null;
/** Report actual persistence, coalescing overlapping requests and allowing retries. */
export function requestPersistentStorage(): Promise<boolean> {
  if (persistenceRequest) return persistenceRequest;
  persistenceRequest = (async () => {
    try {
      if (typeof navigator === 'undefined' || !navigator.storage) return false;
      if (await navigator.storage.persisted?.()) return true;
      return navigator.storage.persist ? await navigator.storage.persist() : false;
    } catch {
      return false;
    }
  })().finally(() => {
    persistenceRequest = null;
  });
  return persistenceRequest;
}

export async function isStoragePersisted(): Promise<boolean | null> {
  try {
    if (navigator.storage?.persisted) return await navigator.storage.persisted();
  } catch {
    // fall through
  }
  return null;
}
