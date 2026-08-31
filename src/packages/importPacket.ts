import { db } from '@/db/db';
import { createCourse } from '@/db/repo/courses';
import { createItemType, type SimpleTypeSpec } from '@/db/repo/itemTypes';
import { createItem, type CreateItemInput } from '@/db/repo/items';
import type { Course, FieldValue, ItemType } from '@/engine/types';
import type { CreateCoursePacket, AddItemsPacket, Packet, PacketItem } from './schema';

export interface ImportResult {
  courseId: string;
  courseName: string;
  itemsAdded: number;
  warnings: string[];
}

const TYPE_COLORS = ['#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#14b8a6'];

/**
 * Resolve one packet item against a concrete ItemType: field names → field ids,
 * synonyms → templateId map. Throws with a precise message on any mismatch so
 * bad packets fail atomically before a single row is written.
 */
function resolveItem(
  item: PacketItem,
  itemType: ItemType,
  index: number,
): Pick<CreateItemInput, 'fieldValues' | 'synonyms' | 'note' | 'level'> {
  const fieldByName = new Map(itemType.fields.map((f) => [f.name.toLowerCase(), f]));
  const fieldValues: Record<string, FieldValue> = {};

  for (const [name, value] of Object.entries(item.fields)) {
    const field = fieldByName.get(name.toLowerCase());
    if (!field) {
      const valid = itemType.fields.map((f) => `"${f.name}"`).join(', ');
      throw new Error(
        `Item ${index + 1}: unknown field "${name}" for type "${itemType.name}" (valid: ${valid})`,
      );
    }
    fieldValues[field.id] = value;
  }

  for (const tpl of itemType.templates) {
    const answer = fieldValues[tpl.answerFieldId];
    // arrays must contain actual content — [""] is not an answer
    const present =
      typeof answer === 'string'
        ? answer.trim().length > 0
        : (answer ?? []).some((v) => typeof v === 'string' && v.trim().length > 0);
    if (!present) {
      const answerName = itemType.fields.find((f) => f.id === tpl.answerFieldId)?.name;
      throw new Error(
        `Item ${index + 1}: missing answer field "${answerName}" (needed by template "${tpl.name}")`,
      );
    }
  }

  const synonyms: Record<string, string[]> = {};
  if (Array.isArray(item.synonyms)) {
    const cleaned = item.synonyms.filter((s) => s.trim().length > 0);
    if (cleaned.length > 0) {
      if (itemType.templates.length > 1) {
        // Applying loose synonyms to every template would make e.g. a meaning
        // synonym an accepted READING answer, defeating wrong-facet grading.
        throw new Error(
          `Item ${index + 1}: type "${itemType.name}" has ${itemType.templates.length} templates — use the record form of synonyms ({"templateName": [...]}) instead of a plain array`,
        );
      }
      synonyms[itemType.templates[0].id] = cleaned;
    }
  } else if (item.synonyms) {
    const tplByName = new Map(itemType.templates.map((t) => [t.name.toLowerCase(), t]));
    for (const [tplName, syns] of Object.entries(item.synonyms)) {
      const tpl = tplByName.get(tplName.toLowerCase());
      if (!tpl) {
        throw new Error(`Item ${index + 1}: unknown template "${tplName}" in synonyms`);
      }
      synonyms[tpl.id] = syns;
    }
  }

  return { fieldValues, synonyms, note: item.note ?? '', level: item.level };
}

function pickType(item: PacketItem, types: ItemType[], index: number): ItemType {
  if (!item.type) {
    if (types.length === 1) return types[0];
    throw new Error(
      `Item ${index + 1}: "type" is required — the course has ${types.length} item types`,
    );
  }
  const found = types.find((t) => t.name.toLowerCase() === item.type!.toLowerCase());
  if (!found) {
    throw new Error(
      `Item ${index + 1}: unknown item type "${item.type}" (valid: ${types.map((t) => t.name).join(', ')})`,
    );
  }
  return found;
}

