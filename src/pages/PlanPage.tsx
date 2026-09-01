import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { Badge, Button, Field, Modal, Panel, Select, TextArea, TextInput } from '@/components/ui';
import { FieldValueInput } from '@/components/editor/FieldValueInput';
import { RELEASE_MODES } from '@/components/ai/PlanCoursePanel';
import { aiErrorMessage } from '@/ai/client';
import { generateUnitItems } from '@/ai/plan';
import { useAiReady } from '@/hooks/useAiReady';
import { useNowTick } from '@/hooks/useNowTick';
import { proposalsForCourse } from '@/db/repo/proposals';
import { isClozeSentences } from '@/engine/grading/cloze';
import type {
  FieldValue,
  ItemType,
  PlanReleaseMode,
  Proposal,
  ProposalItem,
  ProposalStatus,
} from '@/engine/types';
import {
  acceptAllValid,
  acceptProposals,
  deleteProposals,
  rejectProposals,
  restoreProposals,
  updateProposalItem,
  type AcceptResult,
} from '@/services/proposals';
import {
  appendUnit,
  planProgress,
  releaseNextUnit,
  setReleaseMode,
  syncScheduledRelease,
  updateUnit,
  type UnitProgress,
} from '@/services/plans';
import { now } from '@/services/clock';
import { maybeRefreshSnapshot } from '@/exchange/exchange';

// Dates on units are date-only (UTC midnight) — render them in UTC so a US
// evening doesn't show the day before.
const dateInputValue = (ms?: number) => (ms === undefined ? '' : new Date(ms).toISOString().slice(0, 10));
const formatDate = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });

function fieldText(v: FieldValue | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  if (isClozeSentences(v)) return `${v.length} sentence${v.length === 1 ? '' : 's'}`;
  return (v as string[]).join(', ');
}

function typeFor(p: Proposal, types: ItemType[]): ItemType | undefined {
  if (!p.item.type) return types.length === 1 ? types[0] : undefined;
  return types.find((t) => t.name.toLowerCase() === p.item.type!.toLowerCase());
}

/** Field values keyed by the type's canonical field names (packet fields are name-keyed, any case). */
function byCanonicalName(fields: Record<string, FieldValue>, type: ItemType | undefined): Record<string, FieldValue> {
  if (!type) return { ...fields };
  const lower = new Map(Object.entries(fields).map(([k, v]) => [k.toLowerCase(), v]));
  const out: Record<string, FieldValue> = {};
  for (const f of type.fields) {
    const v = lower.get(f.name.toLowerCase());
    if (v !== undefined) out[f.name] = v;
  }
  return out;
}

function synonymsByTemplate(
  syn: ProposalItem['synonyms'],
  type: ItemType | undefined,
): Record<string, string> {
  if (!syn || !type) return {};
  if (Array.isArray(syn)) return type.templates[0] ? { [type.templates[0].name]: syn.join(', ') } : {};
  const out: Record<string, string> = {};
  for (const tpl of type.templates) {
    const entry = Object.entries(syn).find(([k]) => k.toLowerCase() === tpl.name.toLowerCase());
    if (entry) out[tpl.name] = entry[1].join(', ');
  }
  return out;
}

