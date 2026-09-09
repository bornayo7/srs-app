import { useLiveQuery } from 'dexie-react-hooks';
import Dexie from 'dexie';
import { db } from '@/db/db';
import { Badge, Button, ButtonLink, Panel, Status } from '@/components/ui';
import { usePendingReviewCount, usePlan } from '@/hooks/useCourseData';
import { useNowTick } from '@/hooks/useNowTick';
import { courseGatingSummary, courseLevelProgress, recomputeUnlocks } from '@/services/gating';
import type { Course, ItemType, SrsLadder } from '@/engine/types';
import { now } from '@/services/clock';
import { useOperation } from '@/hooks/useOperation';
const RELEASE_LABEL = { progress: 'by progress', schedule: 'by date', manual: 'by hand' } as const;

/** Planned courses: where you are in the syllabus, and how much AI output awaits review. */
export function PlanPanel({ course }: { course: Course }) {
  const plan = usePlan(course.id);
  const pending = usePendingReviewCount(course.id) ?? 0;
  if (!plan) return null;
  const unit = plan.units.find((u) => u.level === course.currentLevel);
  return (
    <Panel
      title="Course plan"
      actions={
        <ButtonLink to={`/plan/${course.id}`} variant={pending > 0 ? 'primary' : 'secondary'}>
          {pending > 0 ? `Review ${pending} proposal${pending === 1 ? '' : 's'}` : 'Open plan'}
        </ButtonLink>
      }
    >
      <p className="text-sm text-slate-300">
        Unit {course.currentLevel} of {plan.units.length}
        {unit ? ` — ${unit.title}` : ''}
        <span className="text-slate-500"> · units open {RELEASE_LABEL[plan.releaseMode]}</span>
      </p>
    </Panel>
  );
}

/** Level progress, unlock tallies, stage distribution, and the repair button. */
export function ProgressPanel({
  course,
  ladder,
  types,
}: {
  course: Course;
  ladder: SrsLadder | null;
  types: ItemType[];
}) {
  const t = useNowTick(60_000);
  const operation = useOperation();

  const progress = useLiveQuery(
    () => courseLevelProgress(course.id),
    [course.id, course.currentLevel, t],
  );
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
          disabled={operation.busy}
          title="Re-evaluate every item's locked/unlocked state — use after editing prerequisites or levels"
          onClick={() =>
            void operation.run(async () => {
              const result = await recomputeUnlocks(course.id, now());
              operation.setMessage(
                result.changed ? `Updated ${result.changed} items.` : 'Unlocks are up to date.',
              );
            })
          }
        >
          {operation.busy ? 'Checking…' : 'Recheck unlocks'}
        </Button>
      }
    >
      <div className="space-y-4">
        {progress && (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-semibold text-slate-100">Level {progress.level}</span>
              <span className="text-xs text-slate-500">
                {course.levelConfig?.autoAdvance === false ? (
                  // a plan in schedule/manual mode owns the level — the
                  // "stalled" hint would send the user chasing gate items
                  <span>level set by the course plan</span>
                ) : progress.stalled ? (
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
            <div className="flex items-end gap-1.5 overflow-x-auto">
              {distribution.map((d) => (
                <div key={d.name} className="flex min-w-8 flex-1 flex-col items-center gap-1">
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
        <Status {...operation} />
      </div>
    </Panel>
  );
}
