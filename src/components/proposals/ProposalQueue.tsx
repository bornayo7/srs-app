import { useState } from 'react';
import { Badge, Button, Panel, Status } from '@/components/ui';
import { CandidateContent } from '@/components/ai/CandidateContent';
import { ProposalEditor } from './ProposalEditor';
import { useOperation } from '@/hooks/useOperation';
import {
  acceptProposals,
  rejectProposals,
  restoreProposals,
  deleteProposals,
} from '@/services/proposals';
import { maybeRefreshSnapshot } from '@/exchange/exchange';
import { now } from '@/services/clock';
import type { ItemType, Proposal, ProposalStatus } from '@/engine/types';

/** The same review queue works with a plan, without a plan, and outside its units. */
export function ProposalQueue({
  proposals,
  types,
  title = 'Drafts to review',
}: {
  proposals: Proposal[];
  types: ItemType[];
  title?: string;
}) {
  const [tab, setTab] = useState<ProposalStatus>('pending');
  const [limit, setLimit] = useState(50);
  const [editing, setEditing] = useState<Proposal | null>(null);
  const operation = useOperation();
  const visible = proposals.filter((p) => p.status === tab);
  const pending = proposals.filter((p) => p.status === 'pending');
  const counts = (status: ProposalStatus) => proposals.filter((p) => p.status === status).length;
  const mutate = (action: () => Promise<void>) =>
    void operation.run(async () => {
      await action();
      await maybeRefreshSnapshot(now());
    });
  const accept = (ids: string[]) =>
    mutate(async () => {
      const result = await acceptProposals(ids, now());
      operation.setMessage(
        `${result.accepted.length} accepted.${result.skipped.length ? ` ${result.skipped.length} held for correction.` : ''} ${result.warnings.join(' ')}`,
      );
    });
  return (
    <Panel title={title}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(['pending', 'rejected', 'accepted'] as const).map((status) => (
          <Button
            key={status}
            variant={tab === status ? 'primary' : 'ghost'}
            aria-pressed={tab === status}
            onClick={() => {
              setTab(status);
              setLimit(50);
            }}
          >
            {status[0].toUpperCase() + status.slice(1)} · {counts(status)}
          </Button>
        ))}
        {tab === 'pending' && pending.length > 0 && (
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            <Button disabled={operation.busy} onClick={() => accept(pending.map((p) => p.id))}>
              Accept all valid
            </Button>
            <Button
              variant="ghost"
              disabled={operation.busy}
              onClick={() => {
                if (confirm(`Reject all ${pending.length} pending drafts in this group?`))
                  mutate(async () => {
                    await rejectProposals(
                      pending.map((p) => p.id),
                      '',
                      now(),
                    );
                    operation.setMessage('Drafts rejected. You can restore them.');
                  });
              }}
            >
              Reject all
            </Button>
          </div>
        )}
      </div>
      <Status {...operation} />
      {visible.length === 0 && (
        <p className="py-4 text-sm text-slate-400">No {tab} drafts in this group.</p>
      )}
      <ul className="space-y-3">
        {visible.slice(0, limit).map((proposal) => {
          const type =
            types.find(
              (t) => t.name.toLocaleLowerCase() === proposal.item.type?.toLocaleLowerCase(),
            ) ?? (types.length === 1 ? types[0] : undefined);
          return (
            <li
              key={proposal.id}
              className="rounded-lg border border-slate-800 bg-slate-950/50 p-4"
            >
              <div className="flex flex-col gap-4 md:flex-row md:justify-between">
                <div className="min-w-0 grow">
                  <CandidateContent item={proposal.item} type={type} />
                  {proposal.item.key || proposal.item.prereqs?.length ? (
                    <p className="mt-2 text-xs text-slate-500">
                      {proposal.item.key ? `Handle: ${proposal.item.key}. ` : ''}
                      {proposal.item.prereqs?.length
                        ? `Builds on: ${proposal.item.prereqs.join(', ')}`
                        : ''}
                    </p>
                  ) : null}
                  {proposal.error && (
                    <p className="mt-2 text-sm text-amber-300">{proposal.error}</p>
                  )}
                  {proposal.duplicateOf && proposal.status === 'pending' && (
                    <p className="mt-2 text-sm text-amber-300">
                      Possibly duplicates an item already in this course. Check its content before
                      accepting.
                    </p>
                  )}
                  {proposal.rejectReason && (
                    <p className="mt-2 text-sm text-rose-300">Rejected: {proposal.rejectReason}</p>
                  )}
                </div>
                <div className="flex flex-wrap items-start gap-2 md:max-w-48 md:justify-end">
                  {proposal.status === 'pending' && (
                    <>
                      <Button
                        variant="primary"
                        disabled={operation.busy}
                        onClick={() => accept([proposal.id])}
                      >
                        Accept
                      </Button>
                      <Button disabled={operation.busy} onClick={() => setEditing(proposal)}>
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={operation.busy}
                        onClick={() => {
                          const reason = prompt(
                            'Why reject this draft? (optional — helps the next draft)',
                            '',
                          );
                          if (reason !== null)
                            mutate(async () => {
                              await rejectProposals([proposal.id], reason, now());
                            });
                        }}
                      >
                        Reject
                      </Button>
                    </>
                  )}
                  {proposal.status === 'rejected' && (
                    <>
                      <Button
                        disabled={operation.busy}
                        onClick={() =>
                          mutate(async () => {
                            await restoreProposals([proposal.id], now());
                          })
                        }
                      >
                        Restore
                      </Button>
                      <Button disabled={operation.busy} onClick={() => setEditing(proposal)}>
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={operation.busy}
                        onClick={() =>
                          mutate(async () => {
                            await deleteProposals([proposal.id]);
                          })
                        }
                      >
                        Delete draft
                      </Button>
                    </>
                  )}
                  {proposal.status === 'accepted' && <Badge color="emerald">Accepted</Badge>}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {visible.length > limit && (
        <Button className="mt-3" onClick={() => setLimit((n) => n + 50)}>
          Show more ({limit} of {visible.length})
        </Button>
      )}
      {editing && (
        <ProposalEditor
          key={editing.id}
          p={editing}
          types={types}
          onClose={() => setEditing(null)}
        />
      )}
    </Panel>
  );
}
