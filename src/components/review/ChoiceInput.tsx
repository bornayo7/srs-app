import { useEffect, useState } from 'react';
import type { ChoiceOption } from '@/engine/grading/choice';
import type { Feedback } from '@/stores/sessionStore';

/**
 * Multiple choice. Clicking (or pressing 1–6) submits the option's text through
 * the same grading pipeline a typed answer takes, so the SRS outcome, ghost
 * spawning and gating cascade are identical — only the input method differs.
 */
export function ChoiceInput({
  options,
  feedback,
  onSubmit,
  onContinue,
}: {
  options: ChoiceOption[];
  feedback: Feedback | null;
  onSubmit: (text: string) => void;
  onContinue: () => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const graded = feedback?.kind === 'correct' || feedback?.kind === 'incorrect';

  // A missed card comes back later as the same entry (same options); clear the
  // selection when the card is re-asked so it isn't pre-answered.
  useEffect(() => {
    if (feedback === null) setPicked(null);
  }, [feedback]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (graded) onContinue();
        return;
      }
      const n = Number(e.key);
      if (!graded && Number.isInteger(n) && n >= 1 && n <= options.length) {
        e.preventDefault();
        setPicked(n - 1);
        onSubmit(options[n - 1].text);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [graded, options, onSubmit, onContinue]);

  const tone = (index: number, option: ChoiceOption): string => {
    if (!graded) {
      return 'border-slate-700 bg-slate-900 hover:border-violet-500 hover:bg-slate-800';
    }
    if (option.correct) return 'border-emerald-500 bg-emerald-900/40 text-emerald-100';
    if (index === picked) return 'border-rose-500 bg-rose-900/40 text-rose-100';
    return 'border-slate-800 bg-slate-900/60 text-slate-600';
  };

  // never rely on colour alone to say which one was right
  const mark = (index: number, option: ChoiceOption): string =>
    !graded ? `${index + 1}` : option.correct ? '✓' : index === picked ? '✗' : `${index + 1}`;

  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option, i) => (
          <button
            key={`${i}:${option.text}`}
            type="button"
            disabled={graded}
            onClick={() => {
              setPicked(i);
              onSubmit(option.text);
            }}
            className={`flex items-center gap-3 rounded-xl border-2 px-4 py-3 text-left text-lg transition-colors disabled:cursor-default ${tone(i, option)}`}
          >
            <span className="w-6 shrink-0 rounded bg-black/30 py-0.5 text-center text-xs text-slate-300">
              {mark(i, option)}
            </span>
            <span className="min-w-0 break-words">{option.text}</span>
          </button>
        ))}
      </div>
      {graded && (
        <button
          type="button"
          onClick={onContinue}
          className="mt-3 w-full rounded-xl border-2 border-slate-700 bg-slate-900 py-2 text-sm text-slate-300 hover:border-violet-500"
        >
          Continue (Enter)
        </button>
      )}
      <p className="mt-2 text-center text-xs text-slate-500">
        {graded ? 'Enter → next' : 'Click an answer, or press its number'}
      </p>
    </div>
  );
}
