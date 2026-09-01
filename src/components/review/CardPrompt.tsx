import { useEffect, useState } from 'react';
import type { SessionEntry, Feedback } from '@/stores/sessionStore';
import type { FieldValue } from '@/engine/types';
import { speak, stopSpeaking, ttsSupported } from '@/services/tts';
import { MediaAudio, MediaImage } from '@/components/MediaImage';
import { RichText } from '@/components/RichText';
import { richTextToPlain } from '@/engine/richtext';

function fieldText(v: FieldValue | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return (v as string[]).join(', ');
  return '';
}

/** The big prompt card: type color band, template name, prompt fields or cloze. */
export function CardPrompt({ entry, feedback }: { entry: SessionEntry; feedback: Feedback | null }) {
  const { item, itemType, template } = entry;
  const [showTranslation, setShowTranslation] = useState(false);
  const [hintsShown, setHintsShown] = useState(0);
  // stop any in-flight speech when the card unmounts (next card / navigation)
  useEffect(() => stopSpeaking, []);

  const prompts = template.promptFieldIds
    .map((id) => {
      const field = itemType.fields.find((f) => f.id === id);
      return {
        id,
        name: field?.name ?? '',
        kind: field?.kind ?? 'text',
        value: fieldText(item.fieldValues[id]),
      };
    })
    .filter((p) => p.value);

  const hints = template.hintFieldIds
    .map((id) => {
      const field = itemType.fields.find((f) => f.id === id);
      return { id, name: field?.name ?? '', value: fieldText(item.fieldValues[id]) };
    })
    .filter((h) => h.value);

  // Alt+H, because the answer box has focus and a bare "h" would be typed
  useEffect(() => {
    if (hints.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        setHintsShown((n) => Math.min(n + 1, hints.length));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hints.length]);

  const graded = feedback?.kind === 'correct' || feedback?.kind === 'incorrect';
  // what the 🔊 button reads: the full sentence once graded, gap before; else the prompt
  const speakText = entry.cloze
    ? graded
      ? entry.cloze.masked.replace(/＿+/g, entry.cloze.blank)
      : entry.cloze.masked
    : richTextToPlain(
        prompts
          .filter((p) => p.kind !== 'image' && p.kind !== 'audio')
          .map((p) => p.value)
          .join('. '),
      );

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-xl">
      <div
        className="flex items-center justify-between px-4 py-2 text-sm font-semibold text-white/95"
        style={{ backgroundColor: itemType.color }}
      >
        <span>
          {itemType.icon} {itemType.name}
        </span>
        <span className="flex items-center gap-1.5">
          {ttsSupported() && (
            <button
              className="rounded bg-black/25 px-1.5 py-0.5 text-xs hover:bg-black/40"
              title="Read aloud"
              onClick={() => speak(speakText)}
            >
              🔊
            </button>
          )}
          {entry.card.isGhost && (
            <span
              className="rounded bg-black/40 px-2 py-0.5 text-xs"
              title="Ghost drill — extra practice for a card you missed; doesn't affect its real schedule"
            >
              👻 ghost
            </span>
          )}
          <span className="rounded bg-black/25 px-2 py-0.5 text-xs uppercase tracking-widest">
            {template.name}
          </span>
        </span>
      </div>
      <div className="flex min-h-44 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        {entry.cloze ? (
          <>
            <div className="text-2xl font-semibold leading-relaxed text-slate-50">
              {entry.cloze.masked}
            </div>
            {prompts.map((p) => (
              <div key={p.name} className="text-sm text-slate-400">
                {p.value}
              </div>
            ))}
            {entry.cloze.translation && (
              <div className="mt-1">
                {showTranslation || graded ? (
                  <p className="text-sm italic text-slate-400">{entry.cloze.translation}</p>
                ) : (
                  <button
                    className="text-xs text-slate-500 underline decoration-dotted hover:text-slate-300"
                    onClick={() => setShowTranslation(true)}
                  >
                    show translation
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          prompts.map((p) =>
            p.kind === 'image' ? (
              <MediaImage key={p.id} id={p.value} alt={p.name} className="max-h-56" />
            ) : p.kind === 'audio' ? (
              <MediaAudio key={p.id} id={p.value} />
            ) : (
              <div key={p.id}>
                <div className="text-3xl font-semibold leading-snug text-slate-50">{p.value}</div>
              </div>
            ),
          )
        )}
        {hints.length > 0 && !graded && (
          <div className="mt-1 space-y-1">
            {hints.slice(0, hintsShown).map((h) => (
              <p key={h.id} className="text-sm text-slate-400">
                <span className="mr-1 text-[10px] uppercase tracking-widest text-slate-600">
                  {h.name}
                </span>
                {h.value}
              </p>
            ))}
            {hintsShown < hints.length && (
              <button
                className="text-xs text-slate-500 underline decoration-dotted hover:text-slate-300"
                onClick={() => setHintsShown(hintsShown + 1)}
              >
                {hintsShown === 0 ? 'show a hint' : 'another hint'} (Alt+H)
              </button>
            )}
          </div>
        )}
      </div>
      {feedback?.kind === 'incorrect' && (
        <div className="border-t border-rose-900/60 bg-rose-950/30 px-6 py-3 text-center">
          <span className="text-sm text-rose-200">
            Answer: <span className="font-semibold">{feedback.accepted[0]}</span>
            {feedback.accepted.length > 1 && (
              <span className="text-rose-300/70"> (+{feedback.accepted.length - 1} accepted)</span>
            )}
          </span>
          {item.note && (
            <p className="mt-1 text-xs text-rose-200/70">
              <RichText src={item.note} />
            </p>
          )}
        </div>
      )}
      {feedback?.kind === 'correct' && feedback.typo && (
        <div className="border-t border-amber-900/60 bg-amber-950/30 px-6 py-2 text-center text-xs text-amber-200">
          Accepted with a typo — watch the spelling.
        </div>
      )}
    </div>
  );
}
