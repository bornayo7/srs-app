import { db } from '../db';
import { createCourse } from '../repo/courses';
import { createItem } from '../repo/items';
import { createItemType, type SimpleTypeSpec } from '../repo/itemTypes';
import { DEFAULT_PASS_PERCENT } from '@/engine/levels';
import type { ClozeSentence, FieldValue, ItemType } from '@/engine/types';

export interface SeedItem {
  /** Item type NAME — required only when the seed defines several types. */
  type?: string;
  /** Local handle other seed items can list as a prerequisite. */
  key?: string;
  /** Keys of items defined EARLIER in this seed. */
  prereqs?: string[];
  level?: number;
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
  /** One or more item types. */
  types: SimpleTypeSpec[];
  /** Level gating (WaniKani-style) — omit for a flat course. */
  levels?: { gateTypeNames?: string[]; passPercent?: number };
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

  const types: ItemType[] = [];
  for (const spec of seed.types) types.push(await createItemType(course.id, spec, now));

  if (seed.levels) {
    const gateTypeIds = (seed.levels.gateTypeNames ?? []).map((name) => {
      const id = types.find((t) => t.name === name)?.id;
      // silently dropping this would flip the gate to "all types count"
      if (!id) throw new Error(`seed "${seed.key}": unknown gate type "${name}"`);
      return id;
    });
    await db.courses.put({
      ...course,
      levelMode: 'levels',
      levelConfig: {
        gateTypeIds,
        passPercent: seed.levels.passPercent ?? DEFAULT_PASS_PERCENT,
      },
      updatedAt: now,
    });
  }

  let itemStamp = now; // strictly increasing so the lesson queue follows authored order
  const idByKey = new Map<string, string>();
  for (const si of seed.items) {
    const itemType = si.type ? types.find((t) => t.name === si.type) : types[0];
    if (!itemType) throw new Error(`seed "${seed.key}": unknown item type "${si.type}"`);

    const fieldIdByName = new Map(itemType.fields.map((f) => [f.name, f.id]));
    const templateIdByName = new Map(itemType.templates.map((t) => [t.name, t.id]));

    const fieldValues: Record<string, FieldValue> = {};
    for (const [name, value] of Object.entries(si.fields)) {
      const id = fieldIdByName.get(name);
      // a dropped field would produce an item with no answer — fail loudly
      if (!id) throw new Error(`seed "${seed.key}": type "${itemType.name}" has no field "${name}"`);
      fieldValues[id] = value;
    }
    const synonyms: Record<string, string[]> = {};
    for (const [tplName, syns] of Object.entries(si.synonyms ?? {})) {
      const id = templateIdByName.get(tplName);
      if (!id) {
        throw new Error(`seed "${seed.key}": type "${itemType.name}" has no template "${tplName}"`);
      }
      synonyms[id] = syns;
    }
    const created = await createItem(
      {
        courseId: course.id,
        typeId: itemType.id,
        fieldValues,
        synonyms,
        note: si.note,
        level: si.level,
        prereqIds: (si.prereqs ?? []).map((k) => {
          const id = idByKey.get(k);
          if (!id) throw new Error(`seed "${seed.key}": prereq "${k}" is not defined earlier`);
          return id;
        }),
      },
      itemStamp++,
    );
    if (si.key) idByKey.set(si.key, created.id);
  }

  await db.meta.put({
    key: `seed:${seed.key}`,
    value: { courseId: course.id, installedAt: now },
  });
  return course.id;
}
