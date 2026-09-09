import { useState } from 'react';
import { useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import {
  Badge,
  Button,
  ButtonLink,
  Field,
  Panel,
  Select,
  Status,
  TextInput,
} from '@/components/ui';
import { RELEASE_MODES } from '@/components/ai/PlanCoursePanel';
import { ProposalQueue } from '@/components/proposals/ProposalQueue';
import { useCourse } from '@/hooks/useCourseData';
import { useAiReady } from '@/hooks/useAiReady';
import { useOperation } from '@/hooks/useOperation';
import { proposalsForCourse } from '@/db/repo/proposals';
import { generateUnitItems } from '@/ai/plan';
import {
  appendUnit,
  planProgress,
  releaseNextUnit,
  setReleaseMode,
  updateUnit,
  type UnitProgress,
} from '@/services/plans';
import { formatReleaseDate, parseReleaseAt } from '@/services/releaseDates';
import { now } from '@/services/clock';
import type { ItemType, PlanReleaseMode, Proposal } from '@/engine/types';

function ReleaseDate({ courseId, unit }: { courseId: string; unit: UnitProgress }) {
  const [date, setDate] = useState(formatReleaseDate(unit.releaseAt));
  const operation = useOperation();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void operation.run(
          () =>
            updateUnit(
              courseId,
              unit.level,
              { releaseAt: parseReleaseAt(date) ?? undefined },
              now(),
            ),
          'Release date saved.',
        );
      }}
    >
      <Field label="Opens on">
        <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Button type="submit" disabled={operation.busy || date === formatReleaseDate(unit.releaseAt)}>
        Save date
      </Button>
      <Status {...operation} />
    </form>
  );
}

function PlanUnit({
  courseId,
  unit,
  mode,
  proposals,
  types,
}: {
  courseId: string;
  unit: UnitProgress;
  mode: PlanReleaseMode;
  proposals: Proposal[];
  types: ItemType[];
}) {
  const aiReady = useAiReady();
  const operation = useOperation();
  const [count, setCount] = useState(Math.min(60, unit.targetCount || 10));
  const [instruction, setInstruction] = useState('');
  return (
    <details
      open={unit.current || unit.pending > 0}
      className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"
    >
      <summary className="cursor-pointer text-base font-medium">
        <span className="mr-2">
          Unit {unit.level}: {unit.title}
        </span>
        <Badge color={unit.current ? 'violet' : 'slate'}>
          {unit.current ? 'Current' : unit.released ? 'Open' : 'Locked'}
        </Badge>
        <span className="ml-2 text-sm text-slate-500">
          {unit.items} items · {unit.pending} drafts waiting
        </span>
      </summary>
      <div className="mt-4 space-y-4">
        {unit.summary && <p className="max-w-3xl text-sm text-slate-400">{unit.summary}</p>}
        {unit.topics.length > 0 && (
          <p className="text-sm text-slate-500">{unit.topics.join(', ')}</p>
        )}
        {mode === 'schedule' && (
          <ReleaseDate key={`${unit.level}:${unit.releaseAt}`} courseId={courseId} unit={unit} />
        )}
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Number of drafts">
            <TextInput
              className="max-w-24"
              type="number"
              min={1}
              max={60}
              step={1}
              value={count}
              onChange={(e) =>
                setCount(Math.min(60, Math.max(1, Math.floor(+e.target.value || 1))))
              }
            />
          </Field>
          <Field label="Guidance for the draft (optional)" className="min-w-0 grow">
            <TextInput
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="More formulas, chapter 3, replace rejected items…"
            />
          </Field>
          <Button
            variant="primary"
            disabled={operation.busy || aiReady !== true}
            onClick={() =>
              void operation.run(async () => {
                const result = await generateUnitItems(
                  courseId,
                  unit.level,
                  { count, instruction },
                  now(),
                );
                operation.setMessage(
                  `${result.proposalsAdded} drafts added for review. ${result.warnings.join(' ')}`,
                );
              })
            }
          >
            {operation.busy ? 'Drafting…' : unit.generatedAt ? 'Draft more items' : 'Draft items'}
          </Button>
        </div>
        {aiReady === false && (
          <p className="text-sm text-slate-500">
            Configure a provider in Settings to draft with AI. Imported drafts can be reviewed
            below.
          </p>
        )}
        <Status {...operation} />
        <ProposalQueue proposals={proposals} types={types} title={`Unit ${unit.level} drafts`} />
      </div>
    </details>
  );
}

