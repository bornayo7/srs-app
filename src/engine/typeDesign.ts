import type {
  CardLifecycle,
  CardTemplate,
  FieldDef,
  FieldKind,
  FieldValue,
  ItemStatus,
  ItemType,
} from './types';
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
    push(
      'templates',
      'A type needs at least one card template — otherwise its items are never reviewed.',
    );
  }

  for (const f of type.fields) {
    if (!f.name.trim()) push('fields', 'Every field needs a name.');
    if (!f.id.trim()) push('fields', 'Every field needs an id.');
  }
  if (new Set(type.fields.map((field) => field.id)).size !== type.fields.length)
    push('fields', 'Duplicate field id.');
  if (new Set(type.templates.map((template) => template.id)).size !== type.templates.length)
    push('templates', 'Duplicate template id.');
  const dupField = dupName(type.fields.map((f) => f.name));
  if (dupField) push('fields', `Duplicate field name "${dupField}".`);
  const dupTpl = dupName(type.templates.map((t) => t.name));
  if (dupTpl) push('templates', `Duplicate template name "${dupTpl}".`);

  const byId = new Map(type.fields.map((f) => [f.id, f]));
  for (const tpl of type.templates) {
    const where = tpl.name.trim() || 'template';
    if (!tpl.name.trim()) push(where, 'Every template needs a name.');
    if (!tpl.id.trim()) push(where, 'Every template needs an id.');
    if (tpl.grading.mode === 'self' || tpl.grading.mode === 'cloze') {
      push(
        where,
        `The ${tpl.grading.mode} grading mode is not supported yet. Choose typed, choice or sentence cloze.`,
      );
    }

    const answer = byId.get(tpl.answerFieldId);
    if (!answer) {
      push(where, 'Pick an answer field.');
    } else if (tpl.grading.mode !== 'self' && !ANSWERABLE.has(answer.kind)) {
      push(
        where,
        `"${answer.name}" is a ${answer.kind} field — it can't be typed as an answer. Choose a text, list or sentence-cloze answer field.`,
      );
    } else if (
      answer.kind === 'clozeSentences' &&
      tpl.grading.mode !== 'sentenceCloze' &&
      tpl.grading.mode !== 'self'
    ) {
      // sentence objects are not typeable text — the card would accept nothing
      push(
        where,
        `"${answer.name}" holds cloze sentences — grade it with sentence cloze, or answer a text field.`,
      );
    }

    if (tpl.promptFieldIds.length === 0) push(where, 'Pick at least one prompt field.');
    for (const id of tpl.promptFieldIds) {
      if (!byId.has(id)) push(where, 'A prompt field no longer exists — reselect it.');
      else if (id === tpl.answerFieldId) {
        push(
          where,
          `"${byId.get(id)!.name}" is both prompt and answer — the card would show its own answer.`,
        );
      }
    }
    for (const id of tpl.hintFieldIds) {
      if (!byId.has(id)) push(where, 'A hint field no longer exists — reselect it.');
      else if (id === tpl.answerFieldId) {
        push(
          where,
          `"${byId.get(id)!.name}" is both hint and answer — the hint would give the answer away.`,
        );
      }
    }

    if (tpl.grading.mode === 'sentenceCloze') {
      if (tpl.grading.sentencesFieldId !== tpl.answerFieldId)
        push(where, 'The answer and sentences field must be the same for sentence cloze.');
      const sf = byId.get(tpl.grading.sentencesFieldId);
      if (!sf) push(where, 'Pick the sentences field for the cloze.');
      else if (sf.kind !== 'clozeSentences') {
        push(where, `"${sf.name}" must be a clozeSentences field to hold example sentences.`);
      }
    }
    if (
      tpl.grading.mode === 'choice' &&
      (!Number.isInteger(tpl.grading.choices) || tpl.grading.choices < 2 || tpl.grading.choices > 6)
    ) {
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
 * Convert one stored value when its field's kind changes. Refuse conversions
 * that would silently erase media or sentence annotations; the editor reports
 * the owning item so its author can repair it before retrying the type change.
 */
export function convertFieldValue(
  value: FieldValue | undefined,
  from: FieldKind,
  to: FieldKind,
): FieldValue {
  if (from === to) return value ?? '';
  if (isMediaKind(from) || isMediaKind(to)) {
    const populated = typeof value === 'string' ? value.trim().length > 0 : !!value?.length;
    if (populated)
      throw new Error(
        'Cannot convert a populated media field to or from text. The original content has been kept. Clear or move this value before changing its field kind.',
      );
    return to === 'list' || to === 'clozeSentences' ? [] : '';
  }
  if (
    isClozeSentences(value) &&
    value.some((sentence) => sentence.translation?.trim() || sentence.hint?.trim())
  ) {
    throw new Error(
      'Cannot convert cloze sentences without losing their translations or hints. The original content has been kept. Move these annotations before changing the field kind.',
    );
  }

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
    // Never silently erase an author's source during a schema conversion.
    // List entries are separate lines; commas inside a sentence stay intact.
    const source = Array.isArray(value) ? value.join('\n') : asText(value);
    if (!source.trim()) return [];
    const parsed = parseClozeLines(source);
    if (parsed.error)
      throw new Error(
        `Cannot convert to cloze: ${parsed.error} The original content has been kept. Add blanks before changing this field kind.`,
      );
    return parsed.sentences;
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

/**
 * Reconcile an item's lifecycle status with the cards it actually holds:
 * - an active item that gained an untaught card returns to the lesson queue
 *   (lessons only draw from status 'lesson', so the card would never be taught)
 * - a lesson-queue item with nothing left to teach becomes active again
 * Locked items are left alone — prerequisite gating owns that state.
 */
export function studyStatus(current: ItemStatus, cards: { state: CardLifecycle }[]): ItemStatus {
  if (current === 'locked' || cards.length === 0) return current;
  const untaught = cards.some((c) => c.state === 'new');
  if (current === 'active' && untaught) return 'lesson';
  if (current === 'lesson' && !untaught) return 'active';
  return current;
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
