# Proposed SRS overhaul plan

Status: historical plan from the September 8 review, subsequently authorized and implemented on `codex/srs-overhaul`. The proposal text below is preserved as the planning record. Read [IMPLEMENTATION_REVIEW.md](IMPLEMENTATION_REVIEW.md) for actual outcomes and adjustments, [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md) for acceptance evidence and remaining platform qualifications, and [the accepted ADR](decisions/0001-overhaul-contracts.md) for decisions made during implementation.

## Objective and evidence

Make the existing local-first study app dependable, understandable and comfortable for Japanese study and academic coursework while preserving its learning flexibility. Retain the useful pure scheduling, grading, gating, time, parsing and presentation calculations; replace orchestration that spreads consistency rules across stores, pages, repository helpers and import producers. A wholesale rewrite would discard tested behavior before the risky parts were understood.

The current baseline passes 236 tests across 22 files and builds successfully. That baseline does not establish correctness: additional out-of-tree tests reproduced invalid backup restores, credential/destination mixing, concurrent plan changes being lost, blank-prompt imports, Anki naming collisions, stale review/undo writes, grading mistakes and proposal acceptance failures. Browser checks reproduced a stale cloze draft being saved, inaccessible modal focus behavior and horizontal overflow at 320px. Production builds also expose browser-externalized provider dependencies and a large initial bundle; these require examination, not suppressed warnings.

The [historical inventory](AUDIT_INVENTORY.md) has 65 identifiers, with SRS-11 refuted as a blocker and 64 remaining entries reported open in project memory. These include related symptoms, not 64 independently deduplicated root causes. Reconcile each entry against current source and an explicit outcome: reproduced, source-supported, already fixed, narrowed, refuted or deferred. Do not report every historical claim as independently reverified, and do not resurrect a proposed fix when its original premise was disproved.

## Product contract

Preserve courses, custom item types and templates; typed recall, kana input, multiple choice and sentence cloze; hints, media, rich text and mnemonics; synonyms, blocklists and guidance; custom ladders, lesson caps, batches, ghosts, cram and leech practice; levels, prerequisites and sticky passes; manual SRS changes and undo; source-based plans, proposals and progress/date/manual releases; capture, Anki, package/backup import/export, AI providers and external-assistant exchange. Units continue to correspond to course levels. Any intentional behavior change receives its own explanation and regression scenario. The domain also declares self/plain-cloze/FSRS cases without a complete working study path. Inventory them explicitly and safely reject unsupported imports with recovery guidance until implemented; do not advertise them as existing tested features. Scheduled MCP, attaching plans to existing courses, unit reordering and AI-written distractors remain separate previously deferred work.

Use these terms consistently:

| Term | Meaning |
|---|---|
| Item | Stored learning content with field values and prerequisite links. |
| Template | Defines which fields a card presents and how its answer is assessed. |
| Card | One scheduled review generated from an item/template pair. |
| Session | A bounded lesson, review or extra-study interaction. |
| Proposal | Candidate content awaiting acceptance into a course. |
| Module | Behavior hidden behind one interface; its depth is the leverage it gives callers. |
| Interface / seam | Everything callers must know; the seam is where they cross that interface. |
| Adapter | Concrete implementation at a seam, such as browser versus Node file access. |

Locality matters more than file counts: fixing an invariant once should fix every entry path. Split long pages by responsibility, but avoid replacing them with dozens of pass-through helpers. A module is an ownership concept, not a requirement to put every command in one file; keep its internal collaborators cohesive and avoid one universal dispatcher.

The [full review](CODEBASE_REVIEW.md) records source locations and verification limits; [CONTEXT.md](../CONTEXT.md) contains the project glossary. No source implementation is included in this documentation checkpoint.

## Phase 1 — Establish the regression baseline and canonical model

Promote the executed reproductions into focused regressions, retaining assertions about user-visible outcomes and stored relationships. Establish canonical runtime contracts for field kinds, template/grading variants, item content, course ownership, prerequisite identity and portable records. Derive static types from those contracts, or verify their equivalence without `any`/double-cast escape hatches.

A content module should expose a small interface such as `validateItem(candidate, type) -> valid item | field problems`. Editor, seed, capture, packet, AI and Anki adapters all cross that seam. Validation covers required prompts and answers, field shapes and template compatibility; supporting one input path must not create a second validity definition.

Keep this phase narrow enough that the credential, grading and stale-write repairs are the first implementation milestone. Establish contracts incrementally with those repairs, rather than finishing a broad schema rewrite before fixing urgent behavior. Add a capability inventory and a requirements-to-tests map. Preserve cohesive seed data and pure engines with established behavior. Replace implementation-mirroring tests only when tests across the new interface cover the same contract.