const splitList = (raw: string) =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Edit a proposal before accepting it — fields, alternates, mnemonic, prerequisite handles. */
function ProposalEditor({
  p,
  types,
  onClose,
}: {
  p: Proposal;
  types: ItemType[];
  onClose: () => void;
}) {
  const initialType = typeFor(p, types) ?? types[0];
  const [typeId, setTypeId] = useState(initialType?.id ?? '');
  const type = types.find((t) => t.id === typeId) ?? initialType;
  const [fields, setFields] = useState<Record<string, FieldValue>>(() =>
    byCanonicalName(p.item.fields, initialType),
  );
  const [synonyms, setSynonyms] = useState<Record<string, string>>(() =>
    synonymsByTemplate(p.item.synonyms, initialType),
  );
  const [note, setNote] = useState(p.item.note ?? '');
  const [key, setKey] = useState(p.item.key ?? '');
  const [prereqs, setPrereqs] = useState((p.item.prereqs ?? []).join(', '));
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!type) return null;

  async function save() {
    if (!type) return;
    if (fieldError) {
      setError(fieldError);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const present = Object.entries(fields).filter(([, v]) =>
        typeof v === 'string' ? v.trim().length > 0 : v.length > 0,
      );
      const synRecord = Object.fromEntries(
        Object.entries(synonyms)
          .map(([tpl, raw]) => [tpl, splitList(raw)] as const)
          .filter(([, list]) => list.length > 0),
      );
      const prereqList = splitList(prereqs);
      const item: ProposalItem = {
        type: type.name,
        fields: Object.fromEntries(present),
        ...(key.trim() ? { key: key.trim() } : {}),
        ...(prereqList.length > 0 ? { prereqs: prereqList } : {}),
        ...(Object.keys(synRecord).length > 0 ? { synonyms: synRecord } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      };
      await updateProposalItem(p.id, item, now());
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Edit proposal"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {types.length > 1 && (
          <Field label="Item type">
            <Select
              value={type.id}
              onChange={(e) => {
                const next = types.find((t) => t.id === e.target.value);
                setTypeId(e.target.value);
                setFields(byCanonicalName(fields, next));
                setSynonyms({});
              }}
            >
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.icon} {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          {type.fields.map((f) => (
            <Field
              key={f.id}
              label={f.name}
              className={f.kind === 'clozeSentences' || f.kind === 'richtext' ? 'sm:col-span-2' : ''}
            >
              <FieldValueInput
                field={f}
                value={fields[f.name]}
                onChange={(v) => setFields({ ...fields, [f.name]: v })}
                onError={(msg) => setFieldError(msg ? `${f.name}: ${msg}` : null)}
              />
            </Field>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {type.templates.map((tpl) => (
            <Field key={tpl.id} label={`Also accept for “${tpl.name}” (comma-separated)`}>
              <TextInput
                value={synonyms[tpl.name] ?? ''}
                onChange={(e) => setSynonyms({ ...synonyms, [tpl.name]: e.target.value })}
              />
            </Field>
          ))}
        </div>
        <Field label="Note / mnemonic">
          <TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Handle (so later items can build on this one)" hint="Letters, digits, dashes.">
            <TextInput value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <Field
            label="Builds on (handles, comma-separated)"
            hint="Stays locked until those items pass. Must already be accepted."
          >
            <TextInput value={prereqs} onChange={(e) => setPrereqs(e.target.value)} />
          </Field>
        </div>
        {error && <p className="text-sm text-rose-300">{error}</p>}
      </div>
    </Modal>
  );
}

function ProposalRow({
  p,
  type,
  duplicateName,
  busy,
  onAccept,
  onReject,
  onRestore,
  onEdit,
  onDelete,
}: {
  p: Proposal;
  type: ItemType | undefined;
  duplicateName: string | null;
  busy: boolean;
  onAccept: () => void;
  onReject: (reason: string) => void;
  onRestore: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const fields = byCanonicalName(p.item.fields, type);
  const entries = Object.entries(Object.keys(fields).length > 0 ? fields : p.item.fields);
  const synonymList = Array.isArray(p.item.synonyms)
    ? p.item.synonyms
    : p.item.synonyms
      ? Object.values(p.item.synonyms).flat()
      : [];
  const tone =
    p.status === 'rejected'
      ? 'border-rose-900/60 bg-rose-950/10 opacity-70'
      : p.status === 'accepted'
        ? 'border-emerald-900/60 bg-emerald-950/10 opacity-80'
        : p.error
          ? 'border-amber-900 bg-amber-950/10'
          : 'border-slate-800 bg-slate-950/50';

  return (
    <li className={`rounded-lg border px-3 py-2 ${tone}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-sm">
          <div className="text-slate-200">
            {type && type.name !== entries[0]?.[0] && (
              <span className="mr-1.5 text-xs text-slate-500">{type.icon || type.name}</span>
            )}
            {entries.map(([name, v], i) => (
              <span key={name}>
                {i > 0 && <span className="text-slate-600"> · </span>}
                <span className="text-slate-500">{name}: </span>
                {fieldText(v)}
              </span>
            ))}
          </div>
          {synonymList.length > 0 && (
            <div className="text-xs text-slate-500">also: {synonymList.join(', ')}</div>
          )}
          {p.item.note && <div className="text-xs text-violet-300/80">💡 {p.item.note}</div>}
          {(p.item.key || (p.item.prereqs?.length ?? 0) > 0) && (
            <div className="text-[11px] text-slate-500">
              {p.item.key && <span className="mr-2">[{p.item.key}]</span>}
              {(p.item.prereqs?.length ?? 0) > 0 && <span>builds on {p.item.prereqs!.join(', ')}</span>}
            </div>
          )}
          {p.error && <div className="text-xs text-amber-300">⚠ {p.error}</div>}
          {duplicateName && p.status === 'pending' && (
            <div className="text-xs text-amber-300">≈ possibly a duplicate of “{duplicateName}”</div>
          )}
          {p.status === 'rejected' && p.rejectReason && (
            <div className="text-xs text-rose-300">rejected: {p.rejectReason}</div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {p.status === 'pending' && !rejecting && (
            <>
              <Button variant="primary" disabled={busy || !!p.error} onClick={onAccept} title={p.error ? 'Fix the problem first (Edit)' : 'Add to the course'}>
                Accept
              </Button>
              <Button variant="ghost" disabled={busy} onClick={onEdit}>
                Edit
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setRejecting(true)}>
                Reject
              </Button>
            </>
          )}
          {p.status === 'pending' && rejecting && (
            // a form so Enter submits natively — the reason is optional
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                onReject(reason);
                setRejecting(false);
              }}
            >
              <TextInput
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setRejecting(false);
                }}
                placeholder="why? (optional — steers the next draft)"
                className="max-w-56"
              />
              <Button type="submit" variant="danger" disabled={busy}>
                Reject
              </Button>
              <Button type="button" variant="ghost" onClick={() => setRejecting(false)}>
                ✕
              </Button>
            </form>
          )}
          {p.status === 'rejected' && (
            <>
              <Button disabled={busy} onClick={onRestore}>
                Restore
              </Button>
              <Button variant="ghost" disabled={busy} onClick={onEdit}>
                Edit
              </Button>
              <Button variant="ghost" disabled={busy} onClick={onDelete} title="Forget this proposal">
                ✕
              </Button>
            </>
          )}
          {p.status === 'accepted' && <Badge color="emerald">accepted</Badge>}
        </div>
      </div>
    </li>
  );
}

function UnitCard({
  unit,
  courseId,
  releaseMode,
  proposals,
  types,
  itemNameById,
  aiReady,
  say,
}: {
  unit: UnitProgress;
  courseId: string;
  releaseMode: PlanReleaseMode;
  proposals: Proposal[];
  types: ItemType[];
  itemNameById: Map<string, string>;
  aiReady: boolean | undefined;
  say: (msg: string) => void;
}) {
  const [open, setOpen] = useState(unit.current || unit.pending > 0);
  const [tab, setTab] = useState<ProposalStatus>('pending');
  const [count, setCount] = useState(unit.targetCount || 10);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Proposal | null>(null);
  const [error, setError] = useState('');

  const visible = proposals.filter((p) => p.status === tab);
  const counts: Record<ProposalStatus, number> = {
    pending: unit.pending,
    accepted: unit.accepted,
    rejected: unit.rejected,
  };

  async function run(label: string, fn: () => Promise<string | null>) {
    setBusy(true);
    setError('');
    try {
      const msg = await fn();
      if (msg) say(`${label}: ${msg}`);
      void maybeRefreshSnapshot(now());
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const describeAccept = (res: AcceptResult): string => {
    const parts = [`${res.accepted.length} accepted`];
    if (res.skipped.length > 0) parts.push(`${res.skipped.length} held (see the row)`);
    return [parts.join(', '), ...res.warnings].join(' ');
  };

  const status = unit.released ? (
    unit.current ? (
      <Badge color="violet">current unit</Badge>
    ) : (
      <Badge color="emerald">released</Badge>
    )
  ) : (
    <Badge>
      🔒 {unit.releaseAt !== undefined && releaseMode === 'schedule' ? `opens ${formatDate(unit.releaseAt)}` : 'locked'}
    </Badge>
  );

  return (
    <Panel
      title={
        <button className="text-left hover:text-slate-100" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} Unit {unit.level} · {unit.title}
        </button>
      }
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          {unit.pending > 0 && <Badge color="sky">{unit.pending} to review</Badge>}
          <span className="text-xs text-slate-500">
            {unit.items} item{unit.items === 1 ? '' : 's'}
            {unit.items > 0 ? ` · ${unit.passed} passed` : ''}
          </span>
          {status}
        </div>
      }
    >
      {open && (
        <div className="space-y-3">
          {(unit.summary || unit.topics.length > 0) && (
            <div className="text-sm text-slate-400">
              {unit.summary && <p>{unit.summary}</p>}
              {unit.topics.length > 0 && (
                <p className="mt-1 text-xs text-slate-500">{unit.topics.join(' · ')}</p>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-end gap-2">
            {releaseMode === 'schedule' && (
              <Field label="Opens on">
                <TextInput
                  type="date"
                  value={dateInputValue(unit.releaseAt)}
                  onChange={(e) => {
                    const ms = e.target.value ? Date.parse(e.target.value) : undefined;
                    void updateUnit(courseId, unit.level, { releaseAt: ms }, now());
                  }}
                  className="max-w-40"
                />
              </Field>
            )}
            <Field label="Draft how many">
              <TextInput
                type="number"
                min={1}
                max={60}
                value={count}
                onChange={(e) => setCount(Math.min(60, Math.max(1, +e.target.value || 1)))}
                className="max-w-20"
              />
            </Field>
            <Field label="Steer (optional)" className="min-w-56 grow">
              <TextInput
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="“more formulas”, “replace the ones I rejected”, “only chapter 3”"
              />
            </Field>
            <Button
              variant="primary"
              disabled={busy || aiReady !== true}
              title={aiReady === false ? 'Add an API key in Settings → AI' : undefined}
              onClick={() =>
                void run('Draft', async () => {
                  const res = await generateUnitItems(courseId, unit.level, { count, instruction }, now());
                  setTab('pending');
                  setOpen(true);
                  return `${res.proposalsAdded} item(s) drafted for review.${res.warnings.length ? ` ${res.warnings.join(' ')}` : ''}`;
                })
              }
            >
              {busy ? 'Working…' : unit.generatedAt ? '✨ Draft more' : '✨ Draft items'}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3">
            {(['pending', 'rejected', 'accepted'] as ProposalStatus[]).map((s) => (
              <button
                key={s}
                onClick={() => setTab(s)}
                className={`rounded-md px-2 py-1 text-xs ${tab === s ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}
              >
                {s} · {counts[s]}
              </button>
            ))}
            <div className="grow" />
            {tab === 'pending' && unit.pending > 0 && (
              <Button
                disabled={busy}
                onClick={() =>
                  void run('Accept all', async () => describeAccept(await acceptAllValid(courseId, now(), unit.level)))
                }
              >
                Accept all valid
              </Button>
            )}
            {tab === 'pending' && unit.pending > 0 && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (!confirm(`Reject all ${unit.pending} pending proposals in this unit?`)) return;
                  void run('Reject all', async () => {
                    const n = await rejectProposals(
                      visible.map((p) => p.id),
                      '',
                      now(),
                    );
                    return `${n} rejected.`;
                  });
                }}
              >
                Reject all
              </Button>
            )}
          </div>

          {visible.length === 0 && (
            <p className="text-sm text-slate-500">
              {tab === 'pending'
                ? unit.generatedAt
                  ? 'Nothing waiting — draft more, or move on.'
                  : 'Nothing drafted yet — press “Draft items” to have the AI propose this unit’s items.'
                : `No ${tab} proposals.`}
            </p>
          )}
          {visible.length > 0 && (
            <ul className="space-y-1.5">
              {visible.map((p) => (
                <ProposalRow
                  key={p.id}
                  p={p}
                  type={typeFor(p, types)}
                  duplicateName={p.duplicateOf ? (itemNameById.get(p.duplicateOf) ?? null) : null}
                  busy={busy}
                  onAccept={() => void run('Accept', async () => describeAccept(await acceptProposals([p.id], now())))}
                  onReject={(reason) => void run('Reject', async () => (await rejectProposals([p.id], reason, now())) ? null : 'nothing changed')}
                  onRestore={() => void run('Restore', async () => (await restoreProposals([p.id], now())) ? null : 'nothing changed')}
                  onEdit={() => setEditing(p)}
                  onDelete={() => void run('Delete', async () => (await deleteProposals([p.id]), null))}
                />
              ))}
            </ul>
          )}
          {error && <p className="text-sm text-rose-300">{error}</p>}
        </div>
      )}
      {editing && <ProposalEditor p={editing} types={types} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

export default function PlanPage() {
  const { courseId } = useParams<{ courseId: string }>();
  const t = useNowTick(60_000);
  const aiReady = useAiReady();
  const progress = useLiveQuery(() => (courseId ? planProgress(courseId) : null), [courseId, t]);
  const proposals = useLiveQuery(() => (courseId ? proposalsForCourse(courseId) : []), [courseId]);
  const types = useLiveQuery(
    () => (courseId ? db.itemTypes.where('courseId').equals(courseId).toArray() : []),
    [courseId],
  );
  const items = useLiveQuery(
    () => (courseId ? db.items.where('courseId').equals(courseId).toArray() : []),
    [courseId],
  );
  const [log, setLog] = useState<string[]>([]);
  const [newUnit, setNewUnit] = useState('');
  const [busy, setBusy] = useState(false);
  const say = (msg: string) => setLog((l) => [msg, ...l].slice(0, 6));

  // schedule mode: catch up with the calendar whenever the page is opened
  useEffect(() => {
    if (courseId) void syncScheduledRelease(courseId, now()).catch(() => undefined);
  }, [courseId]);

  if (progress === undefined || !proposals || !types || !items) {
    return <p className="py-16 text-center text-slate-500">Loading plan…</p>;
  }
  if (progress === null) {
    return (
      <div className="py-16 text-center">
        <p className="text-slate-300">This course has no plan.</p>
        <Link to={courseId ? `/course/${courseId}` : '/'} className="mt-3 inline-block">
          <Button>Back</Button>
        </Link>
      </div>
    );
  }

  const { plan, course, units, pendingTotal } = progress;
  const atLast = course.currentLevel >= plan.units.length;
  const itemNameById = new Map<string, string>();
  const typeById = new Map(types.map((ty) => [ty.id, ty]));
  for (const it of items) {
    const ty = typeById.get(it.typeId);
    const first = ty?.fields.find((f) => f.kind !== 'image' && f.kind !== 'audio');
    if (first) itemNameById.set(it.id, fieldText(it.fieldValues[first.id]));
  }
  const undated = plan.releaseMode === 'schedule' ? units.filter((u) => u.releaseAt === undefined).length : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-100">{course.name}</h1>
          <p className="text-sm text-slate-500">
            Course plan · unit {course.currentLevel} of {plan.units.length} open
            {pendingTotal > 0 ? ` · ${pendingTotal} proposal${pendingTotal === 1 ? '' : 's'} to review` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/course/${course.id}`}>
            <Button>Course</Button>
          </Link>
          <Link to={`/lessons/${course.id}`}>
            <Button>Lessons</Button>
          </Link>
          <Link to={`/review/${course.id}`}>
            <Button variant="primary">Reviews</Button>
          </Link>
        </div>
      </div>

      <Panel title="Release">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Units open">
            <Select
              value={plan.releaseMode}
              disabled={busy}
              onChange={(e) => {
                const mode = e.target.value as PlanReleaseMode;
                setBusy(true);
                void setReleaseMode(course.id, mode, now())
                  .then(() => say(`Release mode: ${RELEASE_MODES.find((m) => m.id === mode)?.label ?? mode}.`))
                  .catch((err) => say((err as Error).message))
                  .finally(() => setBusy(false));
              }}
            >
              {RELEASE_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            disabled={busy || atLast}
            title={atLast ? 'Every unit is open' : `Open unit ${course.currentLevel + 1} now`}
            onClick={() => {
              setBusy(true);
              void releaseNextUnit(course.id, now())
                .then((lvl) => say(lvl ? `Unit ${lvl} released — its accepted items are in the lesson queue.` : 'Nothing to release.'))
                .catch((err) => say((err as Error).message))
                .finally(() => setBusy(false));
            }}
          >
            Release next unit →
          </Button>
          <p className="text-xs text-slate-500">
            {RELEASE_MODES.find((m) => m.id === plan.releaseMode)?.hint}
            {undated > 0 ? ` ${undated} unit(s) have no date and will only open by hand.` : ''}
          </p>
        </div>
        {plan.materialTruncated && (
          <p className="mt-2 text-xs text-amber-300">
            The saved material was cut at the length cap — later units are drafted from what was kept.
          </p>
        )}
      </Panel>

      {units.map((u) => (
        <UnitCard
          key={u.level}
          unit={u}
          courseId={course.id}
          releaseMode={plan.releaseMode}
          proposals={proposals.filter((p) => p.level === u.level)}
          types={types}
          itemNameById={itemNameById}
          aiReady={aiReady}
          say={say}
        />
      ))}

      <Panel title="Add a unit">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newUnit.trim()) return;
            void appendUnit(course.id, { title: newUnit.trim(), summary: '', topics: [], targetCount: 10 }, now())
              .then((u) => {
                say(`Unit ${u.level} “${u.title}” added.`);
                setNewUnit('');
              })
              .catch((err) => say((err as Error).message));
          }}
        >
          <TextInput
            value={newUnit}
            onChange={(e) => setNewUnit(e.target.value)}
            placeholder="Unit title (it becomes the next level)"
            className="max-w-sm"
          />
          <Button type="submit" disabled={!newUnit.trim()}>
            + Add unit
          </Button>
        </form>
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
