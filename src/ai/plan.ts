import { z } from 'zod';
import { db } from '@/db/db';
import { planForCourse, updatePlan } from '@/db/repo/plans';
import { proposalsForCourse } from '@/db/repo/proposals';
import { itemPreview } from '@/engine/grading/context';
import type { Course, CoursePlan, ItemType, PlanUnit, Proposal } from '@/engine/types';
import { applyPacket } from '@/packages/importPacket';
import { PACKET_FORMAT, PACKET_VERSION, parsePacket, parseReleaseAt } from '@/packages/schema';
import type { PacketItem } from '@/packages/schema';
import type { PlannedCourseInput } from '@/services/plans';
import { aiGenerateObject } from './client';
import { ANSWER_RULES, describeType, toPacketItem } from './generate';

/**
 * Two-stage generation for a course plan:
 *   1. planCourse — read the learner's material once, return an OUTLINE (units
 *      + item types) for review. No items yet.
 *   2. generateUnitItems — items for ONE unit, on demand, into the review
 *      queue. Sends the material again (cached on Anthropic) plus what's
 *      already accepted (don't duplicate) and rejected (avoid similar).
 * Small calls, reviewable steps, and a rerun costs one unit — not the course.
 */

/** ~40k tokens: a semester's notes fit; anything longer is cut with a visible flag. */
export const MATERIAL_CHAR_CAP = 150_000;

export function truncateMaterial(text: string): { material: string; truncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= MATERIAL_CHAR_CAP) return { material: trimmed, truncated: false };
  return { material: trimmed.slice(0, MATERIAL_CHAR_CAP), truncated: true };
}

function materialBlock(plan: Pick<CoursePlan, 'material'>): string | undefined {
  return plan.material ? `COURSE MATERIAL (the learner's own notes/syllabus):\n${plan.material}` : undefined;
}

// ---------- Stage 1: the outline ----------

const plannedTemplate = z.object({
  name: z.string().min(1),
  promptFields: z.array(z.string()).min(1),
  answerField: z.string().min(1),
  mode: z
    .enum(['typed', 'choice'])
    .describe(
      'typed = the learner types a short answer (1-4 words); choice = multiple choice, wrong options drawn from sibling items — use for conceptual questions whose answers are short phrases.',
    ),
});

const plannedItemType = z.object({
  name: z.string().min(1).describe('Singular noun: "Term", "Question", "Formula", "Date"…'),
  icon: z.string().describe('A single emoji.'),
  fields: z.array(z.object({ name: z.string().min(1) })).min(2).describe('2-4 fields.'),
  templates: z
    .array(plannedTemplate)
    .min(1)
    .describe('1-2 templates. Field references use the exact field names.'),
});

const plannedUnit = z.object({
  title: z.string().min(1),
  summary: z.string().describe('One sentence.'),
  topics: z.array(z.string()).describe('3-8 specific things worth remembering from this unit.'),
  targetCount: z.number().int().describe('How many flashcard items this unit deserves, 5-40.'),
  date: z
    .string()
    .describe(
      'ISO date (YYYY-MM-DD) when the class reaches this unit, if the material gives dates; empty string otherwise.',
    ),
});

export const plannedOutlineSchema = z.object({
  courseName: z.string().min(1),
  description: z.string().describe('One sentence.'),
  itemTypes: z.array(plannedItemType).min(1).max(3),
  units: z.array(plannedUnit).min(1),
});
export type PlannedOutline = z.infer<typeof plannedOutlineSchema>;

const PLANNER_SYSTEM = `You design a progressive spaced-repetition course from a learner's own course material — a syllabus, lecture notes, textbook chapters, slides, or a mix.

Split the material into ordered UNITS that follow its own structure (weeks, chapters, modules, lectures), typically 4-16. Each unit gets a short title, a one-sentence summary, 3-8 topics naming the specific facts, terms, procedures, or distinctions worth remembering, a targetCount of flashcard items (5-40, proportional to how much the unit contains), and the date the class reaches it if the material says.

Design 1-3 ITEM TYPES for the course, each with 2-4 named fields and 1-2 quiz templates. A template shows some fields as the prompt and asks for another field as the answer. Typical: "Term" (Term → Definition, typed), "Question" (Question → Answer, choice), "Vocab" (Word → Meaning, typed; Meaning → Word, typed). Choose typed when answers are 1-4 exact words; choose choice when answers are short phrases that are easy to recognise but awkward to type.

Template promptFields and answerField must use the EXACT field names you define. Do NOT write any items now — only the outline and the item types.`;

