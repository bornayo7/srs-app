import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { createItem } from '@/db/repo/items';
import type { Capture, FieldValue, ItemType } from '@/engine/types';
import { parseClozeLines } from '@/engine/grading/cloze';
import { Badge, Button, Panel, TextInput } from '@/components/ui';
import {
  archivePacket,
  checkPermission,
  connectExchange,
  disconnectExchange,
  exchangeSupported,
  getSavedHandle,
  reRequestPermission,
  scanInbox,
  writeSnapshot,
  type ExchangePermission,
  type InboxEntry,
} from '@/exchange/exchange';
import { parsePacket, type Packet } from '@/packages/schema';
import { applyPacket } from '@/packages/importPacket';
import { now } from '@/services/clock';
import type { AnkiParsed } from '@/anki/apkg';

function ConvertCaptureRow({ capture }: { capture: Capture }) {
  const courses = useLiveQuery(() => db.courses.toArray(), []);
  const [courseId, setCourseId] = useState('');
  const [typeId, setTypeId] = useState('');
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const types = useLiveQuery(
    () => (courseId ? db.itemTypes.where('courseId').equals(courseId).toArray() : []),
    [courseId],
  );
  const ty: ItemType | undefined = types?.find((t) => t.id === typeId) ?? types?.[0];

  return (
    <li className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm text-slate-200">{capture.text}</span>
        <div className="flex shrink-0 items-center gap-1.5">
          {!open && (
            <>
              <select
                value={courseId}
                onChange={(e) => setCourseId(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
              >
                <option value="">course…</option>
                {courses?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <Button
                disabled={!courseId}
                onClick={() => {
                  setOpen(true);
                  setError('');
                  setValues({});
                }}
              >
                Convert
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={() => void db.captures.delete(capture.id)}>
            ✕
          </Button>
        </div>
      </div>
      {open && ty && (
        <div className="mt-2 space-y-2 border-t border-slate-800 pt-2">
          {(types?.length ?? 0) > 1 && (
            <select
              value={ty.id}
              onChange={(e) => setTypeId(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
            >
              {types?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.icon} {t.name}
                </option>
              ))}
            </select>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            {ty.fields.map((f, i) => (
              <label key={f.id} className="block">
                <span className="mb-0.5 block text-xs text-slate-400">
                  {f.name}
                  {f.kind === 'clozeSentences' && ' (⟦blank⟧ per line)'}
                </span>
                <TextInput
                  value={values[f.id] ?? (i === 0 ? capture.text : '')}
                  onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
                />
              </label>
            ))}
          </div>
          {error && <p className="text-xs text-rose-300">{error}</p>}
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={async () => {
                setError('');
                const fieldValues: Record<string, FieldValue> = {};
                for (const [i, f] of ty.fields.entries()) {
                  const raw = (values[f.id] ?? (i === 0 ? capture.text : '')).trim();
                  if (!raw) {
                    setError(`Fill in "${f.name}".`);
                    return;
                  }
                  if (f.kind === 'clozeSentences') {
                    const { sentences, error: clozeErr } = parseClozeLines(raw);
                    if (clozeErr) {
                      setError(`${f.name}: ${clozeErr}`);
                      return;
                    }
                    fieldValues[f.id] = sentences;
                  } else {
                    fieldValues[f.id] = raw;
                  }
                }
                try {
                  await createItem({ courseId, typeId: ty.id, fieldValues }, now());
                  await db.captures.delete(capture.id);
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              Create item
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function CapturesPanel() {
  const captures = useLiveQuery(() => db.captures.orderBy('createdAt').toArray(), []);
  if (!captures || captures.length === 0) return null;
  return (
    <Panel title={`Captured notes · ${captures.length}`}>
      <ul className="space-y-1.5">
        {captures.map((c) => (
          <ConvertCaptureRow key={c.id} capture={c} />
        ))}
      </ul>
      <p className="mt-2 text-xs text-slate-500">
        Jotted from the Dashboard — convert each into a real item (it enters the lesson queue).
      </p>
    </Panel>
  );
}

interface AnkiMapping {
  include: boolean;
  promptIdx: number;
  answerIdx: number;
}

function AnkiPanel({
  onImport,
}: {
  onImport: (packet: Packet, sourceName: string) => Promise<boolean>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<AnkiParsed | null>(null);
  const [courseName, setCourseName] = useState('');
  const [mappings, setMappings] = useState<Record<string, AnkiMapping>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const CAP = 2000;

  return (
    <Panel title="Import an Anki deck (.apkg)">
      {!parsed && (
        <div className="flex items-center gap-2">
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
              setBusy(true);
              setError('');
              try {
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
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          />
          <span className="text-xs text-slate-500">
            Notes and fields import; scheduling, media, and card HTML don't. Newest-format
            exports need "Support older Anki versions" checked in Anki.
          </span>
        </div>
      )}

      {parsed && (
        <div className="space-y-3">
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
          {error && <p className="text-sm text-rose-300">{error}</p>}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setParsed(null)}>
              ← Discard
            </Button>
            <Button
              variant="primary"
              disabled={busy || !courseName.trim() || !Object.values(mappings).some((m) => m.include)}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  const { dedupeNames } = await import('@/anki/apkg');
                  const { containsKana } = await import('@/engine/grading/normalize');
                  const included = parsed.models.filter((m) => mappings[m.id]?.include);
                  const clash = included.find(
                    (m) => mappings[m.id].promptIdx === mappings[m.id].answerIdx,
                  );
                  if (clash) {
                    setError(
                      `"${clash.name}": prompt and typed answer are the same field — the card would show its own answer. Pick different fields or exclude it.`,
                    );
                    return;
                  }
                  const typeNames = dedupeNames(included.map((m) => m.name));
                  const itemTypes = included.map((m, mi) => {
                    const fieldNames = dedupeNames(m.fieldNames);
                    const map = mappings[m.id];
                    // kana-majority answers get kana grading (exact-match, IME)
                    const answers = (parsed.notesByModel.get(m.id) ?? [])
                      .map((row) => row[map.answerIdx]?.trim())
                      .filter(Boolean) as string[];
                    const kana =
                      answers.length > 0 &&
                      answers.filter((v) => containsKana(v)).length > answers.length / 2;
                    return {
                      name: typeNames[mi],
                      icon: '🗂️',
                      fields: fieldNames.map((name) => ({ name })),
                      templates: [
                        {
                          name: 'Card',
                          promptFields: [fieldNames[map.promptIdx]],
                          answerField: fieldNames[map.answerIdx],
                          answerLang: (kana ? 'kana' : 'latin') as 'kana' | 'latin',
                        },
                      ],
                    };
                  });
                  const items = [];
                  let skipped = 0;
                  outer: for (const [mi, m] of included.entries()) {
                    const fieldNames = dedupeNames(m.fieldNames);
                    const map = mappings[m.id];
                    for (const row of parsed.notesByModel.get(m.id) ?? []) {
                      if (items.length >= CAP) break outer;
                      const fields: Record<string, string> = {};
                      for (const [fi, name] of fieldNames.entries()) {
                        const v = row[fi]?.trim();
                        if (v) fields[name] = v;
                      }
                      if (!fields[fieldNames[map.promptIdx]] || !fields[fieldNames[map.answerIdx]]) {
                        skipped++;
                        continue;
                      }
                      items.push({ type: typeNames[mi], fields });
                    }
                  }
                  if (items.length === 0) {
                    setError('No importable notes (prompt/answer fields were empty).');
                    return;
                  }
                  const packet = parsePacket({
                    format: 'srs-packet',
                    version: 1,
                    kind: 'create-course',
                    course: {
                      name: courseName.trim(),
                      description: `Imported from Anki (${parsed.totalNotes} notes)`,
                    },
                    itemTypes,
                    items,
                  });
                  const ok = await onImport(
                    packet,
                    `Anki: ${courseName.trim()}${skipped ? ` (${skipped} empty notes skipped)` : ''}`,
                  );
                  if (ok) setParsed(null);
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Import as course
            </Button>
          </div>
        </div>
      )}
      {!parsed && error && <p className="mt-2 text-sm text-rose-300">{error}</p>}
    </Panel>
  );
}

function packetSummary(packet: Packet): string {
  if (packet.kind === 'create-course') {
    return `New course “${packet.course.name}” — ${packet.itemTypes.length} type(s), ${packet.items.length} item(s)`;
  }
  return `Add ${packet.items.length} item(s) to ${packet.courseName ?? packet.courseId ?? '?'}`;
}

export default function InboxPage() {
  const [handle, setHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [permission, setPermission] = useState<ExchangePermission | null>(null);
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [pasted, setPasted] = useState('');
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false); // synchronous mutex — state alone races fast double-clicks
  const fileRef = useRef<HTMLInputElement>(null);
  const supported = exchangeSupported();

  const say = (msg: string) => setLog((l) => [msg, ...l].slice(0, 8));

  const refresh = useCallback(async () => {
    const h = await getSavedHandle();
    setHandle(h);
    if (!h) {
      setPermission(null);
      setEntries([]);
      return;
    }
    const perm = await checkPermission(h);
    setPermission(perm);
    if (perm === 'granted') {
      try {
        setEntries(await scanInbox(h));
        await writeSnapshot(h, now());
      } catch (err) {
        say(`Exchange error: ${(err as Error).message}`);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  /** Returns true on success. Guarded against double-click re-entry. */
  async function importPacketNow(
    packet: Packet,
    sourceName: string,
    fileName?: string,
  ): Promise<boolean> {
    if (importingRef.current) return false;
    importingRef.current = true;
    setImporting(true);
    try {
      const res = await applyPacket(packet, now());
      const warn = res.warnings.length > 0 ? ` (${res.warnings.join(' ')})` : '';
      say(`✅ ${sourceName}: imported ${res.itemsAdded} item(s) into “${res.courseName}”.${warn}`);
      if (handle && fileName) {
        try {
          await archivePacket(handle, fileName);
        } catch (archiveErr) {
          // the import DID happen — warn so a rescan doesn't double-import
          say(
            `⚠ Imported, but couldn't move ${fileName} to inbox/done (${(archiveErr as Error).message}) — delete it manually to avoid importing it twice.`,
          );
        }
      }
      await refresh();
      return true;
    } catch (err) {
      say(`❌ ${sourceName}: ${(err as Error).message}`);
      return false;
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-slate-100">Inbox</h1>
      <p className="text-sm text-slate-400">
        Import courses and items from AI assistants (via the srs-mcp server), from files, or from
        pasted JSON. Everything is validated before it touches your data.
      </p>

      <Panel
        title="Exchange folder (MCP bridge)"
        actions={
          handle ? (
            <>
              <Button onClick={() => void refresh()}>Rescan</Button>
              <Button
                onClick={async () => {
                  await disconnectExchange();
                  await refresh();
                }}
              >
                Disconnect
              </Button>
            </>
          ) : undefined
        }
      >
        {!supported && (
          <p className="text-sm text-amber-300">
            This browser doesn't support the File System Access API — use Chrome or Edge for the
            MCP exchange. File and paste import below still work.
          </p>
        )}
        {supported && !handle && (
          <div className="space-y-2">
            <p className="text-sm text-slate-400">
              Pick a folder (e.g. <code className="text-slate-300">Documents\srs-exchange</code>).
              The app writes <code className="text-slate-300">snapshot.json</code> there so AI
              assistants can see your courses, and imports packets they drop into{' '}
              <code className="text-slate-300">inbox\</code>.
            </p>
            <Button
              variant="primary"
              onClick={async () => {
                try {
                  await connectExchange();
                  say('Exchange folder connected.');
                  await refresh();
                } catch (err) {
                  if ((err as Error).name !== 'AbortError') say((err as Error).message);
                }
              }}
            >
              Connect exchange folder
            </Button>
          </div>
        )}
        {handle && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <Badge color={permission === 'granted' ? 'emerald' : 'amber'}>
                {permission === 'granted' ? `connected · ${handle.name}` : `permission ${permission}`}
              </Badge>
              {permission === 'granted' && (
                <span className="text-xs text-slate-500">
                  snapshot.json refreshed on visit · {entries.length} packet(s) pending
                </span>
              )}
              {permission !== 'granted' && (
                <Button
                  onClick={async () => {
                    if (handle) setPermission(await reRequestPermission(handle));
                    await refresh();
                  }}
                >
                  Grant access
                </Button>
              )}
            </div>
            {entries.length > 0 && (
              <ul className="space-y-1.5">
                {entries.map((e) => (
                  <li
                    key={e.fileName}
                    className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm text-slate-200">
                        {e.packet ? packetSummary(e.packet) : `⚠ ${e.error}`}
                      </div>
                      <div className="text-xs text-slate-500">{e.fileName}</div>
                    </div>
                    {e.packet && (
                      <Button
                        variant="primary"
                        disabled={importing}
                        onClick={() => void importPacketNow(e.packet!, e.fileName, e.fileName)}
                      >
                        {importing ? '…' : 'Import'}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Panel>

      <CapturesPanel />

      <AnkiPanel onImport={importPacketNow} />

      <Panel title="Import a packet file">
        <div className="flex items-center gap-2">
          <Button onClick={() => fileRef.current?.click()}>Choose .json file…</Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            multiple
            className="hidden"
            onChange={async (e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              for (const file of files) {
                try {
                  const packet = parsePacket(JSON.parse(await file.text()));
                  await importPacketNow(packet, file.name);
                } catch (err) {
                  say(`❌ ${file.name}: ${(err as Error).message}`);
                }
              }
            }}
          />
          <span className="text-xs text-slate-500">
            Accepts srs-packet files (create-course or add-items).
          </span>
        </div>
      </Panel>

      <Panel title="Paste packet JSON">
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          rows={5}
          placeholder='{"format":"srs-packet","version":1,"kind":"create-course", ...}'
          className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-slate-200 outline-none focus:border-violet-500"
        />
        <div className="mt-2">
          <Button
            variant="primary"
            disabled={!pasted.trim() || importing}
            onClick={async () => {
              try {
                const packet = parsePacket(JSON.parse(pasted));
                // keep the JSON in the box unless the import actually succeeded
                if (await importPacketNow(packet, 'pasted JSON')) setPasted('');
              } catch (err) {
                say(`❌ pasted JSON: ${(err as Error).message}`);
              }
            }}
          >
            Validate & import
          </Button>
        </div>
      </Panel>

      {log.length > 0 && (
        <Panel title="Activity">
          <ul className="space-y-1 text-sm text-slate-300">
            {log.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