Acceptance: baseline remains green; each confirmed defect has a retained failing reproduction or explicit source/browser reproduction recipe and an owning repair phase; passing-after evidence is required when that phase completes; invalid prompt/answer shapes cannot enter through any producer; historical inventory outcomes are explicit; no unrelated behavior change is hidden in restructuring.

## Phase 2 — Protect local configuration and make backup replacement safe

Separate local provider configuration from portable study data. Credentials and their destination belong to one local-only configuration module; restoring a backup cannot combine an existing key with an imported endpoint. Use sentinel credentials and fake endpoints in tests, never actual secrets or network requests.

The backup module owns a consistent snapshot, version migration, complete graph validation, preview and atomic replacement. Capture item/type/card/plan/proposal/log/media rows in one read transaction, then encode the captured blobs afterward. Validate the entire candidate database before clearing anything. Check live course/type/template ownership, prerequisite links, supported scheduling state and required runtime fields. Distinguish broken live relationships from legitimate historical missing references: a graduated ghost can have logs after its card is gone, and an accepted proposal can outlive its deleted item. Preserve that history without granting it current undo or prerequisite authority. Include both cases in round-trip fixtures.

Migration defaults must come from real historical fixtures. If an old format omitted grading, choose an explicit supported migration or reject it with a useful explanation; silently inventing semantics is not compatibility. Prepare one coordinated versioned upgrade for monotonic card revisions, packet receipts and log ownership/index changes, initializing existing rows deterministically. Every later mutation must participate in the revision rule. Preserve an operation identity for deleted/graduated ghosts; their absence must not authorize replay or stale resurrection. Never grant old logs undo authority using a timestamp fallback.

Acceptance: valid supported backups round-trip content, media and history; invalid records or broken live relationships leave all current study tables logically unchanged; legitimate historical missing references remain recoverable; protected configuration cannot be overridden by incoming metadata; snapshot concurrency retains every referenced asset; interrupted replacement rolls back; unsupported versions fail before mutation.

## Phase 3 — Make progression, undo and question grading coherent

Create a progression module with transactional review/manual-change/undo commands. Every card writer increments a dedicated monotonic revision. A review command carries the observed card/content revision and an occurrence identity; stale attempts return an explicit conflict without advancing the card again. Timestamps are inadequate because same-millisecond writes and state returning to an earlier value remain possible.

An interface such as `progression.commit(attempt) -> committed | stale | unavailable` hides card/log/progress writes and gating settlement. Undo checks that the change being reversed is still the current applicable mutation; it cannot erase a newer review or manual adjustment while leaving misleading logs. Preserve sticky passes and deliberate manual-control semantics.

Separately, a prepared-question module serves review, lesson quiz and cram: `prepare(entry) -> question | needs repair`, followed by `grade(question, response) -> result`. Move question validity and grading policy out of the session store. Separate input-method assistance from allowed-answer policy: Japanese choice and kanji cloze must not inherit Latin-only retry rules. A type edit that creates an empty required answer yields repair guidance instead of an unwinnable review.

Acceptance: competing tabs advance once; replay is harmless; review/manual undo refuses stale reversal; Japanese distractors and cloze mistakes are correctly assessed; lesson completion only activates cards actually quizzed, enforces the daily allowance atomically and ignores obsolete session continuations; valid existing modes retain behavior; explicitly preserve exact sub-hour durations while retaining the intended hour alignment for longer stages; test calendar bins across DST and expose the selected policy; immediate valid undo of a ghost graduation restores that ghost, repeated/stale undo is harmless, and later item/template/course deletion prevents orphan resurrection; no invalid card traps a session.

## Phase 4 — Unify item drafts, plans and proposal acceptance

The item-authoring module owns raw draft text, parsed values, field-keyed errors, pending media and draft identity. Invalid text must never save the last valid value. Save derives one validated result; successful parsing of another field cannot erase an existing error. Functional field updates preserve edits made during mnemonic or media generation. Operation identities reject completion after reset/cancel and prevent attachment to the next item.

Course-plan commands update the latest row within a transaction. AI work returns a candidate; the plan module decides whether it remains applicable and patches only the target unit when adding proposals. Concurrent unit edits, appending units, releases and gating must not overwrite one another. Proposal acceptance resolves prerequisites inside the transaction and reports held rows predictably; a deleted accepted prerequisite must not unexpectedly roll back unrelated valid candidates. Surface proposals assigned outside the current plan instead of hiding them, and validate real calendar dates rather than only their text shape. Keep date editing local until explicit Save, preventing irreversible release on keystrokes; synchronize scheduled releases on time/visibility changes. Record date-only timezone semantics as a proposed product rule before changing the current UTC interpretation.