export interface PlanCourseOptions {
  /** Free-text steer from the learner, e.g. "12-week class, exams on weeks 6 and 12". */
  hint?: string;
}

export interface PlanCourseResult {
  outline: PlannedOutline;
  material: string;
  materialTruncated: boolean;
}

/** Stage 1. Returns the outline for review — nothing is written to the database. */
export async function planCourse(
  rawMaterial: string,
  opts: PlanCourseOptions = {},
): Promise<PlanCourseResult> {
  const { material, truncated } = truncateMaterial(rawMaterial);
  if (!material) throw new Error('Paste some course material first.');
  const outline = await aiGenerateObject(plannedOutlineSchema, {
    system: PLANNER_SYSTEM,
    cacheableSystem: materialBlock({ material }),
    user: [
      'Plan this course.',
      opts.hint?.trim() ? `Notes from the learner: ${opts.hint.trim()}` : '',
      truncated ? 'The material was cut at the length cap — plan what you can see.' : '',
    ]
      .filter(Boolean)
      .join('\n'),
    maxTokens: 16000,
  });
  return { outline, material, materialTruncated: truncated };
}

/** Problems that would make the outline unimportable — shown before creating the course. */
export function outlineProblems(outline: PlannedOutline): string[] {
  const problems: string[] = [];
  const seenTypes = new Set<string>();
  for (const t of outline.itemTypes) {
    const tKey = t.name.trim().toLowerCase();
    if (!tKey) problems.push('An item type has no name.');
    if (seenTypes.has(tKey)) problems.push(`Duplicate item type name "${t.name}".`);
    seenTypes.add(tKey);
    const fields = new Set(t.fields.map((f) => f.name.trim().toLowerCase()));
    if (fields.size !== t.fields.length) problems.push(`Type "${t.name}" repeats a field name.`);
    for (const tpl of t.templates) {
      for (const ref of [...tpl.promptFields, tpl.answerField]) {
        if (!fields.has(ref.trim().toLowerCase())) {
          problems.push(`Type "${t.name}", template "${tpl.name}": no field called "${ref}".`);
        }
      }
      if (tpl.promptFields.some((p) => p.trim().toLowerCase() === tpl.answerField.trim().toLowerCase())) {
        problems.push(`Type "${t.name}", template "${tpl.name}": the prompt would show its own answer.`);
      }
    }
  }
  if (outline.units.length === 0) problems.push('The plan has no units.');
  if (outline.units.some((u) => !u.title.trim())) problems.push('A unit has no title.');
  return problems;
}

export interface OutlineCourseOptions {
  releaseMode: PlannedCourseInput['releaseMode'];
  ladderPreset?: PlannedCourseInput['ladderPreset'];
  newPerDay?: number;
  batchSize?: number;
  passPercent?: number;
}

/** The reviewed outline → the input createPlannedCourse takes. Pure. */
export function outlineToPlannedCourse(
  outline: PlannedOutline,
  material: string,
  materialTruncated: boolean,
  opts: OutlineCourseOptions,
): PlannedCourseInput {
  return {
    name: outline.courseName.trim(),
    description: outline.description.trim(),
    ...opts,
    itemTypes: outline.itemTypes.map((t) => ({
      name: t.name.trim(),
      icon: t.icon.trim() || undefined,
      fields: t.fields.map((f) => ({ name: f.name.trim() })),
      templates: t.templates.map((tpl) => ({
        name: tpl.name.trim(),
        promptFields: tpl.promptFields.map((p) => p.trim()),
        answerField: tpl.answerField.trim(),
        ...(tpl.mode === 'choice' ? { mode: 'choice' as const } : {}),
      })),
    })),
    units: outline.units.map((u) => {
      const releaseAt = parseReleaseAt(u.date.trim() || undefined);
      return {
        title: u.title.trim(),
        summary: u.summary.trim(),
        topics: u.topics.map((t) => t.trim()).filter(Boolean),
        targetCount: Math.max(1, Math.round(u.targetCount) || 10),
        ...(releaseAt !== null ? { releaseAt } : {}),
      };
    }),
    material,
    materialTruncated,
  };
}

