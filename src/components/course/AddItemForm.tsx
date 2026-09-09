import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { Button, Field, Panel, Select, Status, TextArea, TextInput } from '@/components/ui';
import { FieldValueInput } from '@/components/editor/FieldValueInput';
import { useFieldDraft } from '@/components/editor/useFieldDraft';
import { splitList } from '@/components/editor/ListInput';
import { useOperation } from '@/hooks/useOperation';
import { createItem } from '@/db/repo/items';
import { itemPreview } from '@/engine/grading/context';
import type { Course, ItemType } from '@/engine/types';
import { now } from '@/services/clock';

export function AddItemForm({ course, types }: { course: Course; types: ItemType[] }) {
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const type = types.find((t) => t.id === typeId) ?? types[0];
  const fields = useFieldDraft(type);
  const operation = useOperation();
  const [synonyms, setSynonyms] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [level, setLevel] = useState(course.currentLevel);
  const [prereqIds, setPrereqIds] = useState<string[]>([]);
  const existing = useLiveQuery(
    () => db.items.where('courseId').equals(course.id).toArray(),
    [course.id],
  );
  if (!type)
    return (
      <Panel title="Add item">
        <p>Create an item type in Course settings first.</p>
      </Panel>
    );
  return (
    <Panel title="Add item">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void operation.run(async () => {
            const fieldValues = fields.validate();
            await createItem(
              {
                courseId: course.id,
                typeId: type.id,
                expectedType: fields.expectedType,
                fieldValues,
                level,
                prereqIds,
                synonyms: Object.fromEntries(
                  type.templates.map((t) => [t.id, splitList(synonyms[t.id] ?? '')]),
                ),
                note: note.trim(),
              },
              now(),
            );
            fields.reset();
            setSynonyms({});
            setNote('');
            setPrereqIds([]);
          }, 'Item added to the course.');
        }}
      >
        <fieldset disabled={operation.busy} className="min-w-0 space-y-4">
          {types.length > 1 && (
            <Field label="Item type">
              <Select
                value={type.id}
                disabled={operation.busy || fields.busy}
                onChange={(e) => {
                  setTypeId(e.target.value);
                  fields.reset(
                    {},
                    types.find((t) => t.id === e.target.value),
                  );
                  setSynonyms({});
                }}
              >
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.icon} {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {type.fields.map((field) => (
              <Field
                key={`${type.id}:${field.id}:${fields.generation}`}
                label={field.name}
                className={
                  ['clozeSentences', 'richtext'].includes(field.kind) ? 'sm:col-span-2' : ''
                }
              >
                <FieldValueInput {...fields.fieldProps(field)} />
              </Field>
            ))}
          </div>
          <details className="rounded-lg border border-slate-800 p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Accepted answers, note and prerequisites
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {type.templates.map((template) => (
                <Field
                  key={template.id}
                  label={`Also accept for ${template.name}`}
                  hint="Separate answers with commas."
                >
                  <TextInput
                    value={synonyms[template.id] ?? ''}
                    onChange={(e) => setSynonyms((v) => ({ ...v, [template.id]: e.target.value }))}
                  />
                </Field>
              ))}
              <Field label="Note or mnemonic" className="sm:col-span-2">
                <TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              {course.levelMode === 'levels' && (
                <Field label={`Level (currently ${course.currentLevel})`}>
                  <TextInput
                    type="number"
                    min={1}
                    step={1}
                    value={level}
                    onChange={(e) => setLevel(Math.max(1, Math.floor(+e.target.value || 1)))}
                  />
                </Field>
              )}
              <Field label="Prerequisites" hint="Hold Ctrl or Command to select more than one.">
                <Select
                  multiple
                  value={prereqIds}
                  onChange={(e) => setPrereqIds([...e.target.selectedOptions].map((o) => o.value))}
                  className="w-full"
                  size={4}
                >
                  {(existing ?? []).map((item) => {
                    const ty = types.find((t) => t.id === item.typeId);
                    return (
                      <option key={item.id} value={item.id}>
                        {ty ? itemPreview(item, ty) : item.id}
                      </option>
                    );
                  })}
                </Select>
              </Field>
            </div>
          </details>
          <Status {...operation} />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={operation.busy || fields.busy}>
              {fields.busy ? 'Processing attachment…' : operation.busy ? 'Adding…' : 'Add item'}
            </Button>
            <p className="text-sm text-slate-500">
              {prereqIds.length || (course.levelMode === 'levels' && level > course.currentLevel)
                ? 'Available when its level and prerequisites are reached.'
                : 'New items enter the lesson queue.'}
            </p>
          </div>
        </fieldset>
      </form>
    </Panel>
  );
}
