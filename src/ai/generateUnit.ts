import { z } from 'zod';
import { db } from '@/db/db';
import { planForCourse, mutatePlan } from '@/db/repo/plans';
import { proposalsForCourse } from '@/db/repo/proposals';
import { itemPreview } from '@/engine/grading/context';
import type { Course, CoursePlan, Item, ItemType, PlanUnit, Proposal } from '@/engine/types';
import { applyPacket } from '@/packages/importPacket';
import { PACKET_FORMAT, PACKET_VERSION, parsePacket } from '@/packages/schema';
import type { PacketItem } from '@/packages/schema';
import { aiGenerateObject } from './client';
import {
  ANSWER_RULES,
  describeType,
  toPacketItem,
  generationTypeProblem,
  assertGenerationCount,
} from './generate';

function materialBlock(plan: Pick<CoursePlan, 'material'>): string | undefined {
  return plan.material
    ? `COURSE MATERIAL (the learner's own notes/syllabus):\n${plan.material}`
    : undefined;
}

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
const MAX_PENDING_IN_PROMPT = 60;
const MAX_REJECTED_IN_PROMPT = 40;

/**
 * The per-unit request: what to write, what exists, what is still waiting
 * for the learner, what was turned down. Pure.
 */
export function unitRequest(
  unit: PlanUnit,
  count: number,
  context: {
    existing: { item: { fieldValues: Item['fieldValues']; typeId: string }; key?: string }[];
    types: ItemType[];
    /** Drafted earlier and not yet reviewed — "draft more" must not repeat them. */
    pending?: Proposal[];
    rejected: Proposal[];
    instruction?: string;
  },
): string {
  const typeById = new Map(context.types.map((t) => [t.id, t]));
  const existingLines = context.existing
    .slice(0, MAX_EXISTING_IN_PROMPT)
    .map(({ item, key }) => {
      const t = typeById.get(item.typeId);
      const preview = t ? itemPreview(item, t) : '';
      return preview ? `${key ? `[${key}] ` : ''}${preview}` : '';
    })
    .filter(Boolean);
  const pendingLines = (context.pending ?? []).slice(0, MAX_PENDING_IN_PROMPT).map(proposalLabel);
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
    pendingLines.length > 0
      ? `Already drafted and awaiting the learner's review — do NOT duplicate these either:\n${pendingLines.join(' | ')}`
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
  const supportedTypes = types.filter((type) => !generationTypeProblem(type));
  if (!supportedTypes.length)
    throw new Error(
      'This course needs media attachments. Create items in the editor or import a package with media.',
    );

  const items = await db.items.where('courseId').equals(courseId).toArray();
  const proposals = await proposalsForCourse(courseId);
  const keyByItemId = new Map(
    proposals
      .filter((p) => p.status === 'accepted' && p.acceptedItemId && p.item.key)
      .map((p) => [p.acceptedItemId!, p.item.key!]),
  );
  const count = opts.count ?? (unit.targetCount || 10);
  assertGenerationCount(count);
  const identity = (sourcePlan: CoursePlan, sourceUnit: PlanUnit, sourceTypes: ItemType[]) =>
    JSON.stringify({
      planId: sourcePlan.id,
      material: sourcePlan.material,
      unit: {
        level: sourceUnit.level,
        title: sourceUnit.title,
        summary: sourceUnit.summary,
        topics: sourceUnit.topics,
        targetCount: sourceUnit.targetCount,
      },
      types: sourceTypes
        .map((type) => ({ id: type.id, rev: type.rev, generation: type.generation }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
  const expected = identity(plan, unit, types);

  const generated = await aiGenerateObject(generatedUnitSchema, {
    system: unitSystem(course, supportedTypes),
    cacheableSystem: materialBlock(plan),
    user: unitRequest(unit, count, {
      existing: items.map((item) => ({ item, key: keyByItemId.get(item.id) })),
      types,
      pending: proposals.filter((p) => p.status === 'pending'),
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
  return db.transaction('rw', db.tables, async () => {
    const currentPlan = await planForCourse(courseId);
    const currentUnit = currentPlan?.units.find((u) => u.level === level);
    const currentTypes = await db.itemTypes.where('courseId').equals(courseId).toArray();
    if (
      !currentPlan ||
      !currentUnit ||
      identity(currentPlan, currentUnit, currentTypes) !== expected
    ) {
      throw new Error(
        'The unit, course material, or item types changed during generation. Generate again with the current content.',
      );
    }
    const res = await applyPacket(packet, now, { source: 'ai' });
    await mutatePlan(
      plan.id,
      (current) => ({
        ...current,
        units: current.units.map((u) => (u.level === level ? { ...u, generatedAt: now } : u)),
      }),
      now,
    );
    const warnings = [...res.warnings];
    if (generated.items.length !== count)
      warnings.push(`The model returned ${generated.items.length} items; ${count} were requested.`);
    return { proposalsAdded: res.proposalsAdded, warnings };
  });
}
