# Prior audit inventory and corrections for the overhaul plan

Source: the project memory note “SRS App Audit Fix Plan 2026-09-07”, read in full (414 lines / 90,357 bytes) on September 8, 2026. New verification evidence and corrections are in [CODEBASE_REVIEW.md](CODEBASE_REVIEW.md); execution phases are in [OVERHAUL_PLAN.md](OVERHAUL_PLAN.md). This file is an inventory of **historical findings**, not a claim that all 65 were newly re-executed today. It should be used for traceability rather than counted as 65 new findings.

The note has chronological contradictions; its final addendum explicitly supersedes earlier claims. In particular, **SRS-11's blocked-UI mechanism is refuted**: Edit → Save or Reject → Restore clears the stale message without discarding the prerequisite. Residual issue is low-impact hint staleness, not an inaccessible or corrupt proposal. **Card revisions must use a dedicated monotonic `rev`; the old `updatedAt`/`expectedUpdatedAt` plan is superseded.** Keep timestamps for chronology/display. The node tests in the old note used fake IndexedDB/mock providers; previous claims do not establish native multi-tab, IME, browser permissions, real AI or production-host behavior.

Suggested workstreams, adaptable to the execution plan's phase names:

- **A — Trusted persistence:** device configuration, full backup codec, format migrations, graph validation, consistent snapshots.
- **B — Study-state commands:** monotonic revision, atomic course/card/item/log mutations, grading/session behavior, scheduler/calendar invariants.
- **C — Content authoring:** shared type/item validation, safe conversion, draft state and validation, media ownership, recoverable editing.
- **D — Plans and proposals:** atomic unit/release operations, handle identity, queue accessibility, scheduled release and date editing.
- **E — Interchange:** shared packet schema, portable content, adapters, unique files, receipts and retries.
- **F — AI providers:** explicit schema contract, capabilities, result validation, useful errors and bounded retries.
- **G — Release verification:** combined app/MCP checks, clean-install packaging, offline assets and real browser checks.

## All 65 labels, one primary workstream each

