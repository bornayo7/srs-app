import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { newId } from '@/engine/ids';
import { Button, ButtonLink, Panel, Status, TextInput } from '@/components/ui';
import { useOperation } from '@/hooks/useOperation';
import {
  useAllScheduledCards,
  useCourses,
  useDueCount,
  useLessonAvailability,
  usePendingReviewCount,
} from '@/hooks/useCourseData';
import { useNowTick } from '@/hooks/useNowTick';
import { buildForecast } from '@/engine/forecast';
import { LADDER_PRESETS } from '@/engine/scheduler/presets';
import { now } from '@/services/clock';
import { createCourseWithType } from '@/services/contentCommands';
import { installSeed, isSeedInstalled } from '@/db/seed';
import { gentleSeed } from '@/db/seed/gentle';
import { techSeed } from '@/db/seed/tech';
import { clozeSeed } from '@/db/seed/cloze';
import { japaneseSeed } from '@/db/seed/japanese';
import { GenerateCoursePanel } from '@/components/ai/GenerateCoursePanel';
import { PlanCoursePanel } from '@/components/ai/PlanCoursePanel';
import type { Course } from '@/engine/types';

function CourseRow({ course, t }: { course: Course; t: number }) {
  const due = useDueCount(course.id, t);
  const lessons = useLessonAvailability(course.id, t);
  const pendingReview = usePendingReviewCount(course.id);
  return (
    <div className="flex flex-col justify-between gap-3 border-b border-slate-800 px-1 py-5 sm:flex-row sm:items-center">
      <div className="min-w-0">
        <Link
          to={`/course/${course.id}`}
          className="flex items-center gap-2 truncate font-semibold text-slate-100 hover:text-violet-300"
        >
          {course.name}
          {course.levelMode === 'levels' && (
            <span className="shrink-0 rounded bg-violet-950/60 px-1.5 py-0.5 text-[10px] font-medium text-violet-300">
              Lv {course.currentLevel}
            </span>
          )}
        </Link>
        {(pendingReview ?? 0) > 0 && (
          <Link
            to={`/plan/${course.id}`}
            className="mt-0.5 inline-block rounded bg-sky-950/60 px-1.5 py-0.5 text-[10px] font-medium text-sky-300 hover:bg-sky-900/60"
          >
            {pendingReview} AI proposal{pendingReview === 1 ? '' : 's'} to review →
          </Link>
        )}
        <p className="truncate text-xs text-slate-500">{course.description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {lessons?.available ? (
          <ButtonLink to={`/lessons/${course.id}`}>Lessons · {lessons.available}</ButtonLink>
        ) : null}
        {due ? (
          <ButtonLink to={`/review/${course.id}`} variant="primary">
            Reviews · {due}
          </ButtonLink>
        ) : (
          <span className="text-sm text-slate-500">
            {due === undefined ? 'Checking…' : 'Reviews complete for now'}
          </span>
        )}
      </div>
    </div>
  );
}

function ForecastStrip({ t }: { t: number }) {
  const cards = useAllScheduledCards();
  if (!cards) return null;
  const f = buildForecast(cards, t, 7);
  const max = Math.max(1, f.dueNow, ...f.days.map((d) => d.count));
  const dayName = (ts: number, i: number) =>
    i === 0 ? 'Today' : new Date(ts).toLocaleDateString(undefined, { weekday: 'short' });
  return (
    <Panel title="Review forecast — next 7 days">
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col items-center gap-1">
          <span className="text-xs font-semibold text-violet-300">{f.dueNow}</span>
          <div
            className="w-full rounded-t bg-violet-500"
            style={{ height: `${8 + (f.dueNow / max) * 72}px` }}
          />
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Now</span>
        </div>
        {f.days.map((d, i) => (
          <div key={d.dayStart} className="flex flex-1 flex-col items-center gap-1">
            <span className="text-xs text-slate-400">{d.count}</span>
            <div
              className="w-full rounded-t bg-slate-700"
              style={{ height: `${8 + (d.count / max) * 72}px` }}
            />
            <span className="text-[10px] uppercase tracking-wide text-slate-500">
              {dayName(d.dayStart, i)}
            </span>
          </div>
        ))}
      </div>
      {f.beyond > 0 && (
        <p className="mt-2 text-right text-xs text-slate-500">+{f.beyond} further out</p>
      )}
    </Panel>
  );
}

function NewCourseForm({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [presetId, setPresetId] = useState('preset-classic');
  const operation = useOperation();
  const presets = LADDER_PRESETS.filter((p) => p.id !== 'preset-ghost');
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        void operation.run(async () => {
          const course = await createCourseWithType(
            { name: name.trim(), ladderPresetId: presetId },
            now(),
          );
          onDone();
          navigate(`/course/${course.id}?view=items`);
        });
      }}
    >
      <TextInput
        aria-label="Course name"
        disabled={operation.busy}
        autoFocus
        placeholder="Course name (e.g. Spanish Vocab)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="max-w-64"
      />
      <select
        aria-label="Review schedule"
        value={presetId}
        onChange={(e) => setPresetId(e.target.value)}
        className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
      >
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <Button type="submit" variant="primary" disabled={operation.busy || !name.trim()}>
        Create
      </Button>
      <Status {...operation} />
      <Button type="button" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}

