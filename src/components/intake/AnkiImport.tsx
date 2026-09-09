import { useRef, useState } from 'react';
import { Badge, Button, Panel, TextInput } from '@/components/ui';
import type { Packet } from '@/packages/schema';
import { useOperation } from '@/hooks/useOperation';
import type { AnkiMapping, AnkiParsed } from '@/anki/apkg';

export function AnkiPanel({
  onImport,
}: {
  onImport: (packet: Packet, sourceName: string) => Promise<boolean>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<AnkiParsed | null>(null);
  const [courseName, setCourseName] = useState('');
  const [mappings, setMappings] = useState<Record<string, AnkiMapping>>({});
  const operation = useOperation();
  const { busy, error } = operation;

  const CAP = 2000;

  return (
    <Panel title="Import an Anki deck (.apkg)">
      {!parsed && (
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? 'Reading deck…' : 'Choose .apkg file…'}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".apkg"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              await operation.run(async () => {
                const { parseApkg } = await import('@/anki/apkg');
                const result = await parseApkg(await file.arrayBuffer(), file.name);
                setParsed(result);
                setCourseName(result.suggestedName);
                setMappings(
                  Object.fromEntries(
                    result.models.map((m) => [
                      m.id,
                      {
                        // one-field notetypes can't have distinct prompt/answer —
                        // excluded by default (prompt === answer would self-reveal)
                        include: m.fieldNames.length > 1,
                        promptIdx: 0,
                        answerIdx: m.fieldNames.length > 1 ? 1 : 0,
                      },
                    ]),
                  ),
                );
              });
            }}
          />
          <span className="text-xs text-slate-500">
            Notes and fields import; scheduling, media, and card HTML don't. Newest-format exports
            need "Support older Anki versions" checked in Anki.
          </span>
        </div>
      )}

      {parsed && (
        <fieldset disabled={busy} className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="block max-w-xs grow">
              <span className="mb-1 block text-xs text-slate-400">Course name</span>
              <TextInput value={courseName} onChange={(e) => setCourseName(e.target.value)} />
            </label>
            <Badge color="violet">{parsed.totalNotes} notes</Badge>
            {parsed.totalNotes > CAP && <Badge color="amber">first {CAP} imported</Badge>}
          </div>
          <div className="space-y-2">
            {parsed.models.map((m) => {
              const map = mappings[m.id];
              if (!map) return null;
              const set = (patch: Partial<AnkiMapping>) =>
                setMappings({ ...mappings, [m.id]: { ...map, ...patch } });
              return (
                <div
                  key={m.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm"
                >
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={map.include}
                      onChange={(e) => set({ include: e.target.checked })}
                    />
                    <span className="font-medium text-slate-200">{m.name}</span>
                  </label>
                  <span className="text-xs text-slate-500">{m.noteCount} notes</span>
                  <span className="text-xs text-slate-500">prompt:</span>
                  <select
                    aria-label={`Prompt field for ${m.name}`}
                    value={map.promptIdx}
                    onChange={(e) => set({ promptIdx: +e.target.value })}
                    className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-xs"
                  >
                    {m.fieldNames.map((f, i) => (
                      <option key={i} value={i}>
                        {f}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-slate-500">typed answer:</span>
                  <select
                    aria-label={`Answer field for ${m.name}`}
                    value={map.answerIdx}
                    onChange={(e) => set({ answerIdx: +e.target.value })}
                    className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-xs"
                  >
                    {m.fieldNames.map((f, i) => (
                      <option key={i} value={i}>
                        {f}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
          {error && (
            <p role="alert" className="text-sm text-rose-300">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setParsed(null)}>
              ← Discard
            </Button>
            <Button
              variant="primary"
              disabled={
                busy || !courseName.trim() || !Object.values(mappings).some((m) => m.include)
              }
              onClick={async () => {
                await operation.run(async () => {
                  const { buildAnkiPacket } = await import('@/anki/apkg');
                  const { packet, skipped } = buildAnkiPacket(parsed, mappings, courseName, CAP);
                  const ok = await onImport(
                    packet,
                    `Anki: ${courseName.trim()}${skipped ? ` (${skipped} empty notes skipped)` : ''}`,
                  );
                  if (ok) setParsed(null);
                });
              }}
            >
              Import as course
            </Button>
          </div>
        </fieldset>
      )}
      {!parsed && error && (
        <p role="alert" className="mt-2 text-sm text-rose-300">
          {error}
        </p>
      )}
    </Panel>
  );
}
