import { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useSession } from '@/stores/sessionStore';
import { CardPrompt } from '@/components/review/CardPrompt';
import { TypedInput } from '@/components/review/TypedInput';
import { SessionSummary } from '@/components/review/SessionSummary';
import { Button } from '@/components/ui';
import { useCourse, useCourseLadder } from '@/hooks/useCourseData';
import { maybeRefreshSnapshot } from '@/exchange/exchange';
import { now } from '@/services/clock';

export default function ReviewPage() {
  const { courseId } = useParams<{ courseId: string }>();
  const navigate = useNavigate();
  const s = useSession();
  const course = useCourse(courseId);
  const ladder = useCourseLadder(course);

  useEffect(() => {
    if (courseId) void useSession.getState().start(courseId);
    return () => useSession.getState().reset();
  }, [courseId]);

  // keep the MCP snapshot fresh after a session's worth of state changes
  useEffect(() => {
    if (s.phase === 'summary') void maybeRefreshSnapshot(now());
  }, [s.phase]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void useSession.getState().undo();
      } else if (e.key === 'Escape') {
        useSession.getState().enterWrapUp();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (s.phase === 'idle' || s.phase === 'loading') {
    return <p className="py-16 text-center text-slate-500">Loading session…</p>;
  }

  if (s.phase === 'empty') {
    return (
      <div className="py-16 text-center">
        <div className="text-4xl">🎉</div>
        <p className="mt-2 text-slate-300">No reviews due right now.</p>
        <Link to="/" className="mt-4 inline-block">
          <Button>Back to dashboard</Button>
        </Link>
      </div>
    );
  }

  if (s.phase === 'summary') {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <h1 className="text-xl font-bold text-slate-100">Session complete</h1>
        <SessionSummary completed={s.completed} ladder={ladder ?? null} />
        <div className="flex justify-center gap-2">
          <Button variant="primary" onClick={() => navigate('/')}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  const entry = s.queue[0];
  if (!entry) return null;
  const done = s.completed.length;
  const progress = s.totalCards === 0 ? 0 : (done / s.totalCards) * 100;

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-3 flex items-center justify-between text-xs text-slate-500">
        <span>
          {done}/{s.totalCards} done{s.wrapUp && ' · wrap-up'}
        </span>
        <span className="flex gap-3">
          <button className="hover:text-slate-300" onClick={() => void s.undo()}>
            undo (ctrl+z)
          </button>
          <button className="hover:text-slate-300" onClick={s.enterWrapUp}>
            wrap up (esc)
          </button>
        </span>
      </div>
      <div className="mb-4 h-1.5 overflow-hidden rounded bg-slate-800">
        <div className="h-full bg-violet-500 transition-all" style={{ width: `${progress}%` }} />
      </div>

      <CardPrompt entry={entry} feedback={s.feedback} />
      <div className="mt-5">
        {/* key remounts (and clears) the input whenever the front card changes,
            including undo-after-advance restoring a different card */}
        <TypedInput
          key={entry.card.id}
          feedback={s.feedback}
          onSubmit={(text) => void s.submit(text)}
          onContinue={s.continueNext}
        />
      </div>
    </div>
  );
}
