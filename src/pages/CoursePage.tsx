import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { Badge, Button, Panel, TextInput } from '@/components/ui';
import { useCourse, useCourseLadder } from '@/hooks/useCourseData';
import { useNowTick } from '@/hooks/useNowTick';
import { itemPreview } from '@/engine/grading/context';
import { parseClozeLines } from '@/engine/grading/cloze';
import { formatDuration, HOUR, minutesToMs } from '@/engine/time';
import type { Card, FieldValue, ItemType, SrsLadder } from '@/engine/types';
import { newId } from '@/engine/ids';
import { createItem, deleteItem, updateItem } from '@/db/repo/items';
import { deleteCourse, updateCourse } from '@/db/repo/courses';
import { saveLadderEdit } from '@/services/ladders';
import { now } from '@/services/clock';
import { GenerateItemsPanel } from '@/components/ai/GenerateItemsPanel';
import { generateMnemonic } from '@/ai/generate';
import { aiErrorMessage } from '@/ai/client';
import { useAiReady } from '@/hooks/useAiReady';
import { exportCoursePackage, downloadPackage } from '@/packages/exportPackage';

function stageBadge(ladder: SrsLadder | null, card: Card | undefined, t: number) {
  if (!card) return null;
  if (card.state === 'new') return <Badge>new</Badge>;
  if (card.state === 'burned') return <Badge color="amber">🔥 burned</Badge>;
  if (!ladder || card.srs?.kind !== 'ladder') return <Badge>—</Badge>;
  const idx = card.srs.stageIndex;
  const name = idx >= ladder.stages.length ? 'Burned' : ladder.stages[idx].name;
  const color = idx >= ladder.passesAtIndex ? 'violet' : 'rose';
  const due =
    card.dueAt === undefined ? '' : card.dueAt <= t ? ' · due now' : ` · ${formatDuration(card.dueAt - t)}`;
  return <Badge color={color}>{name + due}</Badge>;
}

