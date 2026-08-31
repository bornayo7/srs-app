import { db } from '../db';
import { createCourse } from '../repo/courses';
import { createItem } from '../repo/items';
import { createItemType, type SimpleTypeSpec } from '../repo/itemTypes';
import type { ClozeSentence, FieldValue } from '@/engine/types';

export interface SeedItem {
  fields: Record<string, string | ClozeSentence[]>; // field NAME → value
  synonyms?: Record<string, string[]>; // template NAME → synonyms
  note?: string;
}

export interface SeedCourse {
  key: string; // stable identifier stored in meta to prevent double-install
  name: string;
  description: string;
  ladderPresetId: string;
  newPerDay: number;
  batchSize: number;
  type: SimpleTypeSpec;
  items: SeedItem[];
}

export async function isSeedInstalled(seed: SeedCourse): Promise<boolean> {
  return (await db.meta.get(`seed:${seed.key}`)) !== undefined;
}

export async function installSeed(seed: SeedCourse, now: number): Promise<string> {
  return db.transaction(
    'rw',
    [db.courses, db.ladders, db.itemTypes, db.items, db.cards, db.meta],
    () => installSeedInner(seed, now),
  );
}

async function installSeedInner(seed: SeedCourse, now: number): Promise<string> {
  // idempotency inside the transaction — a double-click installs once
  const existing = await db.meta.get(`seed:${seed.key}`);
  if (existing) return (existing.value as { courseId: string }).courseId;

  const course = await createCourse(
    {
      name: seed.name,
      description: seed.description,
      ladderPresetId: seed.ladderPresetId,
      newPerDay: seed.newPerDay,
      batchSize: seed.batchSize,
    },
    now,
  );
  const itemType = await createItemType(course.id, seed.type, now);

  const fieldIdByName = new Map(itemType.fields.map((f) => [f.name, f.id]));
  const templateIdByName = new Map(itemType.templates.map((t) => [t.name, t.id]));

  let itemStamp = now; // strictly increasing so the lesson queue follows authored order
  for (const si of seed.items) {
    const fieldValues: Record<string, FieldValue> = {};
    for (const [name, value] of Object.entries(si.fields)) {
      const id = fieldIdByName.get(name);
      if (id) fieldValues[id] = value;
    }
    const synonyms: Record<string, string[]> = {};
    for (const [tplName, syns] of Object.entries(si.synonyms ?? {})) {
      const id = templateIdByName.get(tplName);
      if (id) synonyms[id] = syns;
    }
    await createItem(
      { courseId: course.id, typeId: itemType.id, fieldValues, synonyms, note: si.note },
      itemStamp++,
    );
  }

  await db.meta.put({ key: `seed:${seed.key}`, value: { courseId: course.id, installedAt: now } });
  return course.id;
}
