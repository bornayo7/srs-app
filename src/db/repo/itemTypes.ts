import { db } from '../db';
import { newId } from '@/engine/ids';
import type { FieldDef, GradingSpec, ItemType } from '@/engine/types';
import { assertValidItemType } from '@/engine/contentValidation';
import { LEGACY_GENERATION } from '@/engine/revision';

export interface SimpleTypeSpec {
  name: string;
  color: string;
  icon: string;
  /** field name → kind (order preserved) */
  fields: { name: string; kind: FieldDef['kind'] }[];
  templates: {
    name: string;
    promptFieldNames: string[];
    answerFieldName: string;
    hintFieldNames?: string[];
    grading: GradingSpec;
  }[];
}

/** Build + persist an ItemType from a friendly spec (used by seeds and the course editor). */
export async function createItemType(
  courseId: string,
  spec: SimpleTypeSpec,
  now: number,
): Promise<ItemType> {
  return db.transaction('rw', [db.courses, db.itemTypes], async () => {
    if (!(await db.courses.get(courseId))) throw new Error('course not found');
    const fields: FieldDef[] = spec.fields.map((f) => ({
      id: newId(),
      name: f.name,
      kind: f.kind,
    }));
    const byName = new Map(fields.map((f) => [f.name, f.id]));

    const itemType: ItemType = {
      id: newId(),
      courseId,
      name: spec.name,
      color: spec.color,
      icon: spec.icon,
      fields,
      templates: spec.templates.map((t) => {
        const fieldId = (name: string): string => {
          const found = byName.get(name);
          if (!found) throw new Error(`Template "${t.name}" references unknown field "${name}"`);
          return found;
        };
        const answerFieldId = fieldId(t.answerFieldName);
        // sentence-cloze specs reference their sentences field by ANSWER name —
        // resolve the real field id here, once ids exist
        const grading =
          t.grading.mode === 'sentenceCloze'
            ? { ...t.grading, sentencesFieldId: answerFieldId }
            : t.grading;
        return {
          id: newId(),
          name: t.name,
          promptFieldIds: t.promptFieldNames.map(fieldId),
          answerFieldId,
          hintFieldIds: (t.hintFieldNames ?? []).map(fieldId),
          grading,
        };
      }),
      updatedAt: now,
      rev: 0,
      generation: LEGACY_GENERATION,
    };
    assertValidItemType(itemType, await db.itemTypes.where('courseId').equals(courseId).toArray());
    await db.itemTypes.add(itemType);
    return itemType;
  });
}

/** The default "Basic" front→back typed type for new courses. */
export function basicTypeSpec(): SimpleTypeSpec {
  return {
    name: 'Basic',
    color: '#8b5cf6',
    icon: '📇',
    fields: [
      { name: 'Front', kind: 'text' },
      { name: 'Back', kind: 'text' },
    ],
    templates: [
      {
        name: 'Recall',
        promptFieldNames: ['Front'],
        answerFieldName: 'Back',
        grading: { mode: 'typed', answerLang: 'latin', typoTolerance: true },
      },
    ],
  };
}
