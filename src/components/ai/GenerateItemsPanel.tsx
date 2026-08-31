import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { Badge, Button, Panel } from '@/components/ui';
import type { ItemType } from '@/engine/types';
import type { PacketItem } from '@/packages/schema';
import { applyPacket, validateItemsForCourse } from '@/packages/importPacket';
import { generateItems, itemsToPacket } from '@/ai/generate';
import { aiErrorMessage } from '@/ai/client';
import { useAiReady } from '@/hooks/useAiReady';
import { maybeRefreshSnapshot } from '@/exchange/exchange';
import { now } from '@/services/clock';

function itemLabel(item: PacketItem): string {
  return Object.entries(item.fields)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join(' · ');
}

export function GenerateItemsPanel({ courseId, types }: { courseId: string; types: ItemType[] }) {
  const aiReady = useAiReady();
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const [request, setRequest] = useState('');
  const [count, setCount] = useState(10);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false); // synchronous mutex against double-click
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<PacketItem[] | null>(null);
  const [itemErrors, setItemErrors] = useState<(string | null)[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [done, setDone] = useState('');

  async function guarded(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  if (aiReady === false) {
    return (
      <Panel title="✨ Generate items with AI">
        <p className="text-sm text-slate-400">
          Add your Anthropic API key in{' '}
          <Link to="/settings" className="text-violet-300 hover:underline">
            Settings → AI
          </Link>{' '}
          to generate items from a topic or pasted text.
        </p>
      </Panel>
    );
  }

  const effectiveTypeId = types.some((t) => t.id === typeId) ? typeId : (types[0]?.id ?? '');

  return (
    <Panel title="✨ Generate items with AI">
      {!preview && (
        <div className="space-y-3">
          <textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            rows={3}
            placeholder="A topic (“Spanish kitchen vocabulary”) or paste source text to turn into items…"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-200 outline-none focus:border-violet-500"
          />
          <div className="flex flex-wrap items-center gap-2">
            {types.length > 1 && (
              <select
                value={effectiveTypeId}
                onChange={(e) => setTypeId(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
              >
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.icon} {t.name}
                  </option>
                ))}
              </select>
            )}
            <select
              value={count}
              onChange={(e) => setCount(+e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
            >
              {[5, 10, 20, 40].map((n) => (
                <option key={n} value={n}>
                  {n} items
                </option>
              ))}
            </select>
            <Button
              variant="primary"
              disabled={busy || !request.trim() || !effectiveTypeId}
              onClick={() =>
                void guarded(async () => {
                  setDone('');
                  const res = await generateItems(courseId, effectiveTypeId, request.trim(), count);
                  // dry-run each item so bad rows are flagged instead of
                  // failing the whole atomic import later
                  const errors = await validateItemsForCourse(courseId, res.packetItems);
                  setPreview(res.packetItems);
                  setItemErrors(errors);
                  setSelected(new Set(res.packetItems.map((_, i) => i).filter((i) => !errors[i])));
                })
              }
            >
              {busy ? 'Generating…' : 'Generate'}
            </Button>
            {done && <span className="text-sm text-emerald-300">{done}</span>}
          </div>
        </div>
      )}

      {preview && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Badge color="violet">
              {selected.size}/{preview.length} selected
            </Badge>
            <div className="flex gap-2">
              <Button onClick={() => setPreview(null)}>← Discard</Button>
              <Button
                variant="primary"
                disabled={selected.size === 0 || busy}
                onClick={() =>
                  void guarded(async () => {
                    const chosen = preview.filter((_, i) => selected.has(i) && !itemErrors[i]);
                    const res = await applyPacket(itemsToPacket(courseId, chosen), now());
                    setDone(`Added ${res.itemsAdded} items to the lesson queue.`);
                    setPreview(null);
                    setRequest('');
                    void maybeRefreshSnapshot(now());
                  })
                }
              >
                Add {selected.size} item{selected.size === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
          <ul className="max-h-80 space-y-1 overflow-y-auto pr-1">
            {preview.map((item, i) => {
              const rowError = itemErrors[i];
              const synonymList = Array.isArray(item.synonyms)
                ? item.synonyms
                : item.synonyms
                  ? Object.values(item.synonyms).flat()
                  : [];
              return (
                <li
                  key={i}
                  className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${rowError ? 'border-rose-900 bg-rose-950/20 opacity-70' : 'border-slate-800 bg-slate-950/50'}`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(i)}
                    disabled={!!rowError}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(i);
                      else next.delete(i);
                      setSelected(next);
                    }}
                    className="mt-1"
                  />
                  <div className="min-w-0 text-sm">
                    <div className="text-slate-200">{itemLabel(item)}</div>
                    {synonymList.length > 0 && (
                      <div className="text-xs text-slate-500">also: {synonymList.join(', ')}</div>
                    )}
                    {item.note && <div className="text-xs text-violet-300/80">💡 {item.note}</div>}
                    {rowError && <div className="text-xs text-rose-300">⚠ {rowError}</div>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-rose-300">{error}</p>}
    </Panel>
  );
}
