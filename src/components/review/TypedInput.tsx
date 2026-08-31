import { useEffect, useRef, useState } from 'react';
import { toKana } from 'wanakana';
import type { Feedback } from '@/stores/sessionStore';

/**
 * The answer box. One Enter submits; when feedback is showing, the next Enter
 * continues. Retry verdicts shake without grading.
 *
 * `answerLang: 'kana'` turns it into a kana IME: romaji converts as you type
 * (ka → か), trailing consonants are held (kk → っk), and a final pass on
 * submit closes leftovers like a trailing "n" → ん.
 */
export function TypedInput({
  feedback,
  onSubmit,
  onContinue,
  answerLang = 'latin',
  placeholder,
}: {
  feedback: Feedback | null;
  onSubmit: (text: string) => void;
  onContinue: () => void;
  answerLang?: 'latin' | 'kana';
  placeholder?: string;
}) {
  const kana = answerLang === 'kana';
  const [text, setText] = useState('');
  const submit = () => onSubmit(kana ? toKana(text) : text);
  const [shakeNonce, setShakeNonce] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const graded = feedback?.kind === 'correct' || feedback?.kind === 'incorrect';

  useEffect(() => {
    ref.current?.focus();
  }, [feedback]);

  useEffect(() => {
    if (feedback?.kind === 'retry') setShakeNonce(feedback.nonce);
  }, [feedback]);

  // Clear the box when moving to a fresh card (feedback returns to null after grading).
  const prevGraded = useRef(false);
  useEffect(() => {
    if (prevGraded.current && feedback === null) setText('');
    prevGraded.current = graded;
  }, [feedback, graded]);

  const tone =
    feedback?.kind === 'correct'
      ? feedback.typo
        ? 'border-amber-500 bg-amber-950/40 text-amber-100'
        : 'border-emerald-500 bg-emerald-950/40 text-emerald-100'
      : feedback?.kind === 'incorrect'
        ? 'border-rose-500 bg-rose-950/40 text-rose-100'
        : 'border-slate-700 bg-slate-900 focus-within:border-violet-500';

  return (
    <form
      className="w-full"
      onSubmit={(e) => {
        e.preventDefault();
        if (graded) onContinue();
        else submit();
      }}
    >
      <div
        key={shakeNonce}
        className={`${shakeNonce ? 'animate-shake' : ''} rounded-xl border-2 transition-colors ${tone}`}
      >
        <input
          ref={ref}
          value={text}
          onChange={(e) => {
            const raw = e.target.value;
            // Only run the IME while typing at the END of the box. Converting a
            // mid-string edit would rewrite text behind the caret and bounce the
            // caret to the end, so corrections would land in the wrong place.
            const atEnd = e.target.selectionStart === raw.length;
            setText(kana && atEnd ? toKana(raw, { IMEMode: true }) : raw);
          }}
          onKeyDown={(e) => {
            // Explicit Enter handling — implicit form submission is unreliable
            // (no submit button, synthetic events, some mobile keyboards).
            // e.repeat ignored: a held Enter must not submit-and-continue.
            if (e.key === 'Enter' && !e.repeat) {
              e.preventDefault();
              if (graded) onContinue();
              else submit();
            }
          }}
          readOnly={graded}
          lang={kana ? 'ja' : undefined}
          placeholder={placeholder ?? (kana ? 'かな (type romaji)' : 'Your answer')}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          className="w-full bg-transparent px-4 py-3 text-center text-xl outline-none placeholder-slate-600"
        />
      </div>
      {feedback?.kind === 'retry' && (
        <p className="mt-2 text-center text-sm text-amber-300">
          {feedback.message ??
            (feedback.reason === 'wrongFacet'
              ? "That's the answer to this item's other question."
              : feedback.reason === 'alphabet'
                ? 'Check your input language.'
                : 'Type an answer first.')}
        </p>
      )}
      <p className="mt-2 text-center text-xs text-slate-500">
        {graded ? 'Enter → next' : 'Enter → submit'}
      </p>
    </form>
  );
}