// ---------- Stage 2: items for one unit ----------

const generatedUnitItem = z.object({
  type: z.string().describe('Item type name, exactly as listed.'),
  key: z
    .string()
    .describe(
      'Short unique handle (e.g. "mitosis") so later items can name this one as a prerequisite. Empty string if not needed.',
    ),
  prereqs: z
    .array(z.string())
    .describe(
      'Keys of items this one builds on — earlier in this list, or from the already-accepted list. Empty array if none.',
    ),
  fields: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
        alternates: z
          .array(z.string())
          .describe(
            'Other values that must ALSO count as a correct typed answer for THIS field. Empty array if none.',
          ),
      }),
    )
    .min(1),
  note: z.string().describe('A short, vivid mnemonic or memory hook. Empty string if none.'),
});

const generatedUnitSchema = z.object({ items: z.array(generatedUnitItem).min(1) });
export type GeneratedUnit = z.infer<typeof generatedUnitSchema>;

/** Stable per course — identical across unit calls so the cached prefix holds. */
function unitSystem(course: Pick<Course, 'name' | 'description'>, types: ItemType[]): string {
  return `You write flashcard items for ONE unit of a progressive spaced-repetition course built from the learner's own course material.
Course: "${course.name}" — ${course.description || 'no description'}.
${types.map(describeType).join('\n')}
${ANSWER_RULES}
Each item: "type" (one of the item type names above), "fields" (one entry per field of that type, using the EXACT field names), "key" (a short handle), "prereqs" (keys of items this one builds on, if any), "note".
Only use facts stated in the course material, or standard knowledge the material clearly assumes. Never invent specifics (numbers, names, dates) that the material does not contain. Prefer what an exam on this unit would ask.
For item types with a "choice" template, several items of that type are needed so wrong options can be drawn from them — write at least 6 of that type when the unit allows.`;
}

function answerFieldMap(itemType: ItemType): Map<string, string[]> {
  const fieldNameById = new Map(itemType.fields.map((f) => [f.id, f.name]));
  const map = new Map<string, string[]>();
  for (const tpl of itemType.templates) {
    const fieldName = fieldNameById.get(tpl.answerFieldId)?.toLowerCase();
    if (!fieldName) continue;
    map.set(fieldName, [...(map.get(fieldName) ?? []), tpl.name]);
  }
  return map;
}

/**
 * Generated unit → packet items. Alternates become template-scoped synonyms
 * (via toPacketItem); keys are kept unique within the batch (a repeated key
 * would fail the packet's own validation); an unknown type name is passed
 * through so the dry-run flags that row instead of losing the batch.
 */
export function unitItemsToPacketItems(generated: GeneratedUnit, types: ItemType[]): PacketItem[] {
  const byName = new Map(types.map((t) => [t.name.toLowerCase(), t]));
  const seenKeys = new Set<string>();
  return generated.items.map((gi) => {
    const itemType =
      byName.get(gi.type.trim().toLowerCase()) ?? (types.length === 1 ? types[0] : undefined);
    const base = toPacketItem(
      gi,
      itemType ? answerFieldMap(itemType) : new Map(),
      itemType?.name ?? gi.type.trim(),
    );
    const key = gi.key.trim();
    const prereqs = gi.prereqs.map((p) => p.trim()).filter(Boolean);
    const useKey = key.length > 0 && !seenKeys.has(key);
    if (useKey) seenKeys.add(key);
    return {
      ...base,
      ...(useKey ? { key } : {}),
      ...(prereqs.length > 0 ? { prereqs } : {}),
    };
  });
}

function proposalLabel(p: Proposal): string {
  for (const v of Object.values(p.item.fields)) {
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 60);
  }
  return '(item)';
}

