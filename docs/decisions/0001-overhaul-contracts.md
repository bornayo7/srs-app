# Overhaul consistency and portability contracts

Status: accepted during the authorized implementation on 2026-09-08.

## Decision

Keep the pure study engines and make transactional commands own durable invariants. Pair each
card/item/type's monotonic revision with its lifetime identity. Share supported course content
losslessly in format-2 packages, and keep personal progress and device configuration in their
separate full-backup/local settings boundaries.

## Context

Atomic writes alone allowed a stale question to commit after another tab had already answered it.
Timestamps also collide and can return to an old value. Counters alone were insufficient after a
backup restored deleted IDs. Meanwhile, distinct editor/import/AI rules admitted different content,
and course export changed ladders, media and release behavior.

## Alternatives

- A whole-app rewrite would discard working pure grading/scheduling behavior and expand the
  migration surface without solving command ownership.
- Timestamp or counter-only guards permit same-time or restore/deletion replay. A global mutation
  counter would couple every write to shared allocation; per-record versions plus restore generations
  preserve a narrower command interface.
- Restoring old undo permissions could reverse newly restored content from a stale tab. History is
  preserved, while live undo authority and graduated-card tombstones are intentionally discarded.
- A lightweight lossy export would require repeated loss decisions and could produce unstudyable
  copies. Unsupported modes are rejected explicitly instead of silently converted.

## Consequences

- Review, lesson, manual, authoring and AI completion paths validate the observed content version
  inside their write transaction. Content edits invalidate affected prepared questions.
- Backup validation precedes replacement; media encoding and network work happen outside database
  transactions. Local AI keys and destinations, exchange handles and developer clock stay local.
- Daily lesson consumption survives item/type deletion via a ledger; deleting a course removes its
  allowance history. This closes quota bypass through deleting newly learned items.
- Plans have one release owner. Date-only release retains midnight UTC and uses explicit Save.
  Scheduling intervals through 60 minutes keep exact delays; longer stages retain hour alignment.
- The visual default remains dark with a persisted light option. System fonts provide offline
  Japanese/UI rendering without adding remote font requests; the proposed web-font downloads were
  unnecessary for the chosen layout.
- Self/plain-cloze/FSRS/reveal modes remain unsupported. Previously deferred scheduled MCP, attaching
  plans to existing courses, unit reordering, AI distractors and manual-reset ghost policy stay outside
  this repair scope.

Evidence: `src/engine/revision.ts`, `src/services/studyRevision.ts`, `src/db/import.ts`,
`src/db/backupCodec.ts`, `src/packages/schema.ts`, migration/progression/content/portability tests,
and the implementation review and release checklist.
