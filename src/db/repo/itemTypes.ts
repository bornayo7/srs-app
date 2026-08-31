import { db } from '../db';
import { newId } from '@/engine/ids';
import type { FieldDef, GradingSpec, ItemType } from '@/engine/types';

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
    grading: GradingSpec;
  }[];
}

/** Build + persist an ItemType from a friendly spec (used by seeds and the course editor). */
export async function createItemType(
  courseId: string,
  spec: SimpleTypeSpec,
  now: number,
): Promise<ItemType> {
  const fields: FieldDef[] = spec.fields.map((f) => ({ id: newId(), name: f.name, kind: f.kind }));
  const byName = new Map(fields.map((f) => [f.name, f.id]));

  const itemType: ItemType = {
    id: newId(),
    courseId,
    name: spec.name,
    color: spec.color,
    icon: spec.icon,
    fields,
    templates: spec.templates.map((t) => ({
      id: newId(),
      name: t.name,
      promptFieldIds: t.promptFieldNames.map((n) => byName.get(n)!),
      answerFieldId: byName.get(t.answerFieldName)!,
      hintFieldIds: [],
      grading: t.grading,
    })),
    updatedAt: now,
  };
  await db.itemTypes.add(itemType);
  return itemType;
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
