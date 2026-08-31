import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Badge, Button, Panel } from '@/components/ui';
import type { CreateCoursePacket } from '@/packages/schema';
import { applyPacket } from '@/packages/importPacket';
import { generateCourse } from '@/ai/generate';
import { aiErrorMessage } from '@/ai/client';
import { useAiReady } from '@/hooks/useAiReady';
import { maybeRefreshSnapshot } from '@/exchange/exchange';
import { now } from '@/services/clock';

export function GenerateCoursePanel({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const aiReady = useAiReady();
  const [request, setRequest] = useState('');
  const [count, setCount] = useState(20);
  const [preset, setPreset] = useState<'classic' | 'gentle' | 'bunpro'>('classic');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false); // synchronous mutex against double-click
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<CreateCoursePacket | null>(null);

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
      <Panel title="✨ AI course">
        <p className="text-sm text-slate-400">
          Add your Anthropic API key in{' '}
          <Link to="/settings" className="text-violet-300 hover:underline">
            Settings → AI
          </Link>{' '}
          to have Claude design a complete course from a description.
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="✨ AI course" actions={<Button variant="ghost" onClick={onDone}>Close</Button>}>
      {!preview && (
        <div className="space-y-3">
          <textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            rows={3}
            autoFocus
            placeholder="Describe what you want to learn — “the 50 most common Spanish verbs”, “US state capitals”, “SQL join types with examples”…"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-200 outline-none focus:border-violet-500"
          />
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={count}
              onChange={(e) => setCount(+e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
            >
              {[10, 20, 40, 60].map((n) => (
                <option key={n} value={n}>
                  {n} items
                </option>
              ))}
            </select>
            <select
              value={preset}
              onChange={(e) => setPreset(e.target.value as typeof preset)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
            >
              <option value="classic">Classic (WaniKani) ladder</option>
              <option value="gentle">Gentle ladder</option>
              <option value="bunpro">Bunpro-like ladder</option>
            </select>
            <Button
              variant="primary"
              disabled={busy || !request.trim()}
              onClick={() =>
                void guarded(async () => {
                  setPreview(await generateCourse(request.trim(), count, preset));
                })
              }
            >
              {busy ? 'Designing course…' : 'Generate course'}
            </Button>
          </div>
        </div>
      )}

      {preview && (
        <div className="space-y-3">
          <div>
            <h3 className="font-semibold text-slate-100">
              {preview.itemTypes[0]?.icon} {preview.course.name}
            </h3>
            <p className="text-sm text-slate-400">{preview.course.description}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <Badge color="violet">{preview.items.length} items</Badge>
              <Badge>
                fields: {preview.itemTypes[0]?.fields.map((f) => f.name).join(', ')}
              </Badge>
              {preview.itemTypes[0]?.templates.map((t) => (
                <Badge key={t.name} color="sky">
                  {t.name}: {t.promptFields.join('+')} → {t.answerField}
                </Badge>
              ))}
            </div>
          </div>
          <ul className="max-h-64 space-y-1 overflow-y-auto pr-1 text-sm">
            {preview.items.slice(0, 50).map((item, i) => (
              <li key={i} className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-1.5">
                <span className="text-slate-200">
                  {Object.entries(item.fields)
                    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
                    .join(' · ')}
                </span>
                {item.note && <div className="text-xs text-violet-300/80">💡 {item.note}</div>}
              </li>
            ))}
            {preview.items.length > 50 && (
              <li className="text-xs text-slate-500">…and {preview.items.length - 50} more</li>
            )}
          </ul>
          {error && <p className="text-sm text-rose-300">{error}</p>}
          <div className="flex gap-2">
            <Button onClick={() => setPreview(null)}>← Discard</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void guarded(async () => {
                  const res = await applyPacket(preview, now());
                  void maybeRefreshSnapshot(now());
                  onDone();
                  navigate(`/course/${res.courseId}`);
                })
              }
            >
              Create course
            </Button>
          </div>
        </div>
      )}

      {!preview && error && <p className="mt-2 text-sm text-rose-300">{error}</p>}
    </Panel>
  );
}
