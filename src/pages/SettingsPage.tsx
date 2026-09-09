import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { isStoragePersisted, requestPersistentStorage } from '@/db/db';
import { Badge, Button, Modal, Panel, Status } from '@/components/ui';
import { AiSettings } from '@/components/settings/AiSettings';
import { useOperation } from '@/hooks/useOperation';
import { exportAll, downloadBackup } from '@/db/export';
import { decodeBackup, importAll, resetStudyData } from '@/db/import';
import { mediaUsage, purgeOrphanMedia } from '@/services/media';
import { formatBytes } from '@/engine/image';
import { clockOffset, now, setClockOffset } from '@/services/clock';
import { DAY, HOUR, formatDuration } from '@/engine/time';
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
        Shifts the app clock (dev builds only) so you can walk items up the ladder without waiting.
        App time: {new Date(now()).toLocaleString()}
      </p>
    </Panel>
  );
}

export default function SettingsPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const operation = useOperation();
  const [storageRevision, setStorageRevision] = useState(0);
  const persisted = useLiveQuery(() => isStoragePersisted(), [storageRevision]);
  const media = useLiveQuery(() => mediaUsage(), []);
  const [candidate, setCandidate] = useState<{
    raw: unknown;
    courses: number;
    items: number;
  } | null>(null);
  const persistenceSupported = typeof navigator.storage?.persist === 'function';
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <h1 className="text-2xl font-semibold text-slate-100">Settings</h1>
      <Status {...operation} />
      <Panel title="Backups and recovery">
        <div className="flex flex-wrap gap-3">
          <Button
            variant="primary"
            disabled={operation.busy}
            onClick={() =>
              void operation.run(
                async () => downloadBackup(await exportAll(now())),
                'Backup downloaded.',
              )
            }
          >
            Download backup
          </Button>
          <Button disabled={operation.busy} onClick={() => fileRef.current?.click()}>
            Restore from backup
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Choose a study backup"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file)
                void operation.run(async () => {
                  const raw: unknown = JSON.parse(await file.text());
                  const decoded = decodeBackup(raw);
                  setCandidate({
                    raw,
                    courses: decoded.data.courses.length,
                    items: decoded.data.items.length,
                  });
                });
            }}
          />
        </div>
        <p className="mt-3 text-sm text-slate-500">
          Backups include your courses, review history and media. Download one regularly so your
          learning has a second home.
        </p>
      </Panel>
      {candidate && (
        <Modal
          title="Restore study backup"
          onClose={() => {
            if (!operation.busy) setCandidate(null);
          }}
          footer={
            <>
              <Button disabled={operation.busy} onClick={() => setCandidate(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={operation.busy}
                onClick={() =>
                  void operation.run(async () => {
                    await importAll(candidate.raw);
                    setCandidate(null);
                  }, 'Study backup restored.')
                }
              >
                Replace study data
              </Button>
            </>
          }
        >
          <p>
            This validated backup contains {candidate.courses} courses and {candidate.items} items.
            Restoring replaces your current courses and history. Your provider settings and
            assistant connection stay on this device.
          </p>
          <Button
            className="mt-4"
            disabled={operation.busy}
            onClick={() =>
              void operation.run(
                async () => downloadBackup(await exportAll(now())),
                'Current backup downloaded.',
              )
            }
          >
            Download current data first
          </Button>
          <Status {...operation} />
        </Modal>
      )}
      <AiSettings />
      <Panel title="Browser storage">
        <div className="flex flex-wrap items-center gap-3">
          <Badge color={persisted ? 'emerald' : 'amber'}>
            {persisted === undefined
              ? 'Checking storage…'
              : persisted === true
                ? 'Persistence granted'
                : persisted === false
                  ? 'Persistence not granted'
                  : 'Persistence status unavailable'}
          </Badge>
          {persisted !== true && persistenceSupported && (
            <Button
              disabled={operation.busy}
              onClick={() =>
                void operation.run(async () => {
                  const granted = await requestPersistentStorage();
                  setStorageRevision((v) => v + 1);
                  operation.setMessage(
                    granted
                      ? 'Browser storage persistence granted.'
                      : 'The browser did not grant persistence. Keep a downloaded backup.',
                  );
                })
              }
            >
              Request persistence
            </Button>
          )}
        </div>
        {!persistenceSupported && (
          <p className="mt-3 text-sm text-slate-500">
            This browser does not offer a persistence request. Study still works; keep a downloaded
            backup.
          </p>
        )}
        {!!media?.count && (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-800 pt-3">
            <span className="text-sm">
              {media.count} media files · {formatBytes(media.bytes)}
            </span>
            <Button
              disabled={operation.busy}
              onClick={() =>
                void operation.run(async () => {
                  const removed = await purgeOrphanMedia();
                  operation.setMessage(
                    removed
                      ? `${removed} unused media files removed.`
                      : 'All media files are in use.',
                  );
                })
              }
            >
              Clean up unused media
            </Button>
          </div>
        )}
      </Panel>
      <TimeTravelPanel />
      <Panel title="Reset study data">
        <p className="mb-3 text-sm text-slate-400">
          Delete courses, items, captures and review history. Your provider settings and assistant
          connection are kept.
        </p>
        <Button
          variant="danger"
          disabled={operation.busy}
          onClick={() => {
            if (confirm('Delete all study data on this device? Download a backup first.'))
              void operation.run(async () => {
                await resetStudyData();
                location.assign('/');
              });
          }}
        >
          Reset study data
        </Button>
      </Panel>
    </div>
  );
}
