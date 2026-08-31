import { useRef, useState } from 'react';
import type { CompletedReview } from '@/stores/sessionStore';
import type { SrsLadder } from '@/engine/types';
import { itemPreview } from '@/engine/grading/context';
import { Badge, Button } from '@/components/ui';
import { db } from '@/db/db';
import { updateItem } from '@/db/repo/items';
import { generateMnemonic } from '@/ai/generate';
import { aiErrorMessage } from '@/ai/client';
import { useAiReady } from '@/hooks/useAiReady';
import { now } from '@/services/clock';

function stageLabel(ladder: SrsLadder | null, idx: number | null): string {
  if (ladder === null || idx === null) return '';
  if (idx >= ladder.stages.length) return 'Burned';
  return ladder.stages[idx].name;
}

/** One-click leech rescue: fresh AI mnemonics for everything just missed. */
function RescueButton({ missed }: { missed: CompletedReview[] }) {
  const aiReady = useAiReady();
  const busyRef = useRef(false); // synchronous double-click mutex
  const [busy, setBusy] = useState(false); // rendered disabled state
  const [progress, setProgress] = useState('');
  const itemIds = [...new Set(missed.map((c) => c.entry.item.id))];
  if (!aiReady || itemIds.length === 0) return null;

  return (
    <div className="flex items-center gap-2">
      <Button
        disabled={busy}
        onClick={async () => {
          if (busyRef.current) return;
          busyRef.current = true;
          setBusy(true);
          try {
            for (const [i, itemId] of itemIds.entries()) {
              setProgress(`Writing mnemonic ${i + 1}/${itemIds.length}…`);
              try {
                const note = await generateMnemonic(itemId);
                const item = await db.items.get(itemId);
                if (item) await updateItem({ ...item, note }, now());
              } catch (err) {
                setProgress(aiErrorMessage(err));
                return;
              }
            }
            setProgress(`✨ Wrote ${itemIds.length} mnemonic${itemIds.length === 1 ? '' : 's'} — shown in lessons and after misses.`);
          } finally {
            busyRef.current = false;
            setBusy(false);
          }
        }}
      >
        ✨ Write mnemonics for missed items
      </Button>
      {progress && <span className="text-xs text-slate-400">{progress}</span>}
    </div>
  );
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
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-rose-300">Missed</h3>
            <RescueButton missed={missed} />
          </div>
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
                {c.entry.card.isGhost ? (
                  <Badge color="sky">👻 missed</Badge>
                ) : (
                  <Badge color="rose">
                    {stageLabel(ladder, c.fromStage)} ↓ {stageLabel(ladder, c.toStage)}
                  </Badge>
                )}
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
                {c.entry.card.isGhost ? (
                  c.burned ? (
                    <Badge color="sky">👻 graduated</Badge>
                  ) : (
                    <Badge color="sky">👻 drilled</Badge>
                  )
                ) : c.burned ? (
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
