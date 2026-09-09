import { useCallback, useEffect, useRef, useState } from 'react';
import { CapturesPanel } from '@/components/intake/Captures';
import { AnkiPanel } from '@/components/intake/AnkiImport';

import { Badge, Button, Panel } from '@/components/ui';

import {
  importInboxEntry,
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

function packetSummary(packet: Packet): string {
  switch (packet.kind) {
    case 'create-course':
      return `New course “${packet.course.name}” — ${packet.itemTypes.length} type(s), ${packet.items.length} item(s)`;
    case 'add-items':
      return `Add ${packet.items.length} item(s) to ${packet.courseName ?? packet.courseId ?? '?'}`;
    case 'course-plan': {
      const proposed = packet.units.reduce((sum, u) => sum + (u.items?.length ?? 0), 0);
      return `New planned course “${packet.course.name}” — ${packet.units.length} unit(s), ${proposed} item(s) to review`;
    }
    case 'propose-items':
      return `${packet.items.length} item(s) to review for ${packet.courseName ?? packet.courseId ?? '?'}`;
  }
}

export default function InboxPage() {
  const [handle, setHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [permission, setPermission] = useState<ExchangePermission | null>(null);
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [pasted, setPasted] = useState('');
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false); // synchronous mutex — state alone races fast double-clicks
  const refreshVersion = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const supported = exchangeSupported();

  const say = (msg: string) => setLog((l) => [msg, ...l].slice(0, 8));

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const h = await getSavedHandle();
      if (version !== refreshVersion.current) return;
      setHandle(h);
      const perm = h ? await checkPermission(h) : null;
      if (version !== refreshVersion.current) return;
      setPermission(perm);
      if (!h || perm !== 'granted') {
        setEntries([]);
        return;
      }
      const next = await scanInbox(h);
      if (version !== refreshVersion.current) return;
      setEntries(next);
      await writeSnapshot(h, now());
    } catch (err) {
      if (version === refreshVersion.current) say(`Exchange error: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      refreshVersion.current++;
      window.removeEventListener('focus', onFocus);
    };
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
      const res =
        handle && fileName
          ? await importInboxEntry(handle, fileName, now())
          : await applyPacket(packet, now());
      const warn = res.warnings.length > 0 ? ` (${res.warnings.join(' ')})` : '';
      // review-queue kinds park items instead of teaching them
      const outcome =
        res.proposalsAdded > 0
          ? `queued ${res.proposalsAdded} item(s) for review in`
          : `imported ${res.itemsAdded} item(s) into`;
      say(`✅ ${sourceName}: ${outcome} “${res.courseName}”.${warn}`);
      if ('archiveError' in res && res.archiveError)
        say(
          `Imported safely, but the file could not be archived: ${res.archiveError}. Rescan and retry archive; the content will not be duplicated.`,
        );
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
        Turn captured notes into items, review incoming content, and bring in courses from files or
        assistants.
      </p>

      <CapturesPanel />

      <Panel
        title="Assistant exchange"
        actions={
          handle ? (
            <>
              <Button disabled={importing} onClick={() => void refresh()}>
                Rescan
              </Button>
              <Button
                disabled={importing}
                onClick={async () => {
                  try {
                    await disconnectExchange();
                    await refresh();
                  } catch (error) {
                    say((error as Error).message);
                  }
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
            This browser doesn't support the File System Access API — use Chrome or Edge for the MCP
            exchange. File and paste import below still work.
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
                {permission === 'granted'
                  ? `connected · ${handle.name}`
                  : `permission ${permission}`}
              </Badge>
              {permission === 'granted' && (
                <span className="text-sm text-slate-500">
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
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2"
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
                        {importing ? 'Working…' : e.alreadyImported ? 'Retry archive' : 'Import'}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Panel>

      <AnkiPanel onImport={importPacketNow} />

      <Panel title="Import a packet file">
        <div className="flex items-center gap-2">
          <Button disabled={importing} onClick={() => fileRef.current?.click()}>
            Choose .json file…
          </Button>
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
            Accepts srs-packet files (create-course, add-items, course-plan, propose-items).
          </span>
        </div>
      </Panel>

      <Panel title="Paste packet JSON">
        <textarea
          aria-label="Packet JSON to import"
          disabled={importing}
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
          <ul role="log" aria-live="polite" className="space-y-1 text-sm text-slate-300">
            {log.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