| ID | Short issue label from prior audit | Workstream | Qualification / dependency |
|---|---|---|---|
| SRS-01 | Backup repoints AI destination while local key survives | A | Protect configuration bundle; ordinary backup can trigger it |
| SRS-02 | Weak backup schema restores unusable records/links | A | Versioned migration and graph checks before replacement |
| SRS-03 | Stale undo overwrites a later mutation | B | Shared monotonic rev with 05; never restore old rev |
| SRS-04 | Stale plan writes lose edits/generation markers | D | Atomic fresh-state patch, including proposal commit |
| SRS-05 | Same review occurrence committed twice | B | Expected revision mandatory at commit seam |
| SRS-06 | Backup items and media read at different snapshots | A | Capture blobs in read transaction; encode afterward |
| SRS-07 | Proposal queues unreachable without a plan | D | Also proposals at levels not represented by plan units |
| SRS-08 | MCP multi-type plan strips per-item type | E | Derive tool input from canonical item contract |
| SRS-09 | Exported manual/scheduled course cannot advance | E | Portable release policy must be explicit |
| SRS-10 | Reused proposal handle binds nondeterministically | D | Define key identity/scoping; distinguish item IDs |
| SRS-11 | Stale prerequisite hint does not self-heal | D | BLOCKED-UI CLAIM REFUTED; minor UX only |
| SRS-12 | String-only AI/MCP cannot produce sentence-cloze items | E | Type-directed adapter format shared with C/F |
| SRS-13 | Richtext answers require literal markup when typed | C | Normalize richtext only; plain text remains literal |
| SRS-14 | Open app misses scheduled-release boundary | D | Existing reload/mount recovery; prior severity downgraded |
| SRS-15 | Repeated packet import duplicates content | E | Durable receipt + mutation in same transaction |
| SRS-16 | Same-millisecond MCP packet filenames overwrite | E | Full unique ID + atomic publish; do before receipt rollout |
| SRS-17 | Unguarded submissions create duplicates | C | Authoring command design plus narrow UI guard |
| SRS-18 | Item deletion leaves graduated-ghost logs | B | Log ownership by item; migration index if useful |
| SRS-19 | Anki dedupe generates colliding suffixes | E | Reserve emitted names and map by index |
| SRS-20 | Wrap-up count includes answered card twice | B | Session-state invariant, test feedback transition |
| SRS-21 | Undo resurrects ghost for deleted item | B | Ownership/tombstone/revision checks with 18 |
| SRS-22 | Template removal leaves old ghost logs | B | Log lifetime rule with 18, not live-card lookup only |
| SRS-23 | Pending recheck has no production caller | D | Related to refuted 11; avoid redundant stored validation |
| SRS-24 | Overlapping append-unit loses one unit | D | Transactional append plus UI submission state |
| SRS-25 | Add-item failure invisible to user | C | Display durable command errors and keep draft |
| SRS-26 | Archive copy/delete leaves two packet files | E | Import receipt prevents reapplication; archive retry distinct |
| SRS-27 | AI truncation unrecognized, same budget retried | F | Inspect finish/stop reason before parse/retry |
| SRS-28 | Compatibility retries every HTTP 400 | F | Capability-specific fallback, deduplicate variants |
| SRS-29 | MCP-only documented clean install cannot resolve schema's zod | G | Shared package/workspace layout or correct procedure |
| SRS-30 | sql.js wasm absent from offline precache | G | Offline import smoke test and artifact membership check |
| SRS-31 | Manual SRS schedules locked item | B | Validate state transition; one mutation policy |
| SRS-32 | Ladder edit fails to resettle gating | B | Include derived state in command's atomic outcome |
| SRS-33 | Empty answers persisted by editor/conversion | C | Same validator as import, plus repairable invalid state |
| SRS-34 | Async editor patches overwrite newer typing | C | Functional reducer/latest-draft patch; request identity |
| SRS-35 | Type deletion/re-kind leaks media blobs | C | Media ownership within content-change command |
| SRS-36 | Lesson limit enforced only by caller | B | Transactional daily allowance; durable completion facts |
| SRS-37 | Hour flooring shortens short-stage delays | B | Decide minute/hour scheduling policy; boundary sweeps |
| SRS-38 | Plan creation hides missing-date warnings | D | Outline validation and warnings before committing |
| SRS-39 | Japanese choice fallback and kanji cloze produce free retries | B | Narrowed today: kana-only sentence cloze correctly penalizes wrong kana; decouple input and grading policy |
| SRS-40 | Kana choice distractors removed; typed fallback lacks kana IME | B | Same grading policy seam as 39 |
| SRS-41 | Text/list-to-cloze conversion drops valid content with bad line | C | Preserve source and make conversion loss reviewable |
| SRS-42 | Failed media upload leaves editor unable to save | C | Per-field recoverable validation state |
| SRS-43 | Set-stage placeholder coerces to stage zero | C | Explicit no-selection state, no numeric coercion |
| SRS-44 | Add-item submit ignores field parse error | C | Preserve invalid raw draft and prevent commit |
| SRS-45 | Duplicate type names misroute generated items | C | Unique canonical lookup identity per course |
| SRS-46 | Date keystrokes irreversibly release units | D | Draft date, strict validation, explicit commit |
| SRS-47 | Deleted accepted-prereq target aborts accept batch | D | Resolve handles against current live items |
| SRS-48 | Invalid date persists NaN and crashes plan rendering | D | Shared date value/codec, reject before write |
| SRS-49 | Media hook displays prior item's URL during load | C | URL state keyed by media identity |
| SRS-50 | Fractional lesson cap fails after expensive outline creation | D | Validate setup before AI call and at commit |
| SRS-51 | AI correction echoes truncated 4k JSON fragment | F | Structured output or useful bounded correction context |
| SRS-52 | Root schema mismatch correction gives no shape information | F | Transmit schema, structured problem paths |
| SRS-53 | Fence parser cuts JSON at embedded triple backticks | F | Parse raw JSON first; strip only enclosing fence |
| SRS-54 | Connection check accepts empty successful HTTP response | F | Require semantically valid nonempty response |
| SRS-55 | Forecast calendar bins drift across DST | B | Iterate calendar dates, not fixed 24h increments |
| SRS-56 | Root validation excludes MCP subproject | G | One verification entry point includes both artifacts |
| SRS-57 | Date-write promise failure not surfaced | D | Common async operation/result handling |
| SRS-58 | Proposal editor's shared error slot hides other invalid field | C | Per-field validation keyed to raw draft |
| SRS-59 | Empty-answer card wedges review and lesson queue | B | Quarantine/repair flow; do not silently miscount/drop |
| SRS-60 | Persistent-storage request latches and returns false success | A | Expose actual persistence status, allow retry |
| SRS-61 | Direct type creation bypasses type validator | C | One canonical mutation seam applies validation |
| SRS-62 | Deleting last gate type changes rule to all types | B | Explicit gate policy; preview consequential change |
| SRS-63 | Stale clock tick hides completed lessons from daily count | B | Atomic allowance from authoritative clock/durable facts |
| SRS-64 | Outline validation misses duplicate templates | D | Reuse canonical schema/semantic validator |
| SRS-65 | Bulk AI leech rescue overwrites handwritten notes | C | Candidate review/undo; user-authored note ownership |

## Fix prescriptions that need correction before implementation

