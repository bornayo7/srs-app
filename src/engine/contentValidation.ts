import type { ClozeSentence, FieldValue, ItemType } from './types';
import { extractBlank } from './grading/cloze';
import { normalizeAnswer } from './grading/normalize';
import { richTextToPlain } from './richtext';
import { validateItemType } from './typeDesign';

export interface ContentProblem {
  fieldId: string;
  message: string;
}

/** One content contract for every producer. Missing optional fields stay absent. */
export function validateItemContent(
  candidate: Record<string, unknown>,
  type: ItemType,
): { values: Record<string, FieldValue>; problems: ContentProblem[] } {
  const values: Record<string, FieldValue> = Object.create(null);
  const problems: ContentProblem[] = [];
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return {
      values,
      problems: [{ fieldId: '', message: 'Item fields must be a named collection of values.' }],
    };
  }
  const fields = new Map(type.fields.map((field) => [field.id, field]));
  const fail = (fieldId: string, message: string) => problems.push({ fieldId, message });
  for (const [id, raw] of Object.entries(candidate)) {
    const field = fields.get(id);
    if (!field) {
      fail(id, `Unknown field "${id}". Reload the item type before saving.`);
      continue;
    }
    if (raw === undefined) continue;
    if (field.kind === 'list') {
      if (!Array.isArray(raw) || !raw.every((value) => typeof value === 'string')) {
        fail(id, `"${field.name}" must be a list of text values.`);
      } else values[id] = [...raw];
    } else if (field.kind === 'clozeSentences') {
      if (!Array.isArray(raw)) {
        fail(id, `"${field.name}" must contain cloze sentences.`);
        continue;
      }
      const sentences: ClozeSentence[] = [];
      for (const [index, value] of raw.entries()) {
        if (
          typeof value !== 'object' ||
          value === null ||
          !('text' in value) ||
          typeof value.text !== 'string' ||
          ('translation' in value && typeof value.translation !== 'string') ||
          ('hint' in value && typeof value.hint !== 'string')
        ) {
          fail(
            id,
            `"${field.name}", sentence ${index + 1}: use text with an optional translation and hint.`,
          );
          continue;
        }
        const sentence: ClozeSentence = { text: value.text };
        if ('translation' in value) sentence.translation = value.translation as string;
        if ('hint' in value) sentence.hint = value.hint as string;
        if (!extractBlank(sentence))
          fail(
            id,
            `"${field.name}", sentence ${index + 1}: mark a non-empty blank with ⟦brackets⟧.`,
          );
        sentences.push(sentence);
      }
      values[id] = sentences;
    } else if (typeof raw !== 'string') {
      fail(
        id,
        `"${field.name}" must be ${field.kind === 'image' || field.kind === 'audio' ? 'a stored media reference' : 'text'}.`,
      );
    } else values[id] = raw;
  }

  const hasContent = (id: string, answer: boolean): boolean => {
    const value = values[id];
    const field = fields.get(id);
    if (!field || value === undefined) return false;
    if (field.kind === 'clozeSentences') return Array.isArray(value) && value.length > 0;
    const texts = typeof value === 'string' ? [value] : value;
    return texts.some((text) => {
      if (typeof text !== 'string') return false;
      const plain = field.kind === 'richtext' ? richTextToPlain(text) : text;
      return (answer ? normalizeAnswer(plain) : plain.trim()).length > 0;
    });
  };
  const required = new Map<string, boolean>();
  for (const template of type.templates) {
    for (const id of template.promptFieldIds) if (!required.has(id)) required.set(id, false);
    required.set(template.answerFieldId, true);
    if (template.grading.mode === 'sentenceCloze')
      required.set(template.grading.sentencesFieldId, true);
  }
  for (const [id, answer] of required) {
    if (!hasContent(id, answer) && !problems.some((problem) => problem.fieldId === id)) {
      fail(
        id,
        `"${fields.get(id)?.name ?? id}" needs a non-empty ${answer ? 'answer' : 'prompt'}.`,
      );
    }
  }
  return { values, problems };
}

export function assertItemContent(
  candidate: Record<string, unknown>,
  type: ItemType,
): Record<string, FieldValue> {
  const result = validateItemContent(candidate, type);
  if (result.problems.length)
    throw new Error(result.problems.map((problem) => problem.message).join(' · '));
  return result.values;
}

export function assertValidItemType(type: ItemType, siblings: readonly ItemType[] = []): void {
  const issues = validateItemType(type);
  if (
    siblings.some(
      (other) =>
        other.id !== type.id &&
        other.courseId === type.courseId &&
        other.name.trim().toLowerCase() === type.name.trim().toLowerCase(),
    )
  ) {
    issues.push({
      path: 'name',
      message: `An item type named "${type.name.trim()}" already exists in this course.`,
    });
  }
  if (issues.length)
    throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join(' · '));
}
