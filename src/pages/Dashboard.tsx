import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { newId } from '@/engine/ids';
import { Badge, Button, Panel, TextInput } from '@/components/ui';
import {
  useAllScheduledCards,
  useCourses,
  useDueCount,
  useLessonAvailability,
} from '@/hooks/useCourseData';
import { useNowTick } from '@/hooks/useNowTick';
import { buildForecast } from '@/engine/forecast';
import { LADDER_PRESETS } from '@/engine/scheduler/presets';
import { now } from '@/services/clock';
import { createCourse } from '@/db/repo/courses';
import { basicTypeSpec, createItemType } from '@/db/repo/itemTypes';
import { installSeed, isSeedInstalled } from '@/db/seed';
import { gentleSeed } from '@/db/seed/gentle';
import { techSeed } from '@/db/seed/tech';
import { clozeSeed } from '@/db/seed/cloze';
import { GenerateCoursePanel } from '@/components/ai/GenerateCoursePanel';
import type { Course } from '@/engine/types';

function CourseRow({ course, t }: { course: Course; t: number }) {
  const due = useDueCount(course.id, t);
  const lessons = useLessonAvailability(course.id, t);
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-3">
      <div className="min-w-0">
        <Link
          to={`/course/${course.id}`}
          className="block truncate font-semibold text-slate-100 hover:text-violet-300"
        >
          {course.name}
        </Link>
        <p className="truncate text-xs text-slate-500">{course.description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Link to={`/lessons/${course.id}`}>
          <Button variant="secondary" disabled={!lessons || lessons.available === 0}>
            Lessons{lessons && lessons.available > 0 ? ` · ${lessons.available}` : ''}
          </Button>
        </Link>
        <Link to={`/review/${course.id}`}>
          <Button variant="primary" disabled={!due}>
            Reviews{due ? ` · ${due}` : ''}
          </Button>
        </Link>
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
  const presets = LADDER_PRESETS.filter((p) => p.id !== 'preset-ghost');
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        const t = now();
        const course = await createCourse({ name: name.trim(), ladderPresetId: presetId }, t);
        await createItemType(course.id, basicTypeSpec(), t);
        onDone();
        navigate(`/course/${course.id}`);
      }}
    >
      <TextInput
        autoFocus
        placeholder="Course name (e.g. Spanish Vocab)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="max-w-64"
      />
      <select
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
      <Button type="submit" variant="primary">
        Create
      </Button>
      <Button type="button" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}

function QuickCapture() {
  const [text, setText] = useState('');
  const pending = useLiveQuery(() => db.captures.count(), []);
  const add = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    await db.captures.add({ id: newId(), text: trimmed, createdAt: now() });
    setText('');
  };
  return (
    <Panel title="Quick capture">
      <div className="flex items-center gap-2">
        <TextInput
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            }
          }}
          placeholder="Jot something to remember — Dr. Chen = the cardiologist from the party"
        />
        <Button variant="primary" disabled={!text.trim()} onClick={() => void add()}>
          Capture
        </Button>
        {(pending ?? 0) > 0 && (
          <Link to="/inbox" className="shrink-0 text-xs text-violet-300 hover:underline">
            {pending} to sort →
          </Link>
        )}
      </div>
    </Panel>
  );
}

function SeedOffers() {
  const t = useNowTick(60_000);
  const missing = useLiveQuery(async () => {
    const seeds = [gentleSeed, techSeed, clozeSeed];
    const flags = await Promise.all(seeds.map(isSeedInstalled));
    return seeds.filter((_, i) => !flags[i]);
  }, []);
  if (!missing || missing.length === 0) return null;
  return (
    <Panel title="Sample courses">
      <div className="flex flex-wrap gap-2">
        {missing.map((s) => (
          <Button key={s.key} onClick={() => installSeed(s, t)}>
            + {s.name}
          </Button>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Two ready-made courses to try the review loop — safe to delete later.
      </p>
    </Panel>
  );
}

export default function Dashboard() {
  const t = useNowTick();
  const courses = useCourses();
  const [creating, setCreating] = useState(false);
  const [aiCreating, setAiCreating] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-100">Dashboard</h1>
        <div className="flex gap-2">
          {!aiCreating && (
            <Button onClick={() => setAiCreating(true)}>✨ AI course</Button>
          )}
          {!creating && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              + New course
            </Button>
          )}
        </div>
      </div>
      {creating && (
        <Panel>
          <NewCourseForm onDone={() => setCreating(false)} />
        </Panel>
      )}
      {aiCreating && <GenerateCoursePanel onDone={() => setAiCreating(false)} />}

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

      <div className="space-y-2">
        {courses?.map((c) => <CourseRow key={c.id} course={c} t={t} />)}
      </div>

      {courses && courses.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Badge color="violet">tip</Badge>
          Reviews unlock on the hour — check the forecast for the next wave.
        </div>
      )}

      <QuickCapture />
      <ForecastStrip t={t} />
      <SeedOffers />
    </div>
  );
}
