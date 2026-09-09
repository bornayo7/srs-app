import { z } from 'zod';
import type { CoursePlan } from '@/engine/types';
import { parseReleaseAt } from '@/packages/schema';
import type { PlannedCourseInput } from '@/services/plans';
import { aiGenerateObject } from './client';

/**
 * Two-stage generation for a course plan:
 *   1. planCourse — read the learner's material once, return an OUTLINE (units
 *      + item types) for review. No items yet.
 *   2. generateUnitItems — items for ONE unit, on demand, into the review
 *      queue. Sends the material again (cached on Anthropic) plus what's
 *      already accepted and what still awaits review (don't duplicate either)
 *      and what was rejected (avoid similar).
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
  return plan.material
    ? `COURSE MATERIAL (the learner's own notes/syllabus):\n${plan.material}`
    : undefined;
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
  fields: z
    .array(z.object({ name: z.string().min(1) }))
    .min(2)
    .describe('2-4 fields.'),
  templates: z
    .array(plannedTemplate)
    .min(1)
    .describe('1-2 templates. Field references use the exact field names.'),
});

const plannedUnit = z.object({
  title: z.string().min(1),
  summary: z.string().describe('One sentence.'),
  topics: z.array(z.string()).describe('3-8 specific things worth remembering from this unit.'),
  targetCount: z
    .number()
    .int()
    .min(0)
    .max(60)
    .describe('How many flashcard items this unit deserves, usually 5-40.'),
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
    if (
      new Set(t.templates.map((tpl) => tpl.name.trim().toLowerCase())).size !== t.templates.length
    )
      problems.push(`Type "${t.name}" repeats a template name.`);
    if (t.templates.some((tpl) => !tpl.name.trim()))
      problems.push(`Type "${t.name}" has an unnamed template.`);
    for (const tpl of t.templates) {
      for (const ref of [...tpl.promptFields, tpl.answerField]) {
        if (!fields.has(ref.trim().toLowerCase())) {
          problems.push(`Type "${t.name}", template "${tpl.name}": no field called "${ref}".`);
        }
      }
      if (
        tpl.promptFields.some(
          (p) => p.trim().toLowerCase() === tpl.answerField.trim().toLowerCase(),
        )
      ) {
        problems.push(
          `Type "${t.name}", template "${tpl.name}": the prompt would show its own answer.`,
        );
      }
    }
  }
  if (outline.units.length === 0) problems.push('The plan has no units.');
  if (outline.units.some((u) => !u.title.trim())) problems.push('A unit has no title.');
  for (const unit of outline.units) {
    if (!Number.isInteger(unit.targetCount) || unit.targetCount < 0 || unit.targetCount > 60)
      problems.push(`Unit "${unit.title}" needs a target count between 0 and 60.`);
    if (unit.date.trim() && parseReleaseAt(unit.date.trim()) === null)
      problems.push(`Unit "${unit.title}" has an invalid release date.`);
  }
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
  const problems = outlineProblems(outline);
  if (problems.length) throw new Error(problems.join(' '));
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
        targetCount: u.targetCount,
        ...(releaseAt !== null ? { releaseAt } : {}),
      };
    }),
    material,
    materialTruncated,
  };
}

export { generateUnitItems, unitItemsToPacketItems, unitRequest } from './generateUnit';
export type { GeneratedUnit, GenerateUnitOptions } from './generateUnit';
