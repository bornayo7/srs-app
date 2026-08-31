import type { SessionEntry, Feedback } from '@/stores/sessionStore';
import type { FieldValue } from '@/engine/types';

function fieldText(v: FieldValue | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return (v as string[]).join(', ');
  return '';
}

/** The big prompt card: type color band, template name, prompt fields. */
export function CardPrompt({ entry, feedback }: { entry: SessionEntry; feedback: Feedback | null }) {
  const { item, itemType, template } = entry;
  const prompts = template.promptFieldIds
    .map((id) => ({
      name: itemType.fields.find((f) => f.id === id)?.name ?? '',
      value: fieldText(item.fieldValues[id]),
    }))
    .filter((p) => p.value);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-xl">
      <div
        className="flex items-center justify-between px-4 py-2 text-sm font-semibold text-white/95"
        style={{ backgroundColor: itemType.color }}
      >
        <span>
          {itemType.icon} {itemType.name}
        </span>
        <span className="rounded bg-black/25 px-2 py-0.5 text-xs uppercase tracking-widest">
          {template.name}
        </span>
      </div>
      <div className="flex min-h-44 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        {prompts.map((p) => (
          <div key={p.name}>
            <div className="text-3xl font-semibold leading-snug text-slate-50">{p.value}</div>
          </div>
        ))}
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
