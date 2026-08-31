import type { CompletedReview } from '@/stores/sessionStore';
import type { SrsLadder } from '@/engine/types';
import { itemPreview } from '@/engine/grading/context';
import { Badge } from '@/components/ui';

function stageLabel(ladder: SrsLadder | null, idx: number | null): string {
  if (ladder === null || idx === null) return '';
  if (idx >= ladder.stages.length) return 'Burned';
  return ladder.stages[idx].name;
}

export function SessionSummary({
  completed,
  ladder,
}: {
  completed: CompletedReview[];
  ladder: SrsLadder | null;
}) {
  const correct = completed.filter((c) => c.incorrectCount === 0);
  const missed = completed.filter((c) => c.incorrectCount > 0);
  const pct = completed.length === 0 ? 100 : Math.round((correct.length / completed.length) * 100);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-center">
        <div className="text-5xl font-bold text-slate-50">{pct}%</div>
        <div className="mt-1 text-sm text-slate-400">
          {correct.length} correct · {missed.length} missed · {completed.length} cards
        </div>
      </div>

      {missed.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-rose-300">Missed</h3>
          <ul className="space-y-1">
            {missed.map((c) => (
              <li
                key={c.logId}
                className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm"
              >
                <span className="truncate text-slate-200">
                  {c.entry.itemType.icon} {itemPreview(c.entry.item, c.entry.itemType)}
                  <span className="ml-2 text-xs text-slate-500">{c.entry.template.name}</span>
                </span>
                <Badge color="rose">
                  {stageLabel(ladder, c.fromStage)} ↓ {stageLabel(ladder, c.toStage)}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      {correct.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-emerald-300">Correct</h3>
          <ul className="space-y-1">
            {correct.map((c) => (
              <li
                key={c.logId}
                className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm"
              >
                <span className="truncate text-slate-200">
                  {c.entry.itemType.icon} {itemPreview(c.entry.item, c.entry.itemType)}
                  <span className="ml-2 text-xs text-slate-500">{c.entry.template.name}</span>
                </span>
                {c.burned ? (
                  <Badge color="amber">🔥 Burned</Badge>
                ) : (
                  <Badge color="emerald">↑ {stageLabel(ladder, c.toStage)}</Badge>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
