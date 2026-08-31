import { useLiveQuery } from 'dexie-react-hooks';
import Dexie from 'dexie';
import { db } from '@/db/db';
import { Badge, Panel } from '@/components/ui';
import { DAY, startOfLocalDay } from '@/engine/time';
import { useNowTick } from '@/hooks/useNowTick';
import type { ReviewLog, SrsLadder } from '@/engine/types';

const WEEKS = 26;

function isMiss(l: ReviewLog): boolean {
  return l.outcome?.kind === 'ladder' ? l.outcome.incorrectCount > 0 : false;
}

function Heatmap({ logs, t }: { logs: ReviewLog[]; t: number }) {
  const days = WEEKS * 7;
  const counts = new Map<number, number>();
  for (const l of logs) {
    const day = startOfLocalDay(l.ts);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  // grid columns = weeks, rows = weekday; rightmost column is the current week.
  // Walk days via calendar arithmetic (setDate), not fixed 24h steps — DST
  // days are 23/25h long and fixed steps would mis-bucket everything past one.
  const todayDow = new Date(t).getDay();
  const anchor = new Date(t);
  anchor.setHours(0, 0, 0, 0);
  const cells: { day: number; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(anchor);
    d.setDate(anchor.getDate() - i);
    cells.push({ day: d.getTime(), count: counts.get(d.getTime()) ?? 0 });
  }
  const max = Math.max(1, ...cells.map((c) => c.count));
  const shade = (count: number): string => {
    if (count === 0) return 'bg-slate-800/60';
    const q = count / max;
    if (q < 0.25) return 'bg-violet-900';
    if (q < 0.5) return 'bg-violet-700';
    if (q < 0.75) return 'bg-violet-500';
    return 'bg-violet-400';
  };
  // pad the start so the first cell lands on its true weekday row
  const firstDow = new Date(cells[0].day).getDay();
  const padded = [...Array.from({ length: firstDow }, () => null), ...cells];
  const columns: ({ day: number; count: number } | null)[][] = [];
  for (let i = 0; i < padded.length; i += 7) columns.push(padded.slice(i, i + 7));

  const total = logs.length;
  return (
    <Panel title={`Review heatmap — last ${WEEKS} weeks`}>
      <div className="overflow-x-auto pb-1">
        <div className="flex gap-[3px]">
          {columns.map((col, ci) => (
            <div key={ci} className="flex flex-col gap-[3px]">
              {col.map((cell, ri) =>
                cell === null || (ci === columns.length - 1 && ri > todayDow) ? (
                  <div key={ri} className="h-3 w-3" />
                ) : (
                  <div
                    key={ri}
                    className={`h-3 w-3 rounded-[3px] ${shade(cell.count)}`}
                    title={`${new Date(cell.day).toLocaleDateString()} — ${cell.count} review${cell.count === 1 ? '' : 's'}`}
                  />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        {total} reviews in the window · darker = more reviews that day
      </p>
    </Panel>
  );
}

function RetentionPanel({ logs, t }: { logs: ReviewLog[]; t: number }) {
  const rate = (subset: ReviewLog[]): string => {
    if (subset.length === 0) return '—';
    const hits = subset.filter((l) => !isMiss(l)).length;
    return `${Math.round((hits / subset.length) * 100)}%`;
  };
  const last30 = logs.filter((l) => l.ts >= t - 30 * DAY);
  const last7 = logs.filter((l) => l.ts >= t - 7 * DAY);
  return (
    <Panel title="Retention (correct on first try)">
      <div className="grid grid-cols-3 gap-3 text-center">
        {(
          [
            ['All time', rate(logs), logs.length],
            ['Last 30 days', rate(last30), last30.length],
            ['Last 7 days', rate(last7), last7.length],
          ] as const
        ).map(([label, value, n]) => (
          <div key={label} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <div className="text-2xl font-bold text-slate-50">{value}</div>
            <div className="text-xs text-slate-500">
              {label} · {n} reviews
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function CourseStats() {
  const rows = useLiveQuery(async () => {
    const courses = await db.courses.toArray();
    return Promise.all(
      courses.map(async (course) => {
        const cards = await db.cards
          .where('[courseId+state]')
          .between([course.id, Dexie.minKey], [course.id, Dexie.maxKey])
          .toArray();
        const real = cards.filter((c) => !c.isGhost);
        const ladder =
          course.scheduling.kind === 'ladder'
            ? ((await db.ladders.get(course.scheduling.ladderId)) ?? null)
            : null;
        const logs = await db.reviewLogs
          .where('[courseId+ts]')
          .between([course.id, Dexie.minKey], [course.id, Dexie.maxKey])
          .toArray();
        const reviews = logs.filter((l) => l.kind === 'review');
        return { course, cards: real, ladder, reviews };
      }),
    );
  }, []);

  if (!rows || rows.length === 0) return null;

  const bucket = (ladder: SrsLadder | null, stageIndex: number): 'pre' | 'post' | 'burned' => {
    if (!ladder) return 'pre';
    if (stageIndex >= ladder.stages.length) return 'burned';
    return stageIndex >= ladder.passesAtIndex ? 'post' : 'pre';
  };

  return (
    <Panel title="Per course">
      <div className="space-y-3">
        {rows.map(({ course, cards, ladder, reviews }) => {
          const hits = reviews.filter((l) => !isMiss(l)).length;
          const acc = reviews.length === 0 ? null : Math.round((hits / reviews.length) * 100);
          const counts = { new: 0, pre: 0, post: 0, burned: 0 };
          for (const c of cards) {
            if (c.state === 'new') counts.new++;
            else if (c.state === 'burned') counts.burned++;
            else if (c.srs?.kind === 'ladder') counts[bucket(ladder, c.srs.stageIndex)]++;
          }
          const totalBar = Math.max(1, counts.new + counts.pre + counts.post + counts.burned);
          return (
            <div key={course.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium text-slate-200">{course.name}</span>
                <span className="flex shrink-0 gap-1.5">
                  {acc !== null && <Badge color="violet">{acc}% accuracy</Badge>}
                  <Badge>{reviews.length} reviews</Badge>
                </span>
              </div>
              <div className="mt-2 flex h-2 overflow-hidden rounded bg-slate-800">
                <div className="bg-slate-600" style={{ width: `${(counts.new / totalBar) * 100}%` }} />
                <div className="bg-rose-500" style={{ width: `${(counts.pre / totalBar) * 100}%` }} />
                <div className="bg-violet-500" style={{ width: `${(counts.post / totalBar) * 100}%` }} />
                <div className="bg-amber-500" style={{ width: `${(counts.burned / totalBar) * 100}%` }} />
              </div>
              <div className="mt-1 flex gap-3 text-[11px] text-slate-500">
                <span>◼ new {counts.new}</span>
                <span className="text-rose-400">◼ learning {counts.pre}</span>
                <span className="text-violet-400">◼ passed {counts.post}</span>
                <span className="text-amber-400">◼ burned {counts.burned}</span>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export default function StatsPage() {
  const t = useNowTick(60_000);
  // ALL review logs — retention's "all time" must actually be all time;
  // the heatmap windows its own subset. Fine at personal scale.
  const logs = useLiveQuery(async () => {
    const all = await db.reviewLogs.toArray();
    return all.filter((l) => l.kind === 'review');
  }, []);

  if (!logs) return <p className="py-16 text-center text-slate-500">Crunching stats…</p>;

  const windowStart = startOfLocalDay(t) - WEEKS * 7 * DAY - DAY; // slack for DST
  const windowed = logs.filter((l) => l.ts >= windowStart);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-slate-100">Stats</h1>
      {logs.length === 0 ? (
        <p className="text-sm text-slate-500">No reviews yet — stats appear after your first session.</p>
      ) : (
        <>
          <RetentionPanel logs={logs} t={t} />
          <Heatmap logs={windowed} t={t} />
        </>
      )}
      <CourseStats />
    </div>
  );
}