Give proposals a course-level queue even without a plan. Resolve handle collisions by course and current live items, deduplicate acceptance IDs, and return per-row problems without requiring new persistent error/hold layers for SRS-11. Use narrow intent interfaces such as `authoring.save(draft)` and `plans.applyDraft(candidate, expectedRevision)`, not broad whole-row replacements. Course creation with its initial type, capture conversion, related settings and deletion belong to atomic commands with actionable failure results.

Acceptance: malformed cloze is blocked without losing text; separate errors stay independent; pending AI/media cannot revert edits; double submits do not duplicate content; failures preserve drafts; concurrent plan changes survive; acceptance explains skips and commits valid outcomes according to its stated contract.

## Phase 5 — Repair portability and external adapters

Define one exchange protocol module shared by browser and MCP, with versioned schemas, unique packet identities and durable import receipts. Node filesystem and browser directory handles are real adapters at this seam. Publish complete packets atomically under collision-resistant IDs, then record receipt identity plus payload digest in the same database transaction as imported content. Reuse of an ID with different content is a visible conflict. Archive failure is a file-cleanup retry, never a reason to apply the packet again. Include per-item type in multi-type planned-course input so tool validation cannot strip it.

Keep full backups distinct from portable content packages. Recommended, pending the export preference question: use a lossless portable representation for supported fields, grading modes, media and custom ladders, with personal review history kept in full backups. A lightweight alternative must provide an explicit reviewed loss report with unusable exports blocked. Do not silently convert cloze/self grading to typed cards or guess a custom ladder from its name. Fix Anki name allocation against all used output names and retain the resulting mapping.

The AI adapter accepts a fully specified schema/request and returns validated candidates. Make structured-output capabilities, schema-bearing fallbacks, retries, cancellation and error normalization consistent across providers. Capabilities depend on endpoint and model; handle truncation, refusals, empty results, embedded code fences and unsupported parameters explicitly. Keep retry attempts bounded and avoid retrying identical requests. Type-specific generation must describe actual supported list/cloze/media shapes. Provider dependencies should load only when needed and must work in the browser bundle.

Acceptance: every supported content kind has a package round trip or a clear blocked/loss outcome; multi-type MCP plans import correctly; duplicate/retried packets do not duplicate items; generated names remain unique; provider contract tests cover success, malformed output, cancellation and failure; no paid/live request is needed for these gates.

## Phase 6 — Rebuild the responsive, accessible study workspace

Create accessible dialog and field/control-group modules before replacing page layouts. A dialog owns naming, focus entry/trap/restore, inert background and pending/dirty close behavior. Fields own labels, descriptions and error association; status changes have appropriate announcements. Remove nested links/buttons and nested labels. Respect reduced motion and test contrast rather than trusting color names.

Organize course work into Study, Items, Plan and Settings. Today presents the next study action and upcoming availability. Items gains search/filtering and bounded rendering so a 2,000-note import does not place thousands of rows above creation/settings. Keep advanced ladders, template design and manual controls discoverable. Candidate review shows actual prompts/answers, including cloze and media, and allows inspection of every accepted item.

Proposed visual direction: a bilingual course workspace organized around a quiet study rail showing what is available now and what opens next. Use pale blue paper `#F5F8FA`, deep ink `#153747`, evergreen action `#175F60`, study blue `#426BA7`, mulberry error `#A34D75`, and rule grey `#D9E4EA`. The existing dark default is the provisional default pending the preference question. Proposed dark tokens: deep-water base `#102A36`, raised surface `#183C49`, reading text `#EEF5F7`, active action `#74CDC1`, scheduled emphasis `#95B6E7`, and error emphasis `#EDADC6`. Check this palette alongside the light option; do not automatically switch existing users. These are proposed tokens, not measured contrast results. Colors accompany words/icons rather than carrying meaning alone.

Use Barlow for interface text and Zen Kaku Gothic New for Japanese learning content, subject to actual font-loading and offline checks. Start from 12/14/16/20/28px UI sizes; use larger Japanese prompts and a quieter 18–24px treatment for long coursework questions. Left-align reading and controls, centering only short recall prompts. Self-host required subsets/weights without inflating the initial study route.

```
Desktop
SRS    Today   Courses   Inbox                 Settings
Japanese fundamentals                  [Start reviews]
Study rail          Items | Plan | Course settings
Review now          Search items...       [Add item]
New lessons         Content and progress
Next release

Mobile
SRS                              Inbox   Settings
Today | Courses | Stats
Japanese fundamentals
[Start reviews — 24 cards]
8 new lessons available
Course tabs; item content above its actions
```

Self-critique: a large due-number hero with repeated metric cards would reproduce a generic dashboard. The study rail represents a real sequence and leads directly to recall. Avoid decorative Japanese motifs, gradients, excessive emoji and tiny uppercase labels. Confirm this direction with actual course content and screenshots before expanding it across every view.

