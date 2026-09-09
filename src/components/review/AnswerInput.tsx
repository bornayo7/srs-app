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
  busy = false,
}: {
  entry: SessionEntry;
  feedback: Feedback | null;
  onSubmit: (text: string) => void;
  onContinue: () => void;
  busy?: boolean;
}) {
  if (entry.choices && entry.choices.length >= MIN_CHOICE_OPTIONS) {
    return (
      <ChoiceInput
        options={entry.choices}
        feedback={feedback}
        onSubmit={onSubmit}
        onContinue={onContinue}
        busy={busy}
      />
    );
  }
  return (
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
}
