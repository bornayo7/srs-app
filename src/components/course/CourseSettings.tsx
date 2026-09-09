import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Field, Panel, Status, TextInput } from '@/components/ui';
import { useOperation } from '@/hooks/useOperation';
import { DEFAULT_PASS_PERCENT } from '@/engine/levels';
import { formatDuration, minutesToMs } from '@/engine/time';
import { newId } from '@/engine/ids';
import type { Course, ItemType, SrsLadder } from '@/engine/types';
import { deleteCourse } from '@/db/repo/courses';
import { saveCourseSettings } from '@/services/contentCommands';
import { saveLadderEdit } from '@/services/ladders';
import { now } from '@/services/clock';
export function LadderEditor({ ladder }: { ladder: SrsLadder }) {
  const [draft, setDraft] = useState<SrsLadder>(() => structuredClone(ladder));
  const operation = useOperation();

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
          disabled={operation.busy}
          onClick={() => void operation.run(() => saveLadderEdit(draft, now()), 'Ladder saved.')}
        >
          {operation.busy ? 'Saving…' : 'Save ladder'}
        </Button>
      }
    >
      <fieldset disabled={operation.busy} className="min-w-0">
        <div className="space-y-2">
          {draft.stages.map((s, i) => (
            <div
              key={s.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 p-2"
            >
              <span className="w-6 text-right text-xs text-slate-500">{i + 1}</span>
              <TextInput
                aria-label={`Stage ${i + 1} name`}
                value={s.name}
                onChange={(e) => setStage(i, { name: e.target.value })}
                className="max-w-44"
              />
              <TextInput
                aria-label={`Stage ${i + 1} interval in minutes`}
                type="number"
                min={1}
                value={s.intervalMinutes}
                onChange={(e) =>
                  setStage(i, { intervalMinutes: Math.max(1, +e.target.value || 1) })
                }
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
                aria-label={`Remove stage ${i + 1}`}
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
        <Status {...operation} />
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <Button
            onClick={() =>
              setDraft({
                ...draft,
                stages: [
                  ...draft.stages,
                  {
                    id: newId(),
                    name: `Stage ${draft.stages.length + 1}`,
                    intervalMinutes: 4 * 60,
                  },
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
      </fieldset>
    </Panel>
  );
}

export function CourseSettings({ course, types }: { course: Course; types: ItemType[] }) {
  const navigate = useNavigate();
  const operation = useOperation();
  const [name, setName] = useState(course.name);
  const [description, setDescription] = useState(course.description);
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
      <fieldset disabled={operation.busy} className="min-w-0">
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <Field label="Course name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description">
            <TextInput value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
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
                  onChange={(e) =>
                    setGateTypeIds([...e.target.selectedOptions].map((o) => o.value))
                  }
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
                  onChange={(e) =>
                    setPassPercent(Math.min(100, Math.max(1, +e.target.value || 90)))
                  }
                  className="max-w-24"
                />
              </label>
            </>
          )}
          <Button
            variant="primary"
            disabled={operation.busy || !name.trim()}
            onClick={() =>
              void operation.run(
                () =>
                  saveCourseSettings(
                    course.id,
                    {
                      name: name.trim(),
                      description: description.trim(),
                      lessons: { newPerDay, batchSize },
                      ghosts,
                      levelMode,
                      ...(levelMode === 'levels'
                        ? // spread keeps autoAdvance, which a plan's release mode owns
                          { levelConfig: { gateTypeIds, passPercent } }
                        : {}),
                    },
                    now(),
                  ),
                'Course settings saved.',
              )
            }
          >
            Save
          </Button>
          <div className="grow" />
          <Button
            variant="danger"
            disabled={operation.busy}
            onClick={async () => {
              if (confirm(`Delete "${course.name}" and ALL its items and history?`)) {
                void operation.run(async () => {
                  await deleteCourse(course.id);
                  navigate('/');
                });
              }
            }}
          >
            Delete course
          </Button>
        </div>
        <Status {...operation} />
      </fieldset>
    </Panel>
  );
}
