import { z } from 'zod';
import { db } from '@/db/db';
import { sameVersion } from '@/engine/revision';
import { itemPreview } from '@/engine/grading/context';
import type { FieldValue, ItemType } from '@/engine/types';
import { assertItemContent } from '@/engine/contentValidation';
import { clozeSummary, isClozeSentences } from '@/engine/grading/cloze';
import { PACKET_FORMAT, PACKET_VERSION, parsePacket } from '@/packages/schema';
import type { AddItemsPacket, CreateCoursePacket, PacketItem } from '@/packages/schema';
import { aiGenerateObject, aiGenerateText } from './client';

/**
 * AI generation targets a strict zod schema (provider-agnostic — Anthropic
 * structured outputs, or JSON mode + validation on OpenAI-compatible APIs),
 * then converts into the same srs-packet shape the Inbox/MCP pipeline imports.
 * Schemas avoid records and optionals: every field required, name/value pairs.
 */

const generatedItem = z.object({
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

const generatedItemsSchema = z.object({ items: z.array(generatedItem).min(1) });

const generatedCourseSchema = z.object({
  courseName: z.string().min(1),
  description: z.string().describe('One sentence describing the course.'),
  itemType: z.object({
    name: z.string().min(1).describe('Singular noun for what one item is, e.g. "Word", "Fact".'),
    icon: z.string().describe('A single emoji.'),
    fields: z.array(z.object({ name: z.string().min(1) })).min(2).describe('2-4 fields.'),
    templates: z
      .array(
        z.object({
          name: z.string().min(1),
          promptFields: z.array(z.string()).min(1),
          answerField: z.string().min(1),
        }),
      )
      .min(1)
      .describe('1-2 templates. Field references use the exact field names.'),
  }),
  items: z.array(generatedItem).min(1),
});

export type GeneratedItem = z.infer<typeof generatedItem>;

/**
 * Convert a generated item to a packet item. Alternates attach as synonyms
 * ONLY to templates whose answer field is that specific field — never to every
 * template, which would defeat wrong-facet grading on multi-template types.
 */
export function toPacketItem(
  gi: GeneratedItem,
  templatesByAnswerField: Map<string, string[]>,
  typeName?: string,
): PacketItem {
  const fieldNames = gi.fields.map((f) => f.name.trim().toLowerCase());
  if (new Set(fieldNames).size !== fieldNames.length) throw new Error('The model repeated a field name. Please generate again.');
  const synonyms: Record<string, string[]> = {};
  for (const f of gi.fields) {
    const alternates = f.alternates.filter((a) => a.trim().length > 0);
    if (alternates.length === 0) continue;
    for (const templateName of templatesByAnswerField.get(f.name.toLowerCase()) ?? []) {
      synonyms[templateName] = [...(synonyms[templateName] ?? []), ...alternates];
    }
  }
  return {
    ...(typeName ? { type: typeName } : {}),
    fields: Object.fromEntries(
      gi.fields.map((f) => [f.name, f.value]).filter(([, v]) => (v as string).trim().length > 0),
    ),
    ...(Object.keys(synonyms).length > 0 ? { synonyms } : {}),
    ...(gi.note.trim() ? { note: gi.note.trim() } : {}),
  };
}

export function describeType(itemType: ItemType): string {
  const fields = itemType.fields.map((f) => {
    const representation = f.kind === 'clozeSentences'
      ? 'one sentence per line, mark the answer with ⟦answer⟧; optional translation follows ::; example: It is ⟦on⟧ the desk. :: Location'
      : f.kind === 'list' ? 'one value per line, preserving commas inside each value'
        : f.kind === 'richtext' ? 'readable text or simple HTML; answers are assessed as rendered text'
          : f.kind;
    return `"${f.name}" (${representation})`;
  }).join(', ');
  const templates = itemType.templates
    .map((t) => {
      const name = (id: string) => itemType.fields.find((f) => f.id === id)?.name ?? id;
      const lang = t.grading.mode === 'typed' ? t.grading.answerLang : 'latin';
      return `"${t.name}": shows [${t.promptFieldIds.map(name).join(', ')}], ${t.grading.mode === 'choice' ? 'user chooses' : 'user types'} "${name(t.answerFieldId)}" (${lang})`;
    })
    .join('; ');
  return `Item type "${itemType.name}" — fields: ${fields}. Quiz templates — ${templates}.`;
}

export const ANSWER_RULES = `Rules for good SRS items:
- For typed templates, keep answer fields short (1-4 words), unambiguous, lowercase unless casing matters. Choice templates show selectable answers; sentence cloze asks for the marked blank.
- If a template's answer language is "kana", write that answer field in hiragana/katakana only.
- The prompt fields must uniquely determine the answer — no trick questions.
- Per field, "alternates": other phrasings that should also count as a correct typed answer for that field (empty array if none).
- "note": one vivid mnemonic sentence connecting prompt and answer (empty string if trivial).
- Fill EVERY field of the item type for every item. No duplicates among generated items.`;

export interface GeneratedItemsResult {
  packetItems: PacketItem[];
  typeName: string;
}

export function generationTypeProblem(itemType: ItemType): string | null {
  return itemType.fields.some((f) => f.kind === 'image' || f.kind === 'audio')
    ? `"${itemType.name}" needs media attachments. Create these items with the editor or import a package with media.`
    : null;
}

export function assertGenerationCount(count: number): void {
  if (!Number.isInteger(count) || count < 1 || count > 60) throw new Error('Generate between 1 and 60 items at a time.');
}

/** Generate new items that fit an existing course's item type. */
export async function generateItems(
  courseId: string,
  typeId: string,
  request: string,
  count: number,
): Promise<GeneratedItemsResult> {
  assertGenerationCount(count);
  if (!request.trim()) throw new Error('Describe the items to generate.');
  const course = await db.courses.get(courseId);
  const itemType = await db.itemTypes.get(typeId);
  if (!course || !itemType || itemType.courseId !== course.id) throw new Error('course or item type not found');
  const problem = generationTypeProblem(itemType);
  if (problem) throw new Error(problem);

  // duplicate-avoidance context: preview each existing item with ITS OWN type
  const allTypes = await db.itemTypes.where('courseId').equals(courseId).toArray();
  const typeById = new Map(allTypes.map((t) => [t.id, t]));
  const existing = await db.items.where('courseId').equals(courseId).toArray();
  const existingPreviews = existing
    .slice(0, 150)
    .map((i) => {
      const t = typeById.get(i.typeId);
      return t ? itemPreview(i, t) : '';
    })
    .filter(Boolean);

  const system = `You create flashcard items for a spaced-repetition app (like WaniKani/Anki).
Course: "${course.name}" — ${course.description || 'no description'}.
${describeType(itemType)}
${ANSWER_RULES}
Each item's "fields" array must contain one entry per field of the item type, using the EXACT field names given above.
${existingPreviews.length > 0 ? `The course already contains these items — do NOT duplicate them:\n${existingPreviews.join(' | ')}` : ''}`;

  const parsed = await aiGenerateObject(generatedItemsSchema, {
    system,
    user: `Generate exactly ${count} items for: ${request}`,
    maxTokens: 16000,
  });
  const currentType = await db.itemTypes.get(typeId);
  if (!currentType || !sameVersion(currentType, itemType)) throw new Error('This item type changed during generation. Generate again using its new fields.');
  if (parsed.items.length === 0) {
    throw new Error('The model returned no usable items — try rephrasing the request.');
  }

  const fieldNameById = new Map(itemType.fields.map((f) => [f.id, f.name]));
  const templatesByAnswerField = new Map<string, string[]>();
  for (const tpl of itemType.templates) {
    const fieldName = fieldNameById.get(tpl.answerFieldId)?.toLowerCase();
    if (!fieldName) continue;
    templatesByAnswerField.set(fieldName, [
      ...(templatesByAnswerField.get(fieldName) ?? []),
      tpl.name,
    ]);
  }
  return {
    packetItems: parsed.items.map((gi) => toPacketItem(gi, templatesByAnswerField, itemType.name)),
    typeName: itemType.name,
  };
}

/** Design a complete new course (type + items) from a description. */
export async function generateCourse(
  request: string,
  count: number,
  ladderPreset: 'classic' | 'gentle' | 'bunpro',
): Promise<CreateCoursePacket> {
  assertGenerationCount(count);
  if (!request.trim()) throw new Error('Describe the course to generate.');
  const system = `You design complete courses for a spaced-repetition app (like WaniKani/Anki, but for any subject).
A course has ONE item type with 2-4 named fields, and 1-2 quiz templates. A template shows some fields as the prompt and asks the user to TYPE another field as the answer.
Design the smallest schema that fits the subject (e.g. language vocab: fields Word/Meaning with a "Meaning" template prompting Word→Meaning, optionally a "Production" template prompting Meaning→Word).
Template "promptFields" and "answerField" must use the EXACT field names you define. The answer field of every template must hold short typeable text.
${ANSWER_RULES}`;

  const parsed = await aiGenerateObject(generatedCourseSchema, {
    system,
    user: `Design a course with exactly ${count} items for: ${request}`,
    maxTokens: 32000,
  });

  const templatesByAnswerField = new Map<string, string[]>();
  for (const tpl of parsed.itemType.templates) {
    const key = tpl.answerField.toLowerCase();
    templatesByAnswerField.set(key, [...(templatesByAnswerField.get(key) ?? []), tpl.name]);
  }

  const packet: CreateCoursePacket = {
    format: PACKET_FORMAT,
    version: PACKET_VERSION,
    kind: 'create-course',
    course: {
      name: parsed.courseName,
      description: parsed.description,
      ladderPreset,
    },
    itemTypes: [
      {
        name: parsed.itemType.name,
        icon: parsed.itemType.icon,
        fields: parsed.itemType.fields.map((f) => ({ name: f.name })),
        templates: parsed.itemType.templates.map((t) => ({
          name: t.name,
          promptFields: t.promptFields,
          answerField: t.answerField,
        })),
      },
    ],
    items: parsed.items.map((gi) => toPacketItem(gi, templatesByAnswerField)),
  };
  // same gate every other packet source passes — catches degenerate schemas
  // (duplicate names, dangling template refs) before anything is written
  return parsePacket(packet) as CreateCoursePacket;
}

/** Write a mnemonic for one item (leech rescue / lazy note-writing). */
export async function generateMnemonic(itemId: string): Promise<string> {
  const item = await db.items.get(itemId);
  const itemType = item ? await db.itemTypes.get(item.typeId) : undefined;
  if (!item || !itemType) throw new Error('item not found');
  return generateMnemonicForContent(itemType, item.fieldValues);
}

/** Generate from the reviewed draft snapshot; no persistence or UI state is read. */
export async function generateMnemonicForContent(
  itemType: ItemType,
  fieldValues: Record<string, FieldValue>,
): Promise<string> {
  const values = assertItemContent(fieldValues, itemType);
  const fieldLines = itemType.fields
    .map((f) => {
      const v = values[f.id];
      if (f.kind === 'image' || f.kind === 'audio') return null;
      const text = isClozeSentences(v) ? clozeSummary(v) : typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : '';
      return text ? `${f.name}: ${text}` : null;
    })
    .filter(Boolean)
    .join('\n');

  const mnemonic = await aiGenerateText({
    system:
      'You write mnemonics for spaced-repetition flashcards. Reply with ONLY the mnemonic: 1-2 vivid, concrete sentences that link the prompt to the answer. No preamble, no quotes.',
    user: `Write a mnemonic for this item:\n${fieldLines}`,
    maxTokens: 4000,
  });
  if (!mnemonic) throw new Error('No mnemonic returned — try again.');
  return mnemonic;
}

/** Build an add-items packet from a selection of generated items. */
export function itemsToPacket(courseId: string, items: PacketItem[]): AddItemsPacket {
  return { format: PACKET_FORMAT, version: PACKET_VERSION, kind: 'add-items', courseId, items };
}
