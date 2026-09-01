import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Badge, Button, Field, Panel, Select, TextArea, TextInput } from '@/components/ui';
import { aiErrorMessage } from '@/ai/client';
import {
  MATERIAL_CHAR_CAP,
  outlineProblems,
  outlineToPlannedCourse,
  planCourse,
  type PlanCourseResult,
  type PlannedOutline,
} from '@/ai/plan';
import type { PlanReleaseMode } from '@/engine/types';
import { useAiReady } from '@/hooks/useAiReady';
import { createPlannedCourse } from '@/services/plans';
import { now } from '@/services/clock';
import { maybeRefreshSnapshot } from '@/exchange/exchange';

export const RELEASE_MODES: { id: PlanReleaseMode; label: string; hint: string }[] = [
  {
    id: 'progress',
    label: 'By progress',
    hint: 'The next unit opens once enough of the current one reaches the pass stage.',
  },
  {
    id: 'schedule',
    label: 'By date',
    hint: 'Units open on their dates, tracking the class calendar — whether or not the last one is mastered.',
  },
  {
    id: 'manual',
    label: 'Manually',
    hint: 'Nothing opens until you press "Release next unit".',
  },
];

/**
 * Paste course material → AI outline (units + item types) → review/edit →
 * create the course. Items are NOT generated here; the plan page drafts each
 * unit on demand, into a review queue.
 */