const MAX_EXISTING_IN_PROMPT = 150;
const MAX_REJECTED_IN_PROMPT = 40;

/** The per-unit request: what to write, what exists, what was turned down. Pure. */
export function unitRequest(
  unit: PlanUnit,
  count: number,
  context: {
    existing: { item: { fieldValues: Record<string, unknown>; typeId: string }; key?: string }[];
    types: ItemType[];
    rejected: Proposal[];
    instruction?: string;
  },
): string {
  const typeById = new Map(context.types.map((t) => [t.id, t]));
  const existingLines = context.existing
    .slice(0, MAX_EXISTING_IN_PROMPT)
    .map(({ item, key }) => {
      const t = typeById.get(item.typeId);
      const preview = t ? itemPreview(item as never, t) : '';
      return preview ? `${key ? `[${key}] ` : ''}${preview}` : '';
    })
    .filter(Boolean);
  const rejectedLines = context.rejected
    .slice(0, MAX_REJECTED_IN_PROMPT)
    .map((p) => `${proposalLabel(p)}${p.rejectReason ? ` — "${p.rejectReason}"` : ''}`);
  return [
    `Write exactly ${count} items for unit ${unit.level}: "${unit.title}".`,
    unit.summary ? `Summary: ${unit.summary}` : '',
    unit.topics.length > 0 ? `Topics to cover: ${unit.topics.join('; ')}` : '',
    existingLines.length > 0
      ? `Already in the course — do NOT duplicate these (a [key] may be used as a prerequisite):\n${existingLines.join(' | ')}`
      : '',
    rejectedLines.length > 0
      ? `The learner REJECTED these earlier — avoid anything similar:\n${rejectedLines.join('\n')}`
      : '',
    context.instruction?.trim() ? `Extra instructions: ${context.instruction.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export interface GenerateUnitOptions {
  /** Override the unit's targetCount. */
  count?: number;
  /** Free-text steer, e.g. "focus on the formulas". */
  instruction?: string;
}

/**
 * Stage 2. Items for one unit land in the review queue as pending proposals
 * (source 'ai'); the unit's generatedAt is stamped. Nothing enters the course.
 */
export async function generateUnitItems(
  courseId: string,
  level: number,
  opts: GenerateUnitOptions,
  now: number,
): Promise<{ proposalsAdded: number; warnings: string[] }> {
  const course = await db.courses.get(courseId);
  const plan = await planForCourse(courseId);
  const unit = plan?.units.find((u) => u.level === level);
  if (!course || !plan || !unit) throw new Error('unit not found');
  const types = await db.itemTypes.where('courseId').equals(courseId).toArray();
  if (types.length === 0) throw new Error('course has no item types');

  const items = await db.items.where('courseId').equals(courseId).toArray();
  const proposals = await proposalsForCourse(courseId);
  const keyByItemId = new Map(
    proposals
      .filter((p) => p.status === 'accepted' && p.acceptedItemId && p.item.key)
      .map((p) => [p.acceptedItemId!, p.item.key!]),
  );
  const count = Math.max(1, Math.min(60, Math.round(opts.count ?? unit.targetCount) || 10));

  const generated = await aiGenerateObject(generatedUnitSchema, {
    system: unitSystem(course, types),
    cacheableSystem: materialBlock(plan),
    user: unitRequest(unit, count, {
      existing: items.map((item) => ({ item, key: keyByItemId.get(item.id) })),
      types,
      rejected: proposals.filter((p) => p.status === 'rejected'),
      instruction: opts.instruction,
    }),
    maxTokens: 24000,
  });

  const packet = parsePacket({
    format: PACKET_FORMAT,
    version: PACKET_VERSION,
    kind: 'propose-items',
    courseId,
    unit: level,
    items: unitItemsToPacketItems(generated, types),
  });
  const res = await applyPacket(packet, now, { source: 'ai' });
  await updatePlan(
    {
      ...plan,
      units: plan.units.map((u) => (u.level === level ? { ...u, generatedAt: now } : u)),
    },
    now,
  );
  return { proposalsAdded: res.proposalsAdded, warnings: res.warnings };
}
