import { useEffect, useRef, useState } from 'react';
import { db, isStoragePersisted, requestPersistentStorage } from '@/db/db';
import { Button, Panel, Badge, TextInput } from '@/components/ui';
import { exportAll, downloadBackup } from '@/db/export';
import { importAll } from '@/db/import';
import { clockOffset, now, setClockOffset } from '@/services/clock';
import { DAY, HOUR, formatDuration } from '@/engine/time';
import {
  ANTHROPIC_MODELS,
  OPENAI_COMPAT_PRESETS,
  getAiConfig,
  setAnthropicKey,
  setAnthropicModel,
  setOpenaiBaseUrl,
  setOpenaiKey,
  setOpenaiModel,
  setProvider,
  type AiProvider,
} from '@/ai/config';
import { aiErrorMessage, testConnection } from '@/ai/client';

function AiPanel() {
  const [provider, setProviderState] = useState<AiProvider>('anthropic');
  const [key, setKey] = useState('');
  const [hasAnthropicKey, setHasAnthropicKey] = useState(false);
  const [hasOpenaiKey, setHasOpenaiKey] = useState(false);
  const [anthropicModel, setAnthropicModelState] = useState('claude-opus-5');
  const [openaiBaseUrl, setOpenaiBaseUrlState] = useState('https://api.openai.com/v1');
  const [openaiModel, setOpenaiModelState] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getAiConfig().then((cfg) => {
      setProviderState(cfg.provider);
      setHasAnthropicKey(cfg.anthropic.apiKey !== null);
      setHasOpenaiKey(cfg.openai.apiKey !== null);
      setAnthropicModelState(cfg.anthropic.model);
      setOpenaiBaseUrlState(cfg.openai.baseUrl);
      setOpenaiModelState(cfg.openai.model);
    });
  }, []);

  const hasActiveKey = provider === 'anthropic' ? hasAnthropicKey : hasOpenaiKey;

  return (
    <Panel title="AI provider">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {(
            [
              ['anthropic', 'Anthropic (Claude)'],
              ['openai', 'OpenAI-compatible (OpenAI · Gemini · OpenRouter · Ollama…)'],
            ] as const
          ).map(([id, label]) => (
            <label key={id} className="flex items-center gap-1.5 text-sm text-slate-200">
              <input
                type="radio"
                name="ai-provider"
                checked={provider === id}
                onChange={async () => {
                  setProviderState(id);
                  await setProvider(id);
                  setStatus('');
                }}
              />
              {label}
            </label>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="block max-w-md grow">
            <span className="mb-1 block text-xs text-slate-400">
              API key {hasActiveKey && <Badge color="emerald">saved</Badge>}
            </span>
            <TextInput
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={
                hasActiveKey
                  ? '•••••••• (saved — paste to replace)'
                  : provider === 'anthropic'
                    ? 'sk-ant-…'
                    : 'sk-… (or the key your provider issues)'
              }
            />
          </label>
          <Button
            variant="primary"
            disabled={!key.trim()}
            onClick={async () => {
              if (provider === 'anthropic') {
                await setAnthropicKey(key);
                setHasAnthropicKey(true);
              } else {
                await setOpenaiKey(key);
                setHasOpenaiKey(true);
              }
              setKey('');
              setStatus('Key saved locally.');
            }}
          >
            Save key
          </Button>
          {hasActiveKey && (
            <Button
              onClick={async () => {
                if (provider === 'anthropic') {
                  await setAnthropicKey('');
                  setHasAnthropicKey(false);
                } else {
                  await setOpenaiKey('');
                  setHasOpenaiKey(false);
                }
                setStatus('Key removed.');
              }}
            >
              Remove
            </Button>
          )}
        </div>

        {provider === 'anthropic' ? (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={anthropicModel}
              onChange={async (e) => {
                setAnthropicModelState(e.target.value);
                await setAnthropicModel(e.target.value);
              }}
              className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
            >
              {ANTHROPIC_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <label className="block max-w-sm grow">
              <span className="mb-1 block text-xs text-slate-400">Base URL</span>
              <TextInput
                value={openaiBaseUrl}
                onChange={(e) => setOpenaiBaseUrlState(e.target.value)}
                onBlur={() => void setOpenaiBaseUrl(openaiBaseUrl)}
                list="openai-base-urls"
              />
              <datalist id="openai-base-urls">
                {OPENAI_COMPAT_PRESETS.map((p) => (
                  <option key={p.baseUrl} value={p.baseUrl}>
                    {p.label}
                  </option>
                ))}
              </datalist>
            </label>
            <label className="block max-w-52">
              <span className="mb-1 block text-xs text-slate-400">Model name</span>
              <TextInput
                value={openaiModel}
                onChange={(e) => setOpenaiModelState(e.target.value)}
                onBlur={() => void setOpenaiModel(openaiModel)}
                placeholder="e.g. gpt-5.1 / gemini-2.5-flash"
              />
            </label>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={
              busy || (provider === 'anthropic' ? !hasActiveKey : !openaiModel.trim())
            }
            onClick={async () => {
              setBusy(true);
              setStatus('Testing…');
              try {
                if (provider === 'openai') {
                  await setOpenaiBaseUrl(openaiBaseUrl);
                  await setOpenaiModel(openaiModel);
                }
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
          Powers “✨ AI course”, “✨ Generate items”, mnemonics, and leech rescue. Calls go
          directly from this browser to the provider; keys are stored only in this browser's
          local database and never included in backups. Custom endpoints must allow browser
          CORS (Ollama: set OLLAMA_ORIGINS).
        </p>
        <p className="text-xs text-slate-500">
          <span className="text-slate-400">Using a ChatGPT/Codex subscription instead of a key?</span>{' '}
          OpenAI's subscription sign-in (Codex OAuth) isn't available to third-party apps — but the
          Codex CLI can drive this app through the srs-mcp server:{' '}
          <code className="text-slate-400">codex mcp add srs -- npx tsx …\srs-mcp\index.ts</code>,
          then ask Codex to build decks and import them from the Inbox. Same for Claude
          subscriptions via Claude Code/Desktop.
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