export function PlanCoursePanel({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const aiReady = useAiReady();
  const [material, setMaterial] = useState('');
  const [hint, setHint] = useState('');
  const [releaseMode, setReleaseMode] = useState<PlanReleaseMode>('progress');
  const [preset, setPreset] = useState<'classic' | 'gentle' | 'bunpro'>('classic');
  const [newPerDay, setNewPerDay] = useState(10);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false); // synchronous mutex against double-click
  const [error, setError] = useState('');
  const [planned, setPlanned] = useState<PlanCourseResult | null>(null);

  async function guarded(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  if (aiReady === false) {
    return (
      <Panel title="📚 Plan a course from your material">
        <p className="text-sm text-slate-400">
          Add an API key in{' '}
          <Link to="/settings" className="text-violet-300 hover:underline">
            Settings → AI
          </Link>{' '}
          to turn a syllabus or your notes into a unit-by-unit course.
        </p>
      </Panel>
    );
  }

  const outline = planned?.outline;
  const problems = outline ? outlineProblems(outline) : [];
  const setOutline = (next: PlannedOutline) => planned && setPlanned({ ...planned, outline: next });
  const setUnit = (i: number, patch: Partial<PlannedOutline['units'][number]>) =>
    outline &&
    setOutline({ ...outline, units: outline.units.map((u, j) => (j === i ? { ...u, ...patch } : u)) });

  return (
    <Panel
      title="📚 Plan a course from your material"
      actions={
        <Button variant="ghost" onClick={onDone}>
          Close
        </Button>
      }
    >
      {!planned && (
        <div className="space-y-3">
          <TextArea
            value={material}
            onChange={(e) => setMaterial(e.target.value)}
            rows={10}
            autoFocus
            placeholder="Paste your syllabus, lecture notes, chapter summaries, slides — whatever the course is made of. The AI splits it into ordered units and later drafts questions and vocab for each; you approve every item before it enters your reviews."
            className="font-mono text-xs"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span>
              {material.length.toLocaleString()} characters
              {material.length > MATERIAL_CHAR_CAP
                ? ` — only the first ${MATERIAL_CHAR_CAP.toLocaleString()} will be read`
                : ''}
            </span>
          </div>
          <TextInput
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder="Optional steer — “12-week class, exams in weeks 6 and 12”, “focus on definitions and formulas”"
          />
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Release units">
              <Select
                value={releaseMode}
                onChange={(e) => setReleaseMode(e.target.value as PlanReleaseMode)}
              >
                {RELEASE_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="SRS ladder">
              <Select value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}>
                <option value="classic">Classic (WaniKani)</option>
                <option value="gentle">Gentle</option>
                <option value="bunpro">Bunpro-like</option>
              </Select>
            </Field>
            <Field label="New lessons / day">
              <TextInput
                type="number"
                min={1}
                value={newPerDay}
                onChange={(e) => setNewPerDay(Math.max(1, +e.target.value || 1))}
                className="max-w-24"
              />
            </Field>
            <Button
              variant="primary"
              disabled={busy || !material.trim()}
              onClick={() =>
                void guarded(async () => {
                  setPlanned(await planCourse(material, { hint }));
                })
              }
            >
              {busy ? 'Reading your material…' : 'Plan course'}
            </Button>
          </div>
          <p className="text-[11px] text-slate-500">
            {RELEASE_MODES.find((m) => m.id === releaseMode)?.hint} Within a unit, the daily
            lesson limit drips items in a few at a time.
          </p>
          {error && <p className="text-sm text-rose-300">{error}</p>}
        </div>
      )}

      {planned && outline && (
        <div className="space-y-3">
          {planned.materialTruncated && (
            <p className="text-xs text-amber-300">
              Your material was longer than the cap — this plan covers the first{' '}
              {MATERIAL_CHAR_CAP.toLocaleString()} characters. Put the rest in a second course
              if it matters.
            </p>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Course name">
              <TextInput
                value={outline.courseName}
                onChange={(e) => setOutline({ ...outline, courseName: e.target.value })}
              />
            </Field>
            <Field label="Description">
              <TextInput
                value={outline.description}
                onChange={(e) => setOutline({ ...outline, description: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {outline.itemTypes.map((t) => (
              <Badge key={t.name} color="sky">
                {t.icon} {t.name}:{' '}
                {t.templates
                  .map(
                    (tpl) =>
                      `${tpl.promptFields.join('+')} → ${tpl.answerField}${tpl.mode === 'choice' ? ' (choice)' : ''}`,
                  )
                  .join(', ')}
              </Badge>
            ))}
          </div>
          <ol className="space-y-2">
            {outline.units.map((u, i) => (
              <li key={i} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-6 text-right text-xs text-slate-500">{i + 1}</span>
                  <TextInput
                    value={u.title}
                    onChange={(e) => setUnit(i, { title: e.target.value })}
                    className="max-w-xs"
                  />
                  <label className="flex items-center gap-1 text-xs text-slate-400">
                    items
                    <TextInput
                      type="number"
                      min={1}
                      value={u.targetCount}
                      onChange={(e) => setUnit(i, { targetCount: Math.max(1, +e.target.value || 1) })}
                      className="max-w-20"
                    />
                  </label>
                  {releaseMode === 'schedule' && (
                    <label className="flex items-center gap-1 text-xs text-slate-400">
                      opens
                      <TextInput
                        type="date"
                        value={u.date}
                        onChange={(e) => setUnit(i, { date: e.target.value })}
                        className="max-w-40"
                      />
                    </label>
                  )}
                  <div className="grow" />
                  <Button
                    variant="ghost"
                    disabled={outline.units.length <= 1}
                    title="Remove this unit"
                    onClick={() =>
                      setOutline({ ...outline, units: outline.units.filter((_, j) => j !== i) })
                    }
                  >
                    ✕
                  </Button>
                </div>
                {u.summary && <p className="mt-1 text-xs text-slate-400">{u.summary}</p>}
                {u.topics.length > 0 && (
                  <p className="mt-1 text-xs text-slate-500">{u.topics.join(' · ')}</p>
                )}
              </li>
            ))}
          </ol>
          <Button
            onClick={() =>
              setOutline({
                ...outline,
                units: [
                  ...outline.units,
                  {
                    title: `Unit ${outline.units.length + 1}`,
                    summary: '',
                    topics: [],
                    targetCount: 10,
                    date: '',
                  },
                ],
              })
            }
          >
            + Add unit
          </Button>
          {problems.length > 0 && (
            <ul className="space-y-0.5 text-xs text-rose-300">
              {problems.map((p) => (
                <li key={p}>⚠ {p}</li>
              ))}
            </ul>
          )}
          {error && <p className="text-sm text-rose-300">{error}</p>}
          <div className="flex gap-2">
            <Button onClick={() => setPlanned(null)}>← Start over</Button>
            <Button
              variant="primary"
              disabled={busy || problems.length > 0 || !outline.courseName.trim()}
              onClick={() =>
                void guarded(async () => {
                  const res = await createPlannedCourse(
                    outlineToPlannedCourse(outline, planned.material, planned.materialTruncated, {
                      releaseMode,
                      ladderPreset: preset,
                      newPerDay,
                    }),
                    now(),
                  );
                  void maybeRefreshSnapshot(now());
                  onDone();
                  navigate(`/plan/${res.courseId}`);
                })
              }
            >
              {busy ? 'Creating…' : 'Create course & review units'}
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            No items yet — the plan page drafts each unit's items on demand, and you accept or
            reject every one before it enters your lessons.
          </p>
        </div>
      )}
    </Panel>
  );
}
