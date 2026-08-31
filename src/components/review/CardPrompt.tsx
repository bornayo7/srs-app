import { useEffect, useState } from 'react';
import type { SessionEntry, Feedback } from '@/stores/sessionStore';
import type { FieldValue } from '@/engine/types';
import { speak, stopSpeaking, ttsSupported } from '@/services/tts';

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
  // stop any in-flight speech when the card unmounts (next card / navigation)
  useEffect(() => stopSpeaking, []);
  const prompts = template.promptFieldIds
    .map((id) => ({
      name: itemType.fields.find((f) => f.id === id)?.name ?? '',
      value: fieldText(item.fieldValues[id]),
    }))
    .filter((p) => p.value);
  const graded = feedback?.kind === 'correct' || feedback?.kind === 'incorrect';
  // what the 🔊 button reads: the full sentence once graded, gap before; else the prompt
  const speakText = entry.cloze
    ? graded
      ? entry.cloze.masked.replace(/＿+/g, entry.cloze.blank)
      : entry.cloze.masked
    : prompts.map((p) => p.value).join('. ');

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
          prompts.map((p) => (
            <div key={p.name}>
              <div className="text-3xl font-semibold leading-snug text-slate-50">{p.value}</div>
            </div>
          ))
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
          {item.note && <p className="mt-1 text-xs text-rose-200/70">{item.note}</p>}
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