export default function PlanPage() {
  const { courseId } = useParams<{ courseId: string }>();
  const course = useCourse(courseId);
  const progress = useLiveQuery(() => (courseId ? planProgress(courseId) : null), [courseId]);
  const proposals = useLiveQuery(() => (courseId ? proposalsForCourse(courseId) : []), [courseId]);
  const types = useLiveQuery(
    () => (courseId ? db.itemTypes.where('courseId').equals(courseId).toArray() : []),
    [courseId],
  );
  const operation = useOperation();
  const [newUnit, setNewUnit] = useState('');
  if (course === null)
    return (
      <Panel title="Course not found">
        <ButtonLink to="/">Back to Today</ButtonLink>
      </Panel>
    );
  if (!course || progress === undefined || !proposals || !types)
    return <p role="status">Loading plan and drafts…</p>;
  const plan = progress?.plan;
  const outside = plan
    ? proposals.filter((p) => !plan.units.some((u) => u.level === p.level))
    : proposals;
  const outsideLevels = [...new Set(outside.map((p) => p.level))].sort((a, b) => a - b);
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">{course.name}</h1>
          <p className="mt-1 text-sm text-slate-400">Plan and content drafts</p>
        </div>
        <ButtonLink to={`/course/${course.id}`}>Back to course</ButtonLink>
      </header>
      <nav className="workspace-tabs" aria-label="Course sections">
        <ButtonLink to={`/course/${course.id}`}>Study</ButtonLink>
        <ButtonLink to={`/course/${course.id}?view=items`}>Items</ButtonLink>
        <span aria-current="page" className="p-3 text-sm text-violet-300">
          Plan & drafts
        </span>
        <ButtonLink to={`/course/${course.id}?view=settings`}>Course settings</ButtonLink>
      </nav>
      <Status {...operation} />
      {plan && progress ? (
        <>
          <Panel title="Unit release">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Units open">
                <Select
                  value={plan.releaseMode}
                  disabled={operation.busy}
                  onChange={(e) =>
                    void operation.run(
                      () => setReleaseMode(course.id, e.target.value as PlanReleaseMode, now()),
                      'Release mode saved.',
                    )
                  }
                >
                  {RELEASE_MODES.map((mode) => (
                    <option key={mode.id} value={mode.id}>
                      {mode.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                disabled={operation.busy || course.currentLevel >= plan.units.length}
                onClick={() =>
                  void operation.run(() => releaseNextUnit(course.id, now()), 'Next unit released.')
                }
              >
                Release next unit
              </Button>
            </div>
            <p className="mt-3 text-sm text-slate-500">
              {RELEASE_MODES.find((m) => m.id === plan.releaseMode)?.hint}
            </p>
            {plan.releaseMode === 'schedule' &&
              plan.units.some((u) => u.releaseAt === undefined) && (
                <p className="mt-2 text-sm text-amber-300">
                  Units without dates remain available for manual release.
                </p>
              )}
            {plan.materialTruncated && (
              <p className="mt-2 text-sm text-amber-300">
                Only part of the original material was retained. Review draft coverage before
                accepting.
              </p>
            )}
          </Panel>
          {progress.units.map((unit) => (
            <PlanUnit
              key={`${course.id}:${unit.level}`}
              courseId={course.id}
              unit={unit}
              mode={plan.releaseMode}
              proposals={proposals.filter((p) => p.level === unit.level)}
              types={types}
            />
          ))}
          <Panel title="Add a unit">
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!newUnit.trim()) return;
                void operation.run(async () => {
                  await appendUnit(
                    course.id,
                    { title: newUnit.trim(), summary: '', topics: [], targetCount: 10 },
                    now(),
                  );
                  setNewUnit('');
                }, 'Unit added.');
              }}
            >
              <Field label="Unit title" className="grow">
                <TextInput
                  value={newUnit}
                  disabled={operation.busy}
                  onChange={(e) => setNewUnit(e.target.value)}
                />
              </Field>
              <Button type="submit" disabled={operation.busy || !newUnit.trim()}>
                Add unit
              </Button>
            </form>
          </Panel>
        </>
      ) : (
        <Panel title="Course drafts">
          <p className="text-sm text-slate-400">
            This course has no unit plan. Content sent here by an assistant still appears below for
            review.
          </p>
        </Panel>
      )}
      {outsideLevels.map((level) => (
        <ProposalQueue
          key={level}
          proposals={outside.filter((p) => p.level === level)}
          types={types}
          title={plan ? `Outside the plan · level ${level}` : `Level ${level} drafts`}
        />
      ))}
      {!plan && proposals.length === 0 && (
        <p className="text-sm text-slate-500">
          No drafts waiting. Import a proposal packet from Inbox, or create items in the course.
        </p>
      )}
    </div>
  );
}