async function applyCreateCourse(packet: CreateCoursePacket, now: number): Promise<ImportResult> {
  const presetId = `preset-${packet.course.ladderPreset ?? 'classic'}`;
  return db.transaction(
    'rw',
    [db.courses, db.ladders, db.itemTypes, db.items, db.cards],
    async () => {
      // auto-suffix on name collision so add-items-by-name stays unambiguous
      const warnings: string[] = [];
      const existingNames = new Set(
        (await db.courses.toArray()).map((c) => c.name.toLowerCase()),
      );
      let name = packet.course.name;
      for (let n = 2; existingNames.has(name.toLowerCase()); n++) {
        name = `${packet.course.name} (${n})`;
      }
      if (name !== packet.course.name) {
        warnings.push(`A course named "${packet.course.name}" already exists — imported as "${name}".`);
      }

      const course = await createCourse(
        {
          name,
          description: packet.course.description,
          ladderPresetId: presetId,
          newPerDay: packet.course.newPerDay,
          batchSize: packet.course.batchSize,
        },
        now,
      );

      const types: ItemType[] = [];
      for (const [i, typeSpec] of packet.itemTypes.entries()) {
        const spec: SimpleTypeSpec = {
          name: typeSpec.name,
          color: typeSpec.color ?? TYPE_COLORS[i % TYPE_COLORS.length],
          icon: typeSpec.icon ?? '📦',
          fields: typeSpec.fields.map((f) => ({ name: f.name, kind: f.kind ?? 'text' })),
          templates: typeSpec.templates.map((t) => {
            // resolve case-insensitively like every other name lookup, and
            // canonicalize to the declared field names
            const canonical = new Map(typeSpec.fields.map((f) => [f.name.toLowerCase(), f.name]));
            const resolve = (ref: string): string => {
              const name = canonical.get(ref.toLowerCase());
              if (!name) {
                throw new Error(
                  `Type "${typeSpec.name}", template "${t.name}": references unknown field "${ref}"`,
                );
              }
              return name;
            };
            return {
              name: t.name,
              promptFieldNames: t.promptFields.map(resolve),
              answerFieldName: resolve(t.answerField),
              grading: {
                mode: 'typed' as const,
                answerLang: t.answerLang ?? 'latin',
                typoTolerance: t.typoTolerance ?? true,
              },
            };
          }),
        };
        types.push(await createItemType(course.id, spec, now));
      }

      let stamp = now;
      for (const [i, item] of packet.items.entries()) {
        const itemType = pickType(item, types, i);
        const resolved = resolveItem(item, itemType, i);
        await createItem(
          { courseId: course.id, typeId: itemType.id, ...resolved },
          stamp++,
        );
      }

      return {
        courseId: course.id,
        courseName: course.name,
        itemsAdded: packet.items.length,
        warnings,
      };
    },
  );
}

async function applyAddItems(packet: AddItemsPacket, now: number): Promise<ImportResult> {
  return db.transaction('rw', [db.courses, db.itemTypes, db.items, db.cards], async () => {
    let course: Course | undefined;
    if (packet.courseId) course = await db.courses.get(packet.courseId);
    if (!course && packet.courseName) {
      const all = await db.courses.toArray();
      const matches = all.filter(
        (c) => c.name.toLowerCase() === packet.courseName!.toLowerCase(),
      );
      if (matches.length > 1) {
        throw new Error(
          `${matches.length} courses are named "${packet.courseName}" — target by courseId instead`,
        );
      }
      course = matches[0];
    }
    if (!course) {
      throw new Error(
        `Course not found (${packet.courseId ?? packet.courseName ?? 'no courseId/courseName given'})`,
      );
    }

    const types = await db.itemTypes.where('courseId').equals(course.id).toArray();
    if (types.length === 0) throw new Error(`Course "${course.name}" has no item types`);

    let stamp = now;
    for (const [i, item] of packet.items.entries()) {
      const itemType = pickType(item, types, i);
      const resolved = resolveItem(item, itemType, i);
      await createItem({ courseId: course.id, typeId: itemType.id, ...resolved }, stamp++);
    }

    return {
      courseId: course.id,
      courseName: course.name,
      itemsAdded: packet.items.length,
      warnings: [],
    };
  });
}

/** Apply a validated packet to the database — atomic: any error rolls back everything. */
export async function applyPacket(packet: Packet, now: number): Promise<ImportResult> {
  if (packet.kind === 'create-course') return applyCreateCourse(packet, now);
  return applyAddItems(packet, now);
}

/**
 * Dry-run validation of items against a course's types — per-item error or
 * null. Lets preview UIs (AI generation) mark bad rows instead of failing the
 * whole atomic import.
 */
export async function validateItemsForCourse(
  courseId: string,
  items: PacketItem[],
): Promise<(string | null)[]> {
  const types = await db.itemTypes.where('courseId').equals(courseId).toArray();
  return items.map((item, i) => {
    try {
      const itemType = pickType(item, types, i);
      resolveItem(item, itemType, i);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  });
}
