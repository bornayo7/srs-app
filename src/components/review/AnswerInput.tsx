import { ChoiceInput } from './ChoiceInput';
import { TypedInput } from './TypedInput';
import type { Feedback } from '@/engine/question';
import { entryAnswerLang, type SessionEntry } from '@/engine/question';
import { MIN_CHOICE_OPTIONS } from '@/engine/grading/choice';

/**
 * Picks the input for a card: multiple choice when the template asks for it and
 * enough distractors were found, otherwise the typed answer box. Both feed the
 * same onSubmit(text), so the grading and commit path is shared.
 */
export function AnswerInput({
  entry,
  feedback,
  onSubmit,
  onContinue,
  onOverride,
  busy = false,
}: {
  entry: SessionEntry;
  feedback: Feedback | null;
  onSubmit: (text: string) => void;
  onContinue: () => void;
  onOverride?: (correct: boolean) => void;
  busy?: boolean;
}) {
  const graded = feedback?.kind === 'correct' || feedback?.kind === 'incorrect';
  const input =
    entry.choices && entry.choices.length >= MIN_CHOICE_OPTIONS ? (
      <ChoiceInput
        options={entry.choices}
        feedback={feedback}
        onSubmit={onSubmit}
        onContinue={onContinue}
        busy={busy}
      />
    ) : (
      <TypedInput
        feedback={feedback}
        answerLang={entryAnswerLang(entry)}
        onSubmit={onSubmit}
        onContinue={onContinue}
        busy={busy}
        placeholder={
          entry.template.grading.mode === 'choice'
            ? 'Type the answer (not enough items yet for choices)'
            : undefined
        }
      />
    );
  return (
    <div
      onKeyDown={(e) => {
        // Held activation keys must not repeatedly override a grade or Continue.
        if (
          e.repeat &&
          (e.key === 'Enter' || e.key === ' ') &&
          e.target instanceof Element &&
          e.target.closest('button')
        )
          e.preventDefault();
      }}
    >
      {graded && onOverride && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-slate-700 px-4 py-3">
          <p
            role="status"
            className={`text-sm font-semibold ${feedback.kind === 'correct' ? 'text-emerald-300' : 'text-rose-300'}`}
          >
            {feedback.kind === 'correct' ? 'Marked correct' : 'Marked wrong'}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => onOverride(feedback.kind !== 'correct')}
            className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:border-violet-400 disabled:opacity-50"
          >
            {feedback.kind === 'correct' ? 'Mark wrong' : 'Mark correct'}
          </button>
        </div>
      )}
      {input}
    </div>
  );
}