1. **Revision design:** early lines 34–36,113–120 use `updatedAt` and legacy `log.ts`. Lines 290–300 supersede them with `rev`. Use an actual revision on every mutation, including undo, migration/remap, new-card lifecycle and ghost resurrection. A legacy log lacking trustworthy revision evidence must not gain undo authority through a timestamp fallback. Adding a non-indexed property does not intrinsically require a Dexie index schema change, but a versioned data backfill is useful; combine related migrations once.
2. **Contradictory backup behavior:** line 101 defaults a missing `grading` to typed and calls that “historically legitimate,” while line 110 demands a grading-less template be rejected. Resolve this using actual versioned historical fixtures, not a guessed historical promise. Choose rejection or migration by source format/version and then make tests agree. Catchall extras cannot replace validation of required values, ranges, uniqueness or ownership.
3. **Non-atomic generation completion:** lines 123–126 propose a pre-apply existence check and a separate plan patch after `applyPacket`. This leaves a time-of-check race and can commit proposals before the stamp fails. Put current-plan recheck, proposal ingestion and targeted marker update behind one transaction after the network request; detect an incompatible plan revision explicitly.
4. **Do not implement SRS-11's old proposal-hold model as a blocker:** its major claimed failure is refuted. Adding `error` + `hold` + multiple sweeping passes risks more stale derived state. Derive resolution at acceptance and use an explicit result to explain pending dependencies; a refreshable hint can remain a small presentation improvement.
5. **Avoid caller-owned re-gating/media ordering:** SRS-32 says caller should recompute after save, and SRS-35 says post-commit media cleanup. The overhaul should make command outcomes own invariants; otherwise failures still leave half-applied states. Separate blob encoding/AI I/O from transactions, but keep related durable row changes atomic wherever possible.
6. **Do not silently discard content to fix SRS-41:** keeping only parseable lines still loses the invalid raw source. Preserve source and show a conversion impact/candidate review. Similarly, skipping an invalid empty-answer card (33/59) must report a repairable item and consistent due counts, not make data invisibly disappear.
7. **Export is a product contract, not just a one-line omission:** SRS-09 chooses self-releasing copies and no plan export. That is a proposed policy, not an established lossless guarantee. The broader export already changes media/grading/ladder semantics. Define portable content and report unsupported/lost behavior, or version the format to preserve it. Avoid silently changing the recipient's release model while labeling the export equivalent.
8. **File safety needs publication semantics:** SRS-16's `wx` prevents overwrite but still exposes a partly written JSON file to browser scan. Write a temporary non-JSON file and publish atomically with a full unique ID. `{id,...packet}` lets a supplied packet ID override the generated one; establish the authoritative ID after parsing and preserve it consistently. Do not unnecessarily reduce UUID filenames to 8 characters. Receipts should retain a payload digest so ID reuse with different content is a visible conflict, not silent dedupe.
9. **AI capabilities depend on endpoint and model:** the last paragraph's claim that every preset provider supports structured outputs is too broad to treat as an invariant, especially arbitrary self-hosted models/proxies. Verify advertised/requested capability and use a schema-bearing fallback. Sending schema does not remove the need to handle refusal, length and empty results. A generic regex for refusal prose is not reliable provider semantics.
10. **Date fixes need calendar semantics:** a four-digit regex accepts `0002-09-15` and impossible dates; `Date.parse` can normalize invalid calendar days. Draft then commit is necessary but not sufficient. Define date-only local/UTC semantics once, validate calendar validity/range, and feed every editor/import/release/watch path through it. The old “no timezone change” note preserves behavior, not necessarily the intended user calendar.
11. **SRS-37's proposed `<60` exception leaves its own one-hour example unresolved:** decide which intervals intentionally round to an hour and whether they may shrink to one minute. Test the selected policy at minute 00/23/40/59 and daylight-saving boundaries rather than blindly changing one comparator.
12. **Some proposed tests are brittle or narrow:** precache must contain the emitted wasm path; it need not contain exactly 13 entries forever. Provider-module mocks do not validate adapter requests. A pure busy-flag helper test does not show React event wiring. Prefer command/adapter integration and a few real browser flows at the same Interface users cross.

## Scope and preserved exclusions

- The prior note's final declared gap was complete reads of Dashboard, InboxPage and CoursePage; the current UI agent closes that gap. Do not carry it forward unchanged.
- The original “two missing bugs” are documented as already fixed in the project state note, not still unidentified blockers.
- Reset/suspend leaving ghost drills alive was explicitly known and deliberately deferred. It is not a newly discovered bug requiring unsolicited policy change.
- Scheduled MCP, attaching a plan to an existing course, unit reordering, and AI-written distractors are separately deferred/product-scope choices. An overhaul should not quietly add them as audit fixes.
- Historical counts such as 64 open defects mix issue IDs, subordinate symptoms and one refuted load-bearing claim. Group by root cause and preserve label traceability; do not advertise a count of newly verified distinct defects without re-executing and deduplicating them.
