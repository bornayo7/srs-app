import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { Badge, Button, Select } from '@/components/ui';
import { formatDuration } from '@/engine/time';
import { useNowTick } from '@/hooks/useNowTick';
import type { Item, ItemType, SrsLadder } from '@/engine/types';
import {
  lastManualBatch,
  resetItem,
  setCardManual,
  setItemStage,
  stageOptions,
  undoManualBatch,
  type ManualAction,
} from '@/services/manualSrs';
import { now } from '@/services/clock';

/**
 * Manual SRS control for one item. Every button here writes a `kind:'manual'`
 * review log with the previous card snapshot, so nothing is silently rewritten
 * and the last operation can be undone as a group.
 */
export function SrsControls({
  item,
  itemType,
  ladder,
}: {
  item: Item;
  itemType: ItemType;
  ladder: SrsLadder | null;
}) {
  const t = useNowTick(60_000);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [bulkStage, setBulkStage] = useState(0);

  const cards = useLiveQuery(
    async () => (await db.cards.where('itemId').equals(item.id).toArray()).filter((c) => !c.isGhost),
    [item.id],
  );
  const undoable = useLiveQuery(() => lastManualBatch(item.id), [item.id, message]);

  if (!ladder) {
    return <p className="text-sm text-slate-500">Manual stage control needs a ladder scheduler.</p>;
  }
  const options = stageOptions(ladder);

  async function act(fn: () => Promise<unknown>, label: string) {
    setBusy(true);
    setMessage('');
    try {
      await fn();
      setMessage(label);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const cardAction = (cardId: string, action: ManualAction, label: string) =>
    act(() => setCardManual(cardId, action, now()), label);

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-slate-800/70">
        {(cards ?? []).map((card) => {
          const template = itemType.templates.find((tpl) => tpl.id === card.templateId);
          const stageIndex = card.srs?.kind === 'ladder' ? card.srs.stageIndex : null;
          return (
            <li key={card.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="w-24 shrink-0 truncate text-sm text-slate-300">
                {template?.name ?? 'unknown template'}
              </span>
              <Badge
                color={
                  card.state === 'suspended'
                    ? 'amber'
                    : card.state === 'burned'
                      ? 'amber'
                      : card.state === 'new'
                        ? 'slate'
                        : stageIndex !== null && stageIndex >= ladder.passesAtIndex
                          ? 'violet'
                          : 'rose'
                }
              >
                {card.state === 'new'
                  ? 'new'
                  : card.state === 'suspended'
                    ? '⏸ suspended'
                    : card.state === 'burned'
                      ? '🔥 burned'
                      : (ladder.stages[stageIndex ?? 0]?.name ?? '—')}
              </Badge>
              {card.dueAt !== undefined && (
                <span className="text-xs text-slate-500">
                  {card.dueAt <= t ? 'due now' : `in ${formatDuration(card.dueAt - t)}`}
                </span>
              )}
              <span className="text-xs text-slate-600">
                {card.stats.reviews} reviews · {card.stats.lapses} lapses
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <Select
                  disabled={busy}
                  value={stageIndex ?? ''}
                  onChange={(e) =>
                    void cardAction(
                      card.id,
                      { kind: 'setStage', stageIndex: +e.target.value },
                      'Stage set.',
                    )
                  }
                  title="Move this card to a specific stage"
                >
                  <option value="">set stage…</option>
                  {options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                {card.state === 'suspended' ? (
                  <Button
                    disabled={busy}
                    onClick={() => void cardAction(card.id, { kind: 'resume' }, 'Resumed.')}
                  >
                    Resume
                  </Button>
                ) : (
                  <Button
                    disabled={busy || card.state === 'new'}
                    title="Take this card out of reviews without losing its stage"
                    onClick={() => void cardAction(card.id, { kind: 'suspend' }, 'Suspended.')}
                  >
                    Suspend
                  </Button>
                )}
                <Button
                  disabled={busy || card.state === 'new'}
                  title="Send this card back to the lesson queue"
                  onClick={() => void cardAction(card.id, { kind: 'reset' }, 'Back in lessons.')}
                >
                  Reset
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3">
        <Select value={bulkStage} onChange={(e) => setBulkStage(+e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Button
          disabled={busy}
          onClick={() => void act(() => setItemStage(item.id, bulkStage, now()), 'All cards moved.')}
        >
          Set every card
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          title="Wipe this item's scheduling and its pass — it returns to the lesson queue"
          onClick={() => void act(() => resetItem(item.id, now()), 'Item reset to lessons.')}
        >
          Reset item
        </Button>
        <div className="grow" />
        {undoable && (
          <Button
            disabled={busy}
            title={`Undo the manual change from ${new Date(undoable.ts).toLocaleString()}`}
            onClick={() =>
              void act(() => undoManualBatch(undoable.sessionId, now()), 'Manual change undone.')
            }
          >
            ↩ Undo last manual change
          </Button>
        )}
      </div>
      {message && <p className="text-xs text-slate-400">{message}</p>}
      <p className="text-[11px] text-slate-600">
        Manual changes are logged like reviews (with the previous state), and passing an item here
        unlocks whatever depends on it.
      </p>
    </div>
  );
}
