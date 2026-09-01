import type { CardTemplate, FieldDef, FieldKind, FieldValue, ItemType } from './types';
import { clozeSummary, isClozeSentences, parseClozeLines, revealBlank } from './grading/cloze';

/**
 * The content-model rules behind the item-type designer. Pure: validation,
 * the diff that tells the DB layer which cards to create/destroy, and the
 * field-value conversions a kind change implies.
 *
 * Every rule here exists because breaking it corrupts review later — a
 * template pointing at a deleted field renders an unanswerable card, a prompt
 * that includes the answer field shows the answer, and so on.
 */

export interface TypeIssue {
  path: string; // human-readable location, e.g. 'Reading' or 'fields'
  message: string;
}

/** Kinds that can hold a typed answer (media fields can't be graded as text). */
const ANSWERABLE: ReadonlySet<FieldKind> = new Set(['text', 'richtext', 'list', 'clozeSentences']);

/** Kinds whose value is a media id rather than user-visible text. */
export function isMediaKind(kind: FieldKind): boolean {
  return kind === 'image' || kind === 'audio';
}

function dupName(names: string[]): string | null {
  const seen = new Set<string>();
  for (const n of names) {
    const key = n.trim().toLowerCase();
    if (key && seen.has(key)) return n;
    seen.add(key);
  }
  return null;
}

export function validateItemType(type: ItemType): TypeIssue[] {
  const issues: TypeIssue[] = [];
  const push = (path: string, message: string) => issues.push({ path, message });

  if (!type.name.trim()) push('name', 'Give the type a name.');
  if (type.fields.length === 0) push('fields', 'A type needs at least one field.');
  if (type.templates.length === 0) {
    push('templates', 'A type needs at least one card template — otherwise its items are never reviewed.');
  }

  for (const f of type.fields) {
    if (!f.name.trim()) push('fields', 'Every field needs a name.');
  }
  const dupField = dupName(type.fields.map((f) => f.name));
  if (dupField) push('fields', `Duplicate field name "${dupField}".`);
  const dupTpl = dupName(type.templates.map((t) => t.name));
  if (dupTpl) push('templates', `Duplicate template name "${dupTpl}".`);

  const byId = new Map(type.fields.map((f) => [f.id, f]));
  for (const tpl of type.templates) {
    const where = tpl.name.trim() || 'template';
    if (!tpl.name.trim()) push(where, 'Every template needs a name.');

    const answer = byId.get(tpl.answerFieldId);
    if (!answer) {
      push(where, 'Pick an answer field.');
    } else if (tpl.grading.mode !== 'self' && !ANSWERABLE.has(answer.kind)) {
      push(where, `"${answer.name}" is a ${answer.kind} field — it can't be typed as an answer. Use reveal (self-graded) instead.`);
    }

    if (tpl.promptFieldIds.length === 0) push(where, 'Pick at least one prompt field.');
    for (const id of tpl.promptFieldIds) {
      if (!byId.has(id)) push(where, 'A prompt field no longer exists — reselect it.');
      else if (id === tpl.answerFieldId) {
        push(where, `"${byId.get(id)!.name}" is both prompt and answer — the card would show its own answer.`);
      }
    }
    for (const id of tpl.hintFieldIds) {
      if (!byId.has(id)) push(where, 'A hint field no longer exists — reselect it.');
    }

    if (tpl.grading.mode === 'sentenceCloze') {
      const sf = byId.get(tpl.grading.sentencesFieldId);
      if (!sf) push(where, 'Pick the sentences field for the cloze.');
      else if (sf.kind !== 'clozeSentences') {
        push(where, `"${sf.name}" must be a clozeSentences field to hold example sentences.`);
      }
    }
    if (tpl.grading.mode === 'choice' && (tpl.grading.choices < 2 || tpl.grading.choices > 6)) {
      push(where, 'Multiple choice needs between 2 and 6 options.');
    }
  }
  return issues;
}

export interface TypeDiff {
  addedTemplates: CardTemplate[];
  removedTemplateIds: string[];
  removedFieldIds: string[];
  /** Fields whose kind changed — their stored values need conversion. */
  kindChanges: { id: string; from: FieldKind; to: FieldKind }[];
}

export function diffItemType(prev: ItemType, next: ItemType): TypeDiff {
  const prevTemplateIds = new Set(prev.templates.map((t) => t.id));
  const nextTemplateIds = new Set(next.templates.map((t) => t.id));
  const prevFields = new Map(prev.fields.map((f) => [f.id, f]));
  const nextFields = new Map(next.fields.map((f) => [f.id, f]));

  return {
    addedTemplates: next.templates.filter((t) => !prevTemplateIds.has(t.id)),
    removedTemplateIds: prev.templates.filter((t) => !nextTemplateIds.has(t.id)).map((t) => t.id),
    removedFieldIds: prev.fields.filter((f) => !nextFields.has(f.id)).map((f) => f.id),
    kindChanges: [...nextFields.values()]
      .filter((f) => prevFields.has(f.id) && prevFields.get(f.id)!.kind !== f.kind)
      .map((f) => ({ id: f.id, from: prevFields.get(f.id)!.kind, to: f.kind })),
  };
}

function asText(v: FieldValue | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  if (isClozeSentences(v)) return clozeSummary(v);
  if (Array.isArray(v)) return (v as string[]).filter((x) => typeof x === 'string').join(', ');
  return '';
}

/**
 * Convert one stored value when its field's kind changes. Media conversions
 * always clear: a media id is meaningless as text, and text is not a media id.
 */
export function convertFieldValue(
  value: FieldValue | undefined,
  from: FieldKind,
  to: FieldKind,
): FieldValue {
  if (from === to) return value ?? '';
  if (isMediaKind(from) || isMediaKind(to)) return '';

  if (to === 'list') {
    if (isClozeSentences(value)) return value.map((s) => revealBlank(s.text));
    if (Array.isArray(value)) return value as string[];
    return asText(value)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (to === 'clozeSentences') {
    if (isClozeSentences(value)) return value;
    // unmarked text has no blank to type — parse what we can, drop the rest
    return parseClozeLines(asText(value).split(', ').join('\n')).sentences;
  }
  return asText(value); // text / richtext
}

/** Apply a type edit to one item's stored values: drop, convert, keep. */
export function migrateFieldValues(
  values: Record<string, FieldValue>,
  prevFields: FieldDef[],
  nextFields: FieldDef[],
): Record<string, FieldValue> {
  const prevById = new Map(prevFields.map((f) => [f.id, f]));
  const out: Record<string, FieldValue> = {};
  for (const f of nextFields) {
    const before = prevById.get(f.id);
    if (!before) {
      out[f.id] = f.kind === 'list' ? [] : f.kind === 'clozeSentences' ? [] : '';
      continue;
    }
    out[f.id] = convertFieldValue(values[f.id], before.kind, f.kind);
  }
  return out; // fields removed from the type are simply not copied over
}

/** Drop per-template maps (synonyms/blockList/guidance) for deleted templates. */
export function pruneTemplateMap<T>(
  map: Record<string, T>,
  removedTemplateIds: string[],
): Record<string, T> {
  if (removedTemplateIds.length === 0) return map;
  const gone = new Set(removedTemplateIds);
  return Object.fromEntries(Object.entries(map).filter(([id]) => !gone.has(id)));
}