Acceptance: no horizontal page overflow at 320/375/768px or desktop; keyboard-only editing/studying works; modal focus is correct; screen-reader names/errors are coherent; all proposed content is inspectable; media never shows the prior lesson item's image while loading; long coursework and Japanese text remain readable.

## Phase 7 — Release gates and recovery rehearsal

Run the feature matrix against a clean installation and migrated representative databases. Exercise Chrome and Edge including directory exchange; exercise Firefox and Safari through their file/paste fallback and backup download. Verify Japanese composition using a real system IME, not only synthetic key events. Include a clean clone with only the documented MCP installation steps and one real MCP-client round trip. Test offline reload after installation, service-worker upgrade, route refresh, unavailable storage, interrupted writes and recovery. AI/network features should explain unavailability while local study continues. Final provider qualification includes a synthetic outline/item generation through a user-configured endpoint, inspectable preview, acceptance and cancellation/error behavior; distinguish those results from mocked adapter tests and do not label a provider verified until exercised.

Rehearse Japanese prerequisite progression and meaning/reading templates, coursework release modes, all grading/media variants, ghost/cram/manual undo, capture/proposals and both export formats. Measure startup/bundle behavior and large-course rendering with representative data. Do not convert “all tests passed” into a claim that everything is perfect; document remaining limits and deliberately deferred cases.

Acceptance: typechecks, behavior tests, browser accessibility/responsive checks, clean-install/migration/offline scenarios and recovery rehearsal pass; feature parity is accounted for; production warnings are resolved or explicitly justified; each completed milestone has an inspected focused diff, verified commit and pushed checkpoint.

## Migration and rollback discipline

Implement one vertical slice at a time behind stable interfaces. Keep old persisted representations readable until their migrations are proven. Introduce browser/component testing dependencies and one verification command covering app plus MCP as explicit planned tooling changes; add repeatable CI checks for these gates. Use meaningful command/adapter tests, not a second layer of tests that mirror new wrappers. Before a destructive migration or real-data replacement, create and verify a local recovery backup; do not rely on a backup format whose own validation remains unfixed. Test migrations on copies and compare item/card/log/media counts plus meaningful relationships and study outcomes.

Use atomic database upgrades where possible. A deployed schema upgrade may prevent older app code from reopening the database, so code rollback alone is insufficient: recovery must include a tested compatible export/import path or restored pre-upgrade copy. Preserve the last working build and document the schema version it accepts. Stop rollout on unexplained data differences, failed recovery or stale-write regression.

Decisions about supported historical formats, portable-package losses, stale AI candidate handling and visual defaults remain proposals until reviewed. Record an ADR only when a choice is actually made; this plan does not pre-accept those tradeoffs.

## How the module design helps

A transaction alone does not stop a stale review. Imagine two tabs both read revision 7. The first transaction commits and writes revision 8. The second transaction may run afterward without overlapping at all, yet still be wrong: it represents the same old question. The study module checks the expected revision inside the transaction, rejects 7 versus 8, and gives the UI a clear already-handled result. Related card, log and progression changes succeed together or roll back together. This is the difference between atomic writes and a correct operation contract.

Keep network calls and expensive blob encoding outside database transactions; validate and commit current durable state afterward. [Dexie's transaction documentation](https://dexie.org/docs/Dexie/Dexie.transaction()) explains transaction scope and IndexedDB auto-commit behavior.

For forms, storing a raw sentence, its last valid parsed value and an unrelated shared error creates contradictory states. One draft module keeps those relationships explicit and validates the text the learner is actually submitting. This follows [React's state-structure guidance](https://react.dev/learn/choosing-the-state-structure). Dialog behavior should meet the [W3C modal-dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

Dependency strategy: pure question/scheduling modules test directly; Dexie uses the existing fake IndexedDB for fast behavior tests plus real-browser qualification; external AI uses production and deferred/failing test adapters; exchange has real Node and browser-file adapters. Add no new seam where nothing actually varies.

The teaching-skill question about the learner's goal is still pending. This explanatory example is review context, not a claim that the user demonstrated mastery or approved a new teaching curriculum. Create a mission and short interactive lesson once that goal is supplied.

## Workstream traceability

Historical workstreams A (persistence) map to phase 2; B (study) to phase 3; C/D (content/plans) to phases 1 and 4; E/F (interchange/AI) to phase 5; G (release) to phase 7. Current UI findings additionally map to phase 6. Phase 7 verifies all prior phases; phase 6 does not defer the draft-integrity repairs from phase 4. Each inventory ID must receive a tested repair, a supported refutation/narrowing, or an explicitly retained prior deferral. No known material defect is considered closed merely because files were moved.