function QuickCapture() {
  const [text, setText] = useState('');
  const operation = useOperation();
  const pending = useLiveQuery(() => db.captures.count(), []);
  const add = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    await operation.run(async () => {
      await db.captures.add({ id: newId(), text: trimmed, createdAt: now() });
      setText('');
    }, 'Note captured.');
  };
  return (
    <Panel title="Quick capture">
      <div className="flex flex-wrap items-center gap-2">
        <TextInput
          aria-label="Note to remember"
          disabled={operation.busy}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void add();
            }
          }}
          placeholder="A new word, a formula, a question from class…"
        />
        <Button
          variant="primary"
          disabled={!text.trim() || operation.busy}
          onClick={() => void add()}
        >
          Capture
        </Button>
        {(pending ?? 0) > 0 && (
          <Link to="/inbox" className="shrink-0 text-xs text-violet-300 hover:underline">
            {pending} to sort →
          </Link>
        )}
      </div>
      <Status {...operation} />
    </Panel>
  );
}

function SeedOffers() {
  const t = useNowTick(60_000);
  const [installError, setInstallError] = useState('');
  const missing = useLiveQuery(async () => {
    const seeds = [gentleSeed, techSeed, clozeSeed, japaneseSeed];
    const flags = await Promise.all(seeds.map(isSeedInstalled));
    return seeds.filter((_, i) => !flags[i]);
  }, []);
  if (!missing || missing.length === 0) return null;
  return (
    <Panel title="Sample courses">
      <div className="flex flex-wrap gap-2">
        {missing.map((s) => (
          <Button
            key={s.key}
            onClick={async () => {
              setInstallError('');
              try {
                await installSeed(s, t);
              } catch (err) {
                setInstallError(`Could not install "${s.name}": ${(err as Error).message}`);
              }
            }}
          >
            + {s.name}
          </Button>
        ))}
      </div>
      {installError && <p className="mt-2 text-sm text-rose-300">{installError}</p>}
      <p className="mt-2 text-xs text-slate-500">
        Ready-made courses covering every feature — typed recall, sentence cloze, and the
        WaniKani-style radical→kanji→vocab unlock chain. Safe to delete later.
      </p>
    </Panel>
  );
}

export default function Dashboard() {
  const t = useNowTick();
  const courses = useCourses();
  const [createMode, setCreateMode] = useState<'manual' | 'ai' | 'material' | null>(null);
  const creating = createMode === 'manual';
  const aiCreating = createMode === 'ai';
  const planning = createMode === 'material';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-slate-100">Today</h1>
          <p className="mt-1 text-sm text-slate-400">Make room for what you want to remember.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!planning && (
            <Button
              onClick={() => setCreateMode('material')}
              title="Paste a syllabus or notes — units drip in as you progress"
            >
              From my material
            </Button>
          )}
          {!aiCreating && <Button onClick={() => setCreateMode('ai')}>AI course</Button>}
          {!creating && (
            <Button variant="primary" onClick={() => setCreateMode('manual')}>
              + New course
            </Button>
          )}
        </div>
      </div>
      {creating && (
        <Panel>
          <NewCourseForm onDone={() => setCreateMode(null)} />
        </Panel>
      )}
      {planning && <PlanCoursePanel onDone={() => setCreateMode(null)} />}
      {aiCreating && <GenerateCoursePanel onDone={() => setCreateMode(null)} />}

      {courses && courses.length === 0 && (
        <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/40 p-8 text-center">
          <div className="text-4xl">🌀</div>
          <h2 className="mt-2 text-lg font-semibold text-slate-200">Nothing here yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-400">
            Create a course, or install a sample course below to feel the WaniKani-style loop:
            lessons teach items, then reviews climb the SRS ladder.
          </p>
        </div>
      )}

      <div className="space-y-2" aria-label="Your courses">
        {courses?.map((c) => (
          <CourseRow key={c.id} course={c} t={t} />
        ))}
      </div>

      {courses && courses.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          Review availability updates automatically. Your next wave appears below.
        </div>
      )}

      <QuickCapture />
      <ForecastStrip t={t} />
      <SeedOffers />
    </div>
  );
}
