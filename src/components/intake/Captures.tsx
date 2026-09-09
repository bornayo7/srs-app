import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { Button, Field, Panel, Select, Status } from '@/components/ui';
import { FieldValueInput } from '@/components/editor/FieldValueInput';
import { useFieldDraft } from '@/components/editor/useFieldDraft';
import { splitList } from '@/components/editor/ListInput';
import { useOperation } from '@/hooks/useOperation';
import { convertCapture } from '@/services/contentCommands';
import { now } from '@/services/clock';
import type { Capture, Course, ItemType } from '@/engine/types';

function CaptureForm({
  capture,
  course,
  type,
  close,
}: {
  capture: Capture;
  course: Course;
  type: ItemType;
  close: () => void;
}) {
  const first = type.fields.find((f) => !['image', 'audio'].includes(f.kind));
  const fields = useFieldDraft(
    type,
    first ? { [first.id]: first.kind === 'list' ? splitList(capture.text) : capture.text } : {},
  );
  const operation = useOperation();
  return (
    <form
      className="mt-3 space-y-3 border-t border-slate-800 pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        void operation.run(() =>
          convertCapture(
            capture.id,
            {
              courseId: course.id,
              typeId: type.id,
              expectedType: fields.expectedType,
              fieldValues: fields.validate(),
              level: course.currentLevel,
            },
            now(),
          ),
        );
      }}
    >
      <fieldset disabled={operation.busy} className="min-w-0">
        <div className="grid gap-3 sm:grid-cols-2">
          {type.fields.map((field) => (
            <Field
              key={field.id}
              label={field.name}
              className={['richtext', 'clozeSentences'].includes(field.kind) ? 'sm:col-span-2' : ''}
            >
              <FieldValueInput {...fields.fieldProps(field)} />
            </Field>
          ))}
        </div>
      </fieldset>
      <Status {...operation} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={operation.busy || fields.busy}>
          Create item
        </Button>
        <Button onClick={close} disabled={operation.busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function CaptureRow({ capture }: { capture: Capture }) {
  const courses = useLiveQuery(() => db.courses.toArray(), []);
  const [courseId, setCourseId] = useState('');
  const [typeId, setTypeId] = useState('');
  const [open, setOpen] = useState(false);
  const operation = useOperation();
  const types = useLiveQuery(
    () => (courseId ? db.itemTypes.where('courseId').equals(courseId).toArray() : []),
    [courseId],
  );
  const course = courses?.find((c) => c.id === courseId);
  const type = types?.find((t) => t.id === typeId) ?? types?.[0];
  return (
    <li className="rounded-lg border border-slate-800 p-4">
      <p className="whitespace-pre-wrap break-words text-sm">{capture.text}</p>
      {!open && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Course">
            <Select
              value={courseId}
              onChange={(e) => {
                setCourseId(e.target.value);
                setTypeId('');
              }}
            >
              <option value="">Choose course…</option>
              {courses?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          {!!types?.length && (
            <Field label="Item type">
              <Select value={type?.id ?? ''} onChange={(e) => setTypeId(e.target.value)}>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Button disabled={!course || !type} onClick={() => setOpen(true)}>
            Convert note
          </Button>
          <Button
            variant="ghost"
            disabled={operation.busy}
            onClick={() => void operation.run(() => db.captures.delete(capture.id))}
          >
            Delete note
          </Button>
        </div>
      )}
      <Status {...operation} />
      {open && course && type && (
        <CaptureForm
          key={`${course.id}:${type.id}`}
          capture={capture}
          course={course}
          type={type}
          close={() => setOpen(false)}
        />
      )}
    </li>
  );
}

export function CapturesPanel() {
  const captures = useLiveQuery(() => db.captures.orderBy('createdAt').toArray(), []);
  if (!captures?.length) return null;
  return (
    <Panel title={`Captured notes · ${captures.length}`}>
      <ul className="space-y-3">
        {captures.map((capture) => (
          <CaptureRow key={capture.id} capture={capture} />
        ))}
      </ul>
    </Panel>
  );
}