function ItemsPanel({
  course,
  types,
  ladder,
}: {
  course: { id: string };
  types: ItemType[];
  ladder: SrsLadder | null;
}) {
  const t = useNowTick();
  const aiReady = useAiReady();
  const [mnemonicBusy, setMnemonicBusy] = useState<string | null>(null);
  const [mnemonicError, setMnemonicError] = useState('');
  const items = useLiveQuery(
    () => db.items.where('courseId').equals(course.id).toArray(),
    [course.id],
  );

  async function writeMnemonic(itemId: string) {
    setMnemonicBusy(itemId);
    setMnemonicError('');
    try {
      const note = await generateMnemonic(itemId);
      const item = await db.items.get(itemId);
      if (item) await updateItem({ ...item, note }, now());
    } catch (err) {
      setMnemonicError(aiErrorMessage(err));
    } finally {
      setMnemonicBusy(null);
    }
  }
  const cards = useLiveQuery(async () => {
    const list = await db.cards.where('itemId').anyOf((items ?? []).map((i) => i.id)).toArray();
    const byItem = new Map<string, Card[]>();
    for (const c of list) {
      const arr = byItem.get(c.itemId) ?? [];
      arr.push(c);
      byItem.set(c.itemId, arr);
    }
    return byItem;
  }, [items]);

  const typeById = new Map(types.map((ty) => [ty.id, ty]));

  return (
    <Panel title={`Items · ${items?.length ?? 0}`}>
      {mnemonicError && <p className="mb-2 text-sm text-rose-300">{mnemonicError}</p>}
      {items && items.length === 0 && (
        <p className="text-sm text-slate-500">No items yet — add your first one below.</p>
      )}
      <ul className="divide-y divide-slate-800/70">
        {items?.map((item) => {
          const ty = typeById.get(item.typeId);
          if (!ty) return null;
          return (
            <li key={item.id} className="flex items-center justify-between gap-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: ty.color }}
                />
                <span className="truncate text-sm text-slate-200" title={item.note || undefined}>
                  {itemPreview(item, ty)}
                  {item.note && <span className="ml-1 text-violet-300/70">💡</span>}
                </span>
                <span className="shrink-0 text-xs text-slate-500">{ty.name}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {item.status === 'lesson' ? (
                  <Badge color="sky">lesson queue</Badge>
                ) : (
                  (cards?.get(item.id) ?? []).map((c) =>
                    c.isGhost ? (
                      <span key={c.id} title="ghost drill pending">
                        <Badge color="sky">👻</Badge>
                      </span>
                    ) : (
                      <span key={c.id}>{stageBadge(ladder, c, t)}</span>
                    ),
                  )
                )}
                {aiReady && (
                  <Button
                    variant="ghost"
                    title="Write a mnemonic with AI"
                    disabled={mnemonicBusy !== null}
                    onClick={() => void writeMnemonic(item.id)}
                  >
                    {mnemonicBusy === item.id ? '…' : '✨'}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (confirm('Delete this item and its history?')) void deleteItem(item.id);
                  }}
                >
                  ✕
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function AddItemForm({ types }: { courseId: string; types: ItemType[] }) {
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  const [synonyms, setSynonyms] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState('');
  const ty = types.find((x) => x.id === typeId) ?? types[0];
  if (!ty) return null;

  return (
    <Panel title="Add item">
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setFormError('');
          const missing = ty.fields.some((f) => !(values[f.id] ?? '').trim());
          if (missing) return;
          // cloze fields are typed as text and parsed line-by-line
          const fieldValues: Record<string, FieldValue> = {};
          for (const f of ty.fields) {
            const raw = (values[f.id] ?? '').trim();
            if (f.kind === 'clozeSentences') {
              const { sentences, error } = parseClozeLines(raw);
              if (error) {
                setFormError(`${f.name}: ${error}`);
                return;
              }
              fieldValues[f.id] = sentences;
            } else {
              fieldValues[f.id] = raw;
            }
          }
          const syns = synonyms
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          const synMap: Record<string, string[]> = {};
          if (syns.length > 0) for (const tpl of ty.templates) synMap[tpl.id] = syns;
          await createItem(
            {
              courseId: ty.courseId,
              typeId: ty.id,
              fieldValues,
              synonyms: synMap,
              note: note.trim(),
            },
            now(),
          );
          setValues({});
          setSynonyms('');
          setNote('');
        }}
      >
        {types.length > 1 && (
          <select
            value={typeId}
            onChange={(e) => setTypeId(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
          >
            {types.map((x) => (
              <option key={x.id} value={x.id}>
                {x.icon} {x.name}
              </option>
            ))}
          </select>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          {ty.fields.map((f) =>
            f.kind === 'clozeSentences' ? (
              <label key={f.id} className="block sm:col-span-2">
                <span className="mb-1 block text-xs text-slate-400">
                  {f.name} — one sentence per line, blank in ⟦brackets⟧, optional "&nbsp;:: translation"
                </span>
                <textarea
                  value={values[f.id] ?? ''}
                  onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
                  rows={3}
                  placeholder={'The cat sat ⟦on⟧ the mat. :: translation here\nHang ⟦on⟧ a second!'}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-violet-500"
                />
              </label>
            ) : (
              <label key={f.id} className="block">
                <span className="mb-1 block text-xs text-slate-400">{f.name}</span>
                <TextInput
                  value={values[f.id] ?? ''}
                  onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
                />
              </label>
            ),
          )}
        </div>
        {formError && <p className="text-sm text-rose-300">{formError}</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs text-slate-400">
              Extra accepted answers (comma-separated)
            </span>
            <TextInput value={synonyms} onChange={(e) => setSynonyms(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-400">Note / mnemonic</span>
            <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <Button type="submit" variant="primary">
          Add item
        </Button>
        <span className="ml-2 text-xs text-slate-500">New items enter the lesson queue.</span>
      </form>
    </Panel>
  );
}

function LadderEditor({ ladder }: { ladder: SrsLadder }) {
  const [draft, setDraft] = useState<SrsLadder>(() => structuredClone(ladder));
  const [saved, setSaved] = useState(false);

  const setStage = (i: number, patch: Partial<{ name: string; intervalMinutes: number }>) => {
    const stages = draft.stages.map((s, j) => (j === i ? { ...s, ...patch } : s));
    setDraft({ ...draft, stages });
  };

  return (
    <Panel
      title={`SRS ladder · ${draft.name}`}
      actions={
        <Button
          variant="primary"
          onClick={async () => {
            await saveLadderEdit(draft, now());
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
          }}
        >
          {saved ? 'Saved ✓' : 'Save ladder'}
        </Button>
      }
    >
      <div className="space-y-2">
        {draft.stages.map((s, i) => (
          <div key={s.id} className="flex items-center gap-2">
            <span className="w-6 text-right text-xs text-slate-500">{i + 1}</span>
            <TextInput
              value={s.name}
              onChange={(e) => setStage(i, { name: e.target.value })}
              className="max-w-44"
            />
            <TextInput
              type="number"
              min={1}
              value={s.intervalMinutes}
              onChange={(e) => setStage(i, { intervalMinutes: Math.max(1, +e.target.value || 1) })}
              className="max-w-28"
            />
            <span className="w-12 text-xs text-slate-500">
              {formatDuration(minutesToMs(s.intervalMinutes))}
            </span>
            <label className="flex items-center gap-1 text-xs text-slate-400">
              <input
                type="radio"
                name="passes"
                checked={draft.passesAtIndex === i}
                onChange={() => setDraft({ ...draft, passesAtIndex: i })}
              />
              passes
            </label>
            <Button
              variant="ghost"
              disabled={draft.stages.length <= 1}
              onClick={() => {
                const stages = draft.stages.filter((_, j) => j !== i);
                // keep the "passes" marker on the same stage when one above it goes
                const passesAtIndex = Math.min(
                  i < draft.passesAtIndex ? draft.passesAtIndex - 1 : draft.passesAtIndex,
                  stages.length - 1,
                );
                setDraft({ ...draft, stages, passesAtIndex });
              }}
            >
              ✕
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-4">
        <Button
          onClick={() =>
            setDraft({
              ...draft,
              stages: [
                ...draft.stages,
                { id: newId(), name: `Stage ${draft.stages.length + 1}`, intervalMinutes: 4 * 60 },
              ],
            })
          }
        >
          + Add stage
        </Button>
        <label className="flex items-center gap-1.5 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={draft.burnEnabled}
            onChange={(e) => setDraft({ ...draft, burnEnabled: e.target.checked })}
          />
          Burn after the last stage (retire items forever)
        </label>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Interval is in minutes; "passes" marks the Guru-equivalent stage used for future unlock
        rules. Changes apply to each card at its next review.
      </p>
    </Panel>
  );
}

function CourseSettings({ course }: { course: NonNullable<ReturnType<typeof useCourse>> }) {
  const navigate = useNavigate();
  const [newPerDay, setNewPerDay] = useState(course.lessons.newPerDay);
  const [batchSize, setBatchSize] = useState(course.lessons.batchSize);
  const [ghosts, setGhosts] = useState(course.ghosts);
  return (
    <Panel title="Course settings">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-xs text-slate-400">New lessons / day</span>
          <TextInput
            type="number"
            min={0}
            value={newPerDay}
            onChange={(e) => setNewPerDay(Math.max(0, +e.target.value || 0))}
            className="max-w-28"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-slate-400">Lesson batch size</span>
          <TextInput
            type="number"
            min={1}
            value={batchSize}
            onChange={(e) => setBatchSize(Math.max(1, +e.target.value || 1))}
            className="max-w-28"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-slate-400">👻 Ghost reviews</span>
          <select
            value={ghosts}
            onChange={(e) => setGhosts(e.target.value as typeof ghosts)}
            className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
            title="Missed cards spawn short-cycle drill copies that graduate and vanish (Bunpro-style)"
          >
            <option value="off">off</option>
            <option value="minimal">minimal — after repeated misses</option>
            <option value="on">on — every miss</option>
          </select>
        </label>
        <Button
          variant="primary"
          onClick={() =>
            void updateCourse({ ...course, lessons: { newPerDay, batchSize }, ghosts }, now())
          }
        >
          Save
        </Button>
        <div className="grow" />
        <Button
          variant="danger"
          onClick={async () => {
            if (confirm(`Delete "${course.name}" and ALL its items and history?`)) {
              await deleteCourse(course.id);
              navigate('/');
            }
          }}
        >
          Delete course
        </Button>
      </div>
    </Panel>
  );
}

export default function CoursePage() {
  const { courseId } = useParams<{ courseId: string }>();
  const course = useCourse(courseId);
  const ladder = useCourseLadder(course);
  const types = useLiveQuery(
    () => (courseId ? db.itemTypes.where('courseId').equals(courseId).toArray() : []),
    [courseId],
  );

  if (course === null) {
    return (
      <div className="py-16 text-center">
        <p className="text-slate-300">This course no longer exists.</p>
        <Link to="/" className="mt-3 inline-block">
          <Button>Back to dashboard</Button>
        </Link>
      </div>
    );
  }
  if (!course || !types) return <p className="py-16 text-center text-slate-500">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-100">{course.name}</h1>
          <p className="text-sm text-slate-500">{course.description}</p>
        </div>
        <div className="flex gap-2">
          <Button
            title="Download this course as a shareable content package (no SRS state)"
            onClick={async () => downloadPackage(await exportCoursePackage(course.id))}
          >
            Export package
          </Button>
          <Link to={`/lessons/${course.id}`}>
            <Button>Lessons</Button>
          </Link>
          <Link to={`/review/${course.id}`}>
            <Button variant="primary">Reviews</Button>
          </Link>
        </div>
      </div>

      <Panel title="Extra study (no SRS effect)">
        <div className="flex flex-wrap gap-2">
          <Link to={`/cram/${course.id}?scope=learned`}>
            <Button>🎯 Cram everything learned</Button>
          </Link>
          <Link to={`/cram/${course.id}?scope=leeches`}>
            <Button>🩹 Leeches (3+ lapses)</Button>
          </Link>
          <Link to={`/cram/${course.id}?scope=misses`}>
            <Button>🔁 Missed this week</Button>
          </Link>
        </div>
      </Panel>

      <ItemsPanel course={course} types={types} ladder={ladder ?? null} />
      <AddItemForm courseId={course.id} types={types} />
      <GenerateItemsPanel courseId={course.id} types={types} />
      {ladder && <LadderEditor key={ladder.updatedAt} ladder={ladder} />}
      <CourseSettings course={course} />
      <p className="text-xs text-slate-600">
        First review lands {ladder ? formatDuration(minutesToMs(ladder.stages[0].intervalMinutes)) : `${formatDuration(4 * HOUR)}`} after a
        lesson, rounded down to the hour.
      </p>
    </div>
  );
}
