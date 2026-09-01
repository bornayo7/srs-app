import { ChoiceInput } from './ChoiceInput';
import { TypedInput } from './TypedInput';
import { entryAnswerLang, type Feedback, type SessionEntry } from '@/stores/sessionStore';
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
}: {
  entry: SessionEntry;
  feedback: Feedback | null;
  onSubmit: (text: string) => void;
  onContinue: () => void;
}) {
  if (entry.choices && entry.choices.length >= MIN_CHOICE_OPTIONS) {
    return (
      <ChoiceInput
        options={entry.choices}
        feedback={feedback}
        onSubmit={onSubmit}
        onContinue={onContinue}
      />
    );
  }
  return (
    <TypedInput
      feedback={feedback}
      answerLang={entryAnswerLang(entry)}
      onSubmit={onSubmit}
      onContinue={onContinue}
      placeholder={
        entry.template.grading.mode === 'choice'
          ? 'Type the answer (not enough items yet for choices)'
          : undefined
      }
    />
  );
}
