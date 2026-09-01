import { db } from '@/db/db';
import { createCourse } from '@/db/repo/courses';
import { createItemType, type SimpleTypeSpec } from '@/db/repo/itemTypes';
import { createItem, type CreateItemInput } from '@/db/repo/items';
import { createPlan } from '@/db/repo/plans';
import { addProposals, findDuplicate, type ProposalDraft } from '@/db/repo/proposals';
import { extractBlank, isClozeSentences } from '@/engine/grading/cloze';
import { DEFAULT_CHOICE_COUNT } from '@/engine/grading/choice';
import { DEFAULT_PASS_PERCENT } from '@/engine/levels';
import type { Course, FieldValue, Item, ItemType, ProposalSource } from '@/engine/types';
import { parseReleaseAt } from './schema';
import type {
  AddItemsPacket,
  CoursePlanPacket,
  CreateCoursePacket,
  Packet,
  PacketItem,
  ProposeItemsPacket,
} from './schema';

export interface ImportResult {
  courseId: string;
  courseName: string;
  itemsAdded: number;
  /** Items parked in the review queue instead of the course (course-plan / propose-items). */
  proposalsAdded: number;
  warnings: string[];
}

export interface ApplyOptions {
  /** Who drafted the proposals a course-plan / propose-items packet carries. Default 'mcp'. */
  source?: ProposalSource;
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
    const answerName = itemType.fields.find((f) => f.id === tpl.answerFieldId)?.name;
    if (tpl.grading.mode === 'sentenceCloze') {
      if (!isClozeSentences(answer) || !answer.some((s) => extractBlank(s) !== null)) {
        throw new Error(
          `Item ${index + 1}: "${answerName}" needs at least one sentence with a ⟦blank⟧ (template "${tpl.name}")`,
        );
      }
      continue;
    }
    // arrays must contain actual content — [""] is not an answer
    const present =
      typeof answer === 'string'
        ? answer.trim().length > 0
        : (answer ?? []).some((v) => typeof v === 'string' && v.trim().length > 0);
    if (!present) {
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

/** Packet type spec → the repo's SimpleTypeSpec (field refs resolved case-insensitively). */
function toTypeSpec(
  typeSpec: CreateCoursePacket['itemTypes'][number],
  index: number,
): SimpleTypeSpec {
  // canonicalize references to the declared field names
  const canonical = new Map(typeSpec.fields.map((f) => [f.name.toLowerCase(), f.name]));
  return {
    name: typeSpec.name,
    color: typeSpec.color ?? TYPE_COLORS[index % TYPE_COLORS.length],
    icon: typeSpec.icon ?? '📦',
    fields: typeSpec.fields.map((f) => ({ name: f.name, kind: f.kind ?? 'text' })),
    templates: typeSpec.templates.map((t) => {
      const resolve = (ref: string): string => {
        const name = canonical.get(ref.toLowerCase());
        if (!name) {
          throw new Error(
            `Type "${typeSpec.name}", template "${t.name}": references unknown field "${ref}"`,
          );
        }
        return name;
      };
      const answerFieldName = resolve(t.answerField);
      const answerKind = typeSpec.fields.find((f) => f.name === answerFieldName)?.kind;
      return {
        name: t.name,
        promptFieldNames: t.promptFields.map(resolve),
        answerFieldName,
        grading:
          answerKind === 'clozeSentences'
            ? // answering INTO sentences = sentence-cloze; the field id is
              // resolved by createItemType
              { mode: 'sentenceCloze' as const, sentencesFieldId: '', rotation: 'random' as const }
            : t.mode === 'choice'
              ? { mode: 'choice' as const, choices: t.choices ?? DEFAULT_CHOICE_COUNT }
              : {
                  mode: 'typed' as const,
                  answerLang: t.answerLang ?? 'latin',
                  typoTolerance: t.typoTolerance ?? true,
                },
      };
    }),
  };
}

type CourseSpec = CreateCoursePacket['course'];

/**
 * Course + item types from a packet spec, inside the caller's transaction.
 * Shared by create-course and course-plan. Level config is applied after the
 * types exist because gate types are referenced by name.
 */
async function createCourseAndTypes(
  spec: CourseSpec,
  typeSpecs: CreateCoursePacket['itemTypes'],
  now: number,
  overrides: { levelMode?: 'flat' | 'levels'; autoAdvance?: boolean } = {},
): Promise<{ course: Course; types: ItemType[]; warnings: string[] }> {
  // auto-suffix on name collision so add-items-by-name stays unambiguous
  const warnings: string[] = [];
  const existingNames = new Set((await db.courses.toArray()).map((c) => c.name.toLowerCase()));
  let name = spec.name;
  for (let n = 2; existingNames.has(name.toLowerCase()); n++) {
    name = `${spec.name} (${n})`;
  }
  if (name !== spec.name) {
    warnings.push(`A course named "${spec.name}" already exists — imported as "${name}".`);
  }

  const course = await createCourse(
    {
      name,
      description: spec.description,
      ladderPresetId: `preset-${spec.ladderPreset ?? 'classic'}`,
      newPerDay: spec.newPerDay,
      batchSize: spec.batchSize,
    },
    now,
  );

  const types: ItemType[] = [];
  for (const [i, typeSpec] of typeSpecs.entries()) {
    types.push(await createItemType(course.id, toTypeSpec(typeSpec, i), now));
  }

  const levelMode = overrides.levelMode ?? spec.levelMode ?? 'flat';
  if (levelMode !== 'levels') return { course, types, warnings };

  const gateTypeIds = (spec.gateTypes ?? [])
    .map((gate) => types.find((t) => t.name.toLowerCase() === gate.toLowerCase())?.id)
    .filter((id): id is string => !!id);
  // absent = default (true); only stored when a packet or plan decided it
  const autoAdvance = overrides.autoAdvance ?? spec.autoAdvance;
  const levelled: Course = {
    ...course,
    levelMode: 'levels',
    levelConfig: {
      gateTypeIds,
      passPercent: spec.passPercent ?? DEFAULT_PASS_PERCENT,
      ...(autoAdvance !== undefined ? { autoAdvance } : {}),
    },
    updatedAt: now,
  };
  await db.courses.put(levelled);
  return { course: levelled, types, warnings };
}

async function applyCreateCourse(packet: CreateCoursePacket, now: number): Promise<ImportResult> {
  return db.transaction(
    'rw',
    [db.courses, db.ladders, db.itemTypes, db.items, db.cards],
    async () => {
      const { course, types, warnings } = await createCourseAndTypes(
        packet.course,
        packet.itemTypes,
        now,
      );

      let stamp = now;
      const idByKey = new Map<string, string>();
      for (const [i, item] of packet.items.entries()) {
        const itemType = pickType(item, types, i);
        const resolved = resolveItem(item, itemType, i);
        const created = await createItem(
          {
            courseId: course.id,
            typeId: itemType.id,
            ...resolved,
            prereqIds: (item.prereqs ?? []).map((ref) => idByKey.get(ref) ?? ref),
          },
          stamp++,
        );
        if (item.key) idByKey.set(item.key, created.id);
      }

      return {
        courseId: course.id,
        courseName: course.name,
        itemsAdded: packet.items.length,
        proposalsAdded: 0,
        warnings,
      };
    },
  );
}

/** Target course by id (preferred) or exact name — shared by the "existing course" kinds. */
async function resolveTargetCourse(ref: {
  courseId?: string;
  courseName?: string;
}): Promise<Course> {
  let course: Course | undefined;
  if (ref.courseId) course = await db.courses.get(ref.courseId);
  if (!course && ref.courseName) {
    const all = await db.courses.toArray();
    const matches = all.filter((c) => c.name.toLowerCase() === ref.courseName!.toLowerCase());
    if (matches.length > 1) {
      throw new Error(
        `${matches.length} courses are named "${ref.courseName}" — target by courseId instead`,
      );
    }
    course = matches[0];
  }
  if (!course) {
    throw new Error(
      `Course not found (${ref.courseId ?? ref.courseName ?? 'no courseId/courseName given'})`,
    );
  }
  return course;
}

async function applyAddItems(packet: AddItemsPacket, now: number): Promise<ImportResult> {
  return db.transaction('rw', [db.courses, db.itemTypes, db.items, db.cards], async () => {
    const course = await resolveTargetCourse(packet);
    const types = await db.itemTypes.where('courseId').equals(course.id).toArray();
    if (types.length === 0) throw new Error(`Course "${course.name}" has no item types`);

    // prereqs here may reference keys within this packet OR existing item ids
    const existingIds = new Set(
      await db.items.where('courseId').equals(course.id).primaryKeys(),
    );
    let stamp = now;
    const idByKey = new Map<string, string>();
    for (const [i, item] of packet.items.entries()) {
      const itemType = pickType(item, types, i);
      const resolved = resolveItem(item, itemType, i);
      const prereqIds = (item.prereqs ?? []).map((ref) => {
        const id = idByKey.get(ref) ?? ref;
        if (!idByKey.has(ref) && !existingIds.has(id)) {
          throw new Error(
            `Item ${i + 1}: unknown prerequisite "${ref}" — use a "key" defined earlier in this packet, or an existing item id from this course`,
          );
        }
        return id;
      });
      const created = await createItem(
        { courseId: course.id, typeId: itemType.id, ...resolved, prereqIds },
        stamp++,
      );
      if (item.key) idByKey.set(item.key, created.id);
    }

    return {
      courseId: course.id,
      courseName: course.name,
      itemsAdded: packet.items.length,
      proposalsAdded: 0,
      warnings: [],
    };
  });
}

/**
 * Dry-run proposed items against the course's types. A bad row gets an error
 * string instead of failing the batch — the review queue exists so a human can
 * fix or reject it. Duplicates of existing items are flagged, not dropped.
 */
function draftProposals(
  items: PacketItem[],
  types: ItemType[],
  existing: readonly Item[],
  defaultLevel: number,
): ProposalDraft[] {
  return items.map((raw, i) => {
    const level = raw.level ?? defaultLevel;
    const item = { ...raw, level };
    try {
      const itemType = pickType(item, types, i);
      resolveItem(item, itemType, i);
      return { level, item, error: null, duplicateOf: findDuplicate(item, itemType, existing) };
    } catch (err) {
      return { level, item, error: (err as Error).message, duplicateOf: null };
    }
  });
}

/**
 * A planned course: course + types in levels mode, one level per unit, the
 * plan row, and every unit's items parked as pending proposals. Nothing enters
 * the lesson queue until a human accepts it.
 */
async function applyCoursePlan(
  packet: CoursePlanPacket,
  now: number,
  source: ProposalSource,
): Promise<ImportResult> {
  const releaseMode = packet.course.releaseMode ?? 'progress';
  return db.transaction(
    'rw',
    [db.courses, db.ladders, db.itemTypes, db.items, db.cards, db.plans, db.proposals],
    async () => {
      const { course, types, warnings } = await createCourseAndTypes(
        packet.course,
        packet.itemTypes,
        now,
        {
          levelMode: 'levels',
          // progress mode lets the level engine advance; the other two own the level
          autoAdvance: packet.course.autoAdvance ?? releaseMode === 'progress',
        },
      );

      const plan = await createPlan(
        {
          courseId: course.id,
          title: course.name,
          material: packet.material ?? '',
          releaseMode,
          units: packet.units.map((u) => {
            const releaseAt = parseReleaseAt(u.releaseAt);
            return {
              title: u.title,
              summary: u.summary ?? '',
              topics: u.topics ?? [],
              targetCount: u.targetCount ?? u.items?.length ?? 0,
              ...(releaseAt !== null ? { releaseAt } : {}),
            };
          }),
        },
        now,
      );
      if (releaseMode === 'schedule' && plan.units.some((u) => u.releaseAt === undefined)) {
        warnings.push(
          'Some units have no release date — they will only open when released by hand.',
        );
      }

      let proposalsAdded = 0;
      for (const unit of plan.units) {
        const items = packet.units[unit.level - 1].items ?? [];
        if (items.length === 0) continue;
        // the unit is the authority on level — an item's own level is ignored here
        const drafts = draftProposals(
          items.map((it) => ({ ...it, level: unit.level })),
          types,
          [],
          unit.level,
        );
        await addProposals(course.id, plan.id, source, drafts, now + proposalsAdded);
        proposalsAdded += drafts.length;
      }

      return {
        courseId: course.id,
        courseName: course.name,
        itemsAdded: 0,
        proposalsAdded,
        warnings,
      };
    },
  );
}

/** Items into an existing course's review queue. */
async function applyProposeItems(
  packet: ProposeItemsPacket,
  now: number,
  source: ProposalSource,
): Promise<ImportResult> {
  return db.transaction(
    'rw',
    [db.courses, db.itemTypes, db.items, db.plans, db.proposals],
    async () => {
      const course = await resolveTargetCourse(packet);
      const types = await db.itemTypes.where('courseId').equals(course.id).toArray();
      if (types.length === 0) throw new Error(`Course "${course.name}" has no item types`);
      const existing = await db.items.where('courseId').equals(course.id).toArray();
      const plan = await db.plans.where('courseId').equals(course.id).first();

      const defaultLevel = packet.unit ?? course.currentLevel;
      const drafts = draftProposals(packet.items, types, existing, defaultLevel);

      const warnings: string[] = [];
      if (plan) {
        const beyond = drafts.filter((d) => d.level > plan.units.length).length;
        if (beyond > 0) {
          warnings.push(
            `${beyond} item(s) target a unit past the plan's ${plan.units.length} — accepted items would stay locked until that level exists.`,
          );
        }
      }

      await addProposals(course.id, plan?.id ?? null, source, drafts, now);
      return {
        courseId: course.id,
        courseName: course.name,
        itemsAdded: 0,
        proposalsAdded: drafts.length,
        warnings,
      };
    },
  );
}

/** Apply a validated packet to the database — atomic: any error rolls back everything. */
export async function applyPacket(
  packet: Packet,
  now: number,
  opts: ApplyOptions = {},
): Promise<ImportResult> {
  const source = opts.source ?? 'mcp';
  switch (packet.kind) {
    case 'create-course':
      return applyCreateCourse(packet, now);
    case 'add-items':
      return applyAddItems(packet, now);
    case 'course-plan':
      return applyCoursePlan(packet, now, source);
    case 'propose-items':
      return applyProposeItems(packet, now, source);
  }
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
