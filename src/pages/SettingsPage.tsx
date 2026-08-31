import { useEffect, useRef, useState } from 'react';
import { db, isStoragePersisted, requestPersistentStorage } from '@/db/db';
import { Button, Panel, Badge, TextInput } from '@/components/ui';
import { exportAll, downloadBackup } from '@/db/export';
import { importAll } from '@/db/import';
import { clockOffset, now, setClockOffset } from '@/services/clock';
import { DAY, HOUR, formatDuration } from '@/engine/time';
import { AI_MODELS, getAiConfig, setApiKey, setModel } from '@/ai/config';
import { aiErrorMessage, testConnection } from '@/ai/client';

function AiPanel() {
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [model, setModelState] = useState('claude-opus-5');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getAiConfig().then((cfg) => {
      setHasKey(cfg.apiKey !== null);
      setModelState(cfg.model);
    });
  }, []);

  return (
    <Panel title="AI (Anthropic API)">
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="block grow max-w-md">
            <span className="mb-1 block text-xs text-slate-400">
              API key {hasKey && <Badge color="emerald">saved</Badge>}
            </span>
            <TextInput
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={hasKey ? '•••••••• (saved — paste to replace)' : 'sk-ant-…'}
            />
          </label>
          <Button
            variant="primary"
            disabled={!key.trim()}
            onClick={async () => {
              await setApiKey(key);
              setKey('');
              setHasKey(true);
              setStatus('Key saved locally.');
            }}
          >
            Save key
          </Button>
          {hasKey && (
            <Button
              onClick={async () => {
                await setApiKey('');
                setHasKey(false);
                setStatus('Key removed.');
              }}
            >
              Remove
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={model}
            onChange={async (e) => {
              setModelState(e.target.value);
              await setModel(e.target.value);
            }}
            className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
          >
            {AI_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <Button
            disabled={!hasKey || busy}
            onClick={async () => {
              setBusy(true);
              setStatus('Testing…');
              try {
                setStatus(await testConnection());
              } catch (err) {
                setStatus(aiErrorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Test connection
          </Button>
          {status && <span className="text-sm text-slate-400">{status}</span>}
        </div>
        <p className="text-xs text-slate-500">
          Powers “✨ AI course”, “✨ Generate items”, and per-item mnemonics. Calls go directly
          from this browser to api.anthropic.com; the key is stored only in this browser's local
          database — use a key you can rotate, and don't use this on shared machines.
        </p>
      </div>
    </Panel>
  );
}

function TimeTravelPanel() {
  const [, force] = useState(0);
  if (!import.meta.env.DEV) return null;
  const offset = clockOffset();
  const bump = async (ms: number) => {
    await setClockOffset(offset + ms);
    force((x) => x + 1);
  };
  return (
    <Panel title="Dev · time travel">
      <div className="flex flex-wrap items-center gap-2">
        <Badge color={offset === 0 ? 'slate' : 'amber'}>
          {offset === 0 ? 'real time' : `+${formatDuration(offset)}`}
        </Badge>
        <Button onClick={() => bump(HOUR)}>+1h</Button>
        <Button onClick={() => bump(4 * HOUR)}>+4h</Button>
        <Button onClick={() => bump(8 * HOUR)}>+8h</Button>
        <Button onClick={() => bump(DAY)}>+1d</Button>
        <Button onClick={() => bump(7 * DAY)}>+1w</Button>
        <Button
          variant="danger"
          onClick={async () => {
            await setClockOffset(0);
            force((x) => x + 1);
          }}
        >
          Reset clock
        </Button>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Shifts the app clock (dev builds only) so you can walk items up the ladder without
        waiting. App time: {new Date(now()).toLocaleString()}
      </p>
    </Panel>
  );
}

export default function SettingsPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void isStoragePersisted().then(setPersisted);
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-slate-100">Settings</h1>

      <Panel title="Backup">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={async () => downloadBackup(await exportAll(now()))}>
            Export JSON backup
          </Button>
          <Button onClick={() => fileRef.current?.click()}>Import backup…</Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              if (!confirm('Importing REPLACES everything currently in the app. Continue?')) return;
              try {
                const res = await importAll(JSON.parse(await file.text()));
                setMessage(`Imported ${res.courses} courses, ${res.items} items.`);
              } catch (err) {
                setMessage(`Import failed — nothing was changed. (${(err as Error).message.slice(0, 120)})`);
              }
            }}
          />
          {message && <span className="text-sm text-slate-400">{message}</span>}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Your SRS history is years of investment — export regularly. Media files will join the
          backup when images land in a later phase.
        </p>
      </Panel>

      <AiPanel />

      <Panel title="Storage">
        <div className="flex items-center gap-3">
          <Badge color={persisted ? 'emerald' : persisted === false ? 'amber' : 'slate'}>
            {persisted === null
              ? 'unknown'
              : persisted
                ? 'persistent — browser won’t evict'
                : 'not persistent'}
          </Badge>
          {persisted === false && (
            <Button
              onClick={async () => {
                await requestPersistentStorage();
                setPersisted(await isStoragePersisted());
              }}
            >
              Request persistence
            </Button>
          )}
        </div>
      </Panel>

      <TimeTravelPanel />

      <Panel title="Danger zone">
        <Button
          variant="danger"
          onClick={async () => {
            if (
              confirm('Wipe ALL app data? Export a backup first — this cannot be undone.') &&
              confirm('Really wipe everything?')
            ) {
              await Promise.all(db.tables.map((t) => t.clear()));
              location.href = '/';
            }
          }}
        >
          Wipe all data
        </Button>
      </Panel>
    </div>
  );
}
