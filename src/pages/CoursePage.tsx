import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import Dexie from 'dexie';
import { db } from '@/db/db';
import { Badge, Button, Panel, TextInput } from '@/components/ui';
import { useCourse, useCourseLadder } from '@/hooks/useCourseData';
import { useNowTick } from '@/hooks/useNowTick';
import { itemPreview } from '@/engine/grading/context';
import { DEFAULT_PASS_PERCENT } from '@/engine/levels';
import { isMediaKind } from '@/engine/typeDesign';
import { formatDuration, HOUR, minutesToMs } from '@/engine/time';
import { courseGatingSummary, courseLevelProgress, recomputeUnlocks } from '@/services/gating';
import type { Card, Course, FieldValue, Item, ItemType, SrsLadder } from '@/engine/types';
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
import { ItemTypeDesigner } from '@/components/editor/ItemTypeDesigner';
import { ItemEditorButton } from '@/components/editor/ItemEditor';
import { FieldValueInput } from '@/components/editor/FieldValueInput';

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
  course: Course;
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
  const previewById = new Map(
    (items ?? []).map((i) => {
      const ty = typeById.get(i.typeId);
      return [i.id, ty ? itemPreview(i, ty) : i.id];
    }),
  );
  const passedIds = new Set((items ?? []).filter((i) => i.passedAt !== null).map((i) => i.id));
  const sorted = [...(items ?? [])].sort(
    (a, b) => a.level - b.level || a.createdAt - b.createdAt,
  );
  const showLevels = course.levelMode === 'levels';

  /** Why is this item locked? Level, or which prerequisites are still pending. */
  const lockReason = (item: Item): string => {
    if (showLevels && item.level > course.currentLevel) return `Unlocks at level ${item.level}`;
    const pending = item.prereqIds
      .filter((id) => !passedIds.has(id))
      .map((id) => previewById.get(id) ?? '(deleted item)');
    return pending.length > 0
      ? `Waiting on: ${pending.join(', ')}`
      : 'Locked — run “Recheck unlocks”';
  };

  return (
    <Panel title={`Items · ${items?.length ?? 0}`}>
      {mnemonicError && <p className="mb-2 text-sm text-rose-300">{mnemonicError}</p>}
      {items && items.length === 0 && (
        <p className="text-sm text-slate-500">No items yet — add your first one below.</p>
      )}
      <ul className="divide-y divide-slate-800/70">
        {sorted.map((item) => {
          const ty = typeById.get(item.typeId);
          if (!ty) return null;
          const locked = item.status === 'locked';
          return (
            <li
              key={item.id}
              className={`flex items-center justify-between gap-3 py-2 ${locked ? 'opacity-60' : ''}`}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: ty.color }}
                />
                {showLevels && (
                  <span className="shrink-0 rounded bg-slate-800 px-1.5 text-[10px] text-slate-400">
                    L{item.level}
                  </span>
                )}
                <span className="truncate text-sm text-slate-200" title={item.note || undefined}>
                  {itemPreview(item, ty)}
                  {item.note && <span className="ml-1 text-violet-300/70">💡</span>}
                </span>
                <span className="shrink-0 text-xs text-slate-500">{ty.name}</span>
                {item.passedAt !== null && (
                  <span className="shrink-0 text-xs text-violet-400" title="Passed — unlocks its dependents">
                    ✓
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {locked ? (
                  <span title={lockReason(item)}>
                    <Badge>🔒 locked</Badge>
                  </span>
                ) : item.status === 'lesson' ? (
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
                <ItemEditorButton item={item} itemType={ty} course={course} ladder={ladder} />
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (confirm('Delete this item and its history?')) {
                      void deleteItem(item.id, now());
                    }
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

function AddItemForm({ course, types }: { course: Course; types: ItemType[] }) {
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [synonyms, setSynonyms] = useState('');
  const [note, setNote] = useState('');
  // default to the level the course is actually on, so new items aren't
  // accidentally created locked behind a level the user has already passed
  const [level, setLevel] = useState(course.currentLevel);
  const [prereqIds, setPrereqIds] = useState<string[]>([]);
  const [formError, setFormError] = useState('');
  // bumped after each add so field inputs holding their own draft text
  // (cloze, rich text, media) start empty for the next item
  const [resetKey, setResetKey] = useState(0);
  const existing = useLiveQuery(
    () => db.items.where('courseId').equals(course.id).toArray(),
    [course.id],
  );
  const typeById = new Map(types.map((t) => [t.id, t]));
  const ty = types.find((x) => x.id === typeId) ?? types[0];
  if (!ty) return null;

  return (
    <Panel title="Add item">
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setFormError('');
          const isEmpty = (v: FieldValue | undefined) =>
            v === undefined || (typeof v === 'string' ? !v.trim() : v.length === 0);
          // media is optional; every content field must be filled
          const blank = ty.fields.find((f) => !isMediaKind(f.kind) && isEmpty(values[f.id]));
          if (blank) {
            setFormError(`${blank.name} is empty.`);
            return;
          }
          const fieldValues: Record<string, FieldValue> = {};
          for (const f of ty.fields) {
            const v = values[f.id];
            fieldValues[f.id] = typeof v === 'string' ? v.trim() : (v ?? '');
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
              level,
              prereqIds,
            },
            now(),
          );
          setValues({});
          setSynonyms('');
          setNote('');
          setPrereqIds([]);
          setResetKey(resetKey + 1);
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
          {ty.fields.map((f) => (
            <label
              key={f.id}
              className={`block ${f.kind === 'clozeSentences' || f.kind === 'richtext' ? 'sm:col-span-2' : ''}`}
            >
              <span className="mb-1 block text-xs text-slate-400">{f.name}</span>
              <FieldValueInput
                key={`${f.id}:${resetKey}`}
                field={f}
                value={values[f.id]}
                onChange={(v) => setValues({ ...values, [f.id]: v })}
                onError={(msg) => setFormError(msg ? `${f.name}: ${msg}` : '')}
              />
            </label>
          ))}
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
        <div className="grid gap-2 sm:grid-cols-2">
          {course.levelMode === 'levels' && (
            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">
                Level (course is on level {course.currentLevel})
              </span>
              <TextInput
                type="number"
                min={1}
                value={level}
                onChange={(e) => setLevel(Math.max(1, +e.target.value || 1))}
                className="max-w-28"
              />
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-xs text-slate-400">
              Prerequisites — stays locked until these pass (ctrl/⌘-click for several)
            </span>
            <select
              multiple
              value={prereqIds}
              onChange={(e) =>
                setPrereqIds([...e.target.selectedOptions].map((o) => o.value))
              }
              size={Math.min(5, Math.max(2, existing?.length ?? 2))}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-violet-500"
            >
              {(existing ?? [])
                .slice()
                .sort((a, b) => a.level - b.level || a.createdAt - b.createdAt)
                .map((it) => {
                  const ity = typeById.get(it.typeId);
                  return (
                    <option key={it.id} value={it.id}>
                      {ity ? `${ity.icon} ` : ''}
                      {ity ? itemPreview(it, ity) : it.id}
                    </option>
                  );
                })}
            </select>
          </label>
        </div>
        <Button type="submit" variant="primary">
          Add item
        </Button>
        <span className="ml-2 text-xs text-slate-500">
          {prereqIds.length > 0 || (course.levelMode === 'levels' && level > course.currentLevel)
            ? 'This item starts locked until its prerequisites pass (and its level is reached).'
            : 'New items enter the lesson queue.'}
        </span>
      </form>
    </Panel>
  );
}

/** Level progress, unlock tallies, stage distribution, and the repair button. */
function ProgressPanel({
  course,
  ladder,
  types,
}: {
  course: Course;
  ladder: SrsLadder | null;
  types: ItemType[];
}) {
  const t = useNowTick(60_000);
  const [repairing, setRepairing] = useState(false);
  const [repairMsg, setRepairMsg] = useState('');

  const progress = useLiveQuery(() => courseLevelProgress(course.id), [course.id, course.currentLevel, t]);
  const summary = useLiveQuery(() => courseGatingSummary(course.id), [course.id, t]);
  const distribution = useLiveQuery(async () => {
    const cards = (
      await db.cards
        .where('[courseId+state]')
        .between([course.id, Dexie.minKey], [course.id, Dexie.maxKey])
        .toArray()
    ).filter((c) => !c.isGhost);
    const buckets = new Map<string, number>();
    const bump = (name: string) => buckets.set(name, (buckets.get(name) ?? 0) + 1);
    for (const c of cards) {
      if (c.state === 'new') bump('New');
      else if (c.state === 'burned') bump('Burned');
      else if (c.srs?.kind === 'ladder' && ladder) {
        bump(ladder.stages[c.srs.stageIndex]?.name ?? 'Burned');
      }
    }
    const order = ['New', ...(ladder?.stages.map((s) => s.name) ?? []), 'Burned'];
    return order.filter((n) => buckets.has(n)).map((name) => ({ name, count: buckets.get(name)! }));
  }, [course.id, ladder?.id, ladder?.updatedAt, t]);

  const max = Math.max(1, ...(distribution ?? []).map((d) => d.count));
  const gateNames = (course.levelConfig?.gateTypeIds ?? [])
    .map((id) => types.find((ty) => ty.id === id)?.name)
    .filter(Boolean);

  return (
    <Panel
      title="Progress"
      actions={
        <Button
          disabled={repairing}
          title="Re-evaluate every item's locked/unlocked state — use after editing prerequisites or levels"
          onClick={async () => {
            setRepairing(true);
            try {
              const res = await recomputeUnlocks(course.id, now());
              setRepairMsg(res.changed === 0 ? 'Everything already consistent.' : `Updated ${res.changed} item(s).`);
            } catch (err) {
              setRepairMsg((err as Error).message);
            } finally {
              setRepairing(false);
            }
          }}
        >
          {repairing ? '…' : 'Recheck unlocks'}
        </Button>
      }
    >
      <div className="space-y-4">
        {progress && (
          <div>
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-slate-100">Level {progress.level}</span>
              <span className="text-xs text-slate-500">
                {progress.stalled ? (
                  <span className="text-amber-300">
                    no {gateNames.length > 0 ? gateNames.join('/') : 'gate'} items at this level —
                    add some (or change gate types) to advance
                  </span>
                ) : (
                  <>
                    {progress.passedCount}/{progress.needed}{' '}
                    {gateNames.length > 0 ? gateNames.join('/') : 'items'} passed
                    {progress.remaining > 0
                      ? ` · ${progress.remaining} to level up`
                      : ' · ready to advance'}
                  </>
                )}
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded bg-slate-800">
              <div
                className="h-full bg-violet-500 transition-all"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          </div>
        )}

        {summary && (
          <div className="flex flex-wrap gap-1.5 text-xs">
            <Badge>{summary.total} items</Badge>
            {summary.locked > 0 && <Badge>🔒 {summary.locked} locked</Badge>}
            {summary.lesson > 0 && <Badge color="sky">{summary.lesson} in lesson queue</Badge>}
            {summary.active > 0 && <Badge color="emerald">{summary.active} learning</Badge>}
            {summary.passed > 0 && <Badge color="violet">{summary.passed} passed</Badge>}
            {summary.levelGatedOnly > 0 && (
              <Badge color="amber">{summary.levelGatedOnly} waiting on level-up</Badge>
            )}
          </div>
        )}

        {distribution && distribution.length > 0 && (
          <div>
            <div className="mb-1 text-xs text-slate-500">Stage distribution</div>
            <div className="flex items-end gap-1.5">
              {distribution.map((d) => (
                <div key={d.name} className="flex flex-1 flex-col items-center gap-1">
                  <span className="text-[10px] text-slate-400">{d.count}</span>
                  <div
                    className={`w-full rounded-t ${
                      d.name === 'New'
                        ? 'bg-slate-600'
                        : d.name === 'Burned'
                          ? 'bg-amber-500'
                          : 'bg-violet-500'
                    }`}
                    style={{ height: `${8 + (d.count / max) * 56}px` }}
                    title={`${d.name}: ${d.count}`}
                  />
                  <span className="w-full truncate text-center text-[9px] text-slate-500">
                    {d.name}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {repairMsg && <p className="text-xs text-slate-400">{repairMsg}</p>}
      </div>
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

function CourseSettings({ course, types }: { course: Course; types: ItemType[] }) {
  const navigate = useNavigate();
  const [newPerDay, setNewPerDay] = useState(course.lessons.newPerDay);
  const [batchSize, setBatchSize] = useState(course.lessons.batchSize);
  const [ghosts, setGhosts] = useState(course.ghosts);
  const [levelMode, setLevelMode] = useState(course.levelMode);
  const [gateTypeIds, setGateTypeIds] = useState<string[]>(course.levelConfig?.gateTypeIds ?? []);
  const [passPercent, setPassPercent] = useState(
    course.levelConfig?.passPercent ?? DEFAULT_PASS_PERCENT,
  );
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
        <label className="block">
          <span className="mb-1 block text-xs text-slate-400">🧗 Levels</span>
          <select
            value={levelMode}
            onChange={(e) => setLevelMode(e.target.value as typeof levelMode)}
            className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
            title="WaniKani-style pacing: items above the current level stay locked until enough of this level passes"
          >
            <option value="flat">flat — everything available</option>
            <option value="levels">levels — unlock level by level</option>
          </select>
        </label>
        {levelMode === 'levels' && (
          <>
            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">
                Gate types (empty = all types count)
              </span>
              <select
                multiple
                value={gateTypeIds}
                onChange={(e) => setGateTypeIds([...e.target.selectedOptions].map((o) => o.value))}
                size={Math.min(3, Math.max(2, types.length))}
                className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
              >
                {types.map((ty) => (
                  <option key={ty.id} value={ty.id}>
                    {ty.icon} {ty.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">Level-up at %</span>
              <TextInput
                type="number"
                min={1}
                max={100}
                value={passPercent}
                onChange={(e) => setPassPercent(Math.min(100, Math.max(1, +e.target.value || 90)))}
                className="max-w-24"
              />
            </label>
          </>
        )}
        <Button
          variant="primary"
          onClick={async () => {
            await updateCourse(
              {
                ...course,
                lessons: { newPerDay, batchSize },
                ghosts,
                levelMode,
                ...(levelMode === 'levels'
                  ? { levelConfig: { gateTypeIds, passPercent } }
                  : {}),
              },
              now(),
            );
            // level/gate changes alter what should be locked — resettle now
            await recomputeUnlocks(course.id, now());
          }}
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

      <ProgressPanel course={course} ladder={ladder ?? null} types={types} />
      <ItemsPanel course={course} types={types} ladder={ladder ?? null} />
      <AddItemForm course={course} types={types} />
      <GenerateItemsPanel courseId={course.id} types={types} />
      <ItemTypeDesigner course={course} types={types} />
      {ladder && <LadderEditor key={ladder.updatedAt} ladder={ladder} />}
      <CourseSettings course={course} types={types} />
      <p className="text-xs text-slate-600">
        First review lands {ladder ? formatDuration(minutesToMs(ladder.stages[0].intervalMinutes)) : `${formatDuration(4 * HOUR)}`} after a
        lesson, rounded down to the hour.
      </p>
    </div>
  );
}
