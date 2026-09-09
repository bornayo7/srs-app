import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useSession } from '@/stores/sessionStore';
import { CardPrompt } from '@/components/review/CardPrompt';
import { AnswerInput } from '@/components/review/AnswerInput';
import { SessionSummary } from '@/components/review/SessionSummary';
import { Button, ButtonLink } from '@/components/ui';
import { useCourse, useCourseLadder } from '@/hooks/useCourseData';
import { maybeRefreshSnapshot } from '@/exchange/exchange';
import { now } from '@/services/clock';
import { QuestionProblems } from '@/components/review/QuestionProblems';

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
        if (e.target instanceof HTMLInputElement && !e.target.readOnly) return;
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
  if (s.phase === 'error')
    return (
      <div role="alert" className="mx-auto max-w-xl py-12 text-center">
        <p>{s.notice}</p>
        <Button className="mt-4" onClick={() => courseId && void s.start(courseId)}>
          Reload session
        </Button>
      </div>
    );

  if (s.phase === 'empty') {
    return (
      <div className="py-16 text-center">
        <div className="text-4xl">🎉</div>
        <p className="mt-2 text-slate-300">
          {s.problems.length
            ? 'No available questions in this session.'
            : 'No reviews due right now.'}
        </p>
        <QuestionProblems problems={s.problems} courseId={courseId!} />
        <ButtonLink to="/" className="mt-4">
          Back to dashboard
        </ButtonLink>
      </div>
    );
  }

  if (s.phase === 'summary') {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <h1 className="text-xl font-bold text-slate-100">Session complete</h1>
        <SessionSummary completed={s.completed} ladder={ladder ?? null} />
        <QuestionProblems problems={s.problems} courseId={courseId!} />
        {s.notice && <p role="status">{s.notice}</p>}
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
      {s.notice && (
        <p role="status" className="mb-3 text-sm text-amber-300">
          {s.notice}
        </p>
      )}
      <QuestionProblems problems={s.problems} courseId={courseId!} />
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

      <CardPrompt key={entry.card.id} entry={entry} feedback={s.feedback} />
      <div className="mt-5">
        {/* key remounts (and clears) the input whenever the front card changes,
            including undo-after-advance restoring a different card */}
        <AnswerInput
          key={entry.card.id}
          entry={entry}
          feedback={s.feedback}
          onSubmit={(text) => void s.submit(text)}
          onContinue={s.continueNext}
          busy={s.busy}
        />
      </div>
    </div>
  );
}
