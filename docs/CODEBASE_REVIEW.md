# Full codebase review — September 8, 2026

The app has a useful pure learning engine and broad product coverage, but its current mutation and input-validation design does not meet a reliable daily-study standard. Passing the existing tests is insufficient: targeted checks reproduced lost edits, invalid restores, duplicate progress changes, and incorrect grading. A substantial in-place overhaul is justified. The [execution plan](OVERHAUL_PLAN.md) preserves the learning features while replacing the orchestration that makes these defects recur.

This is a review and proposed plan, not an implemented repair. The audited source baseline is `1a2b189d3283d9537a30f944bebb9eef5b2bcee5` on `main`. Git was clean with no merge or rebase in progress. All source locations below refer to that baseline.

## Coverage and verification

Four reviewers collectively read all **131 authored tracked files, 20,011 lines**, including all source, tests, seeds, configuration, and documentation. Both generated lockfiles were parsed structurally and checked with their package audits; they were not manually reviewed line by line. Dependencies' implementation and generated build output are outside the full-source-read claim. The per-file ledger is [review coverage](REVIEW_COVERAGE.json).

| Check | Result | Limit |
|---|---|---|
| Existing suite | 22 files, 236 tests passed | Node and fake IndexedDB; no React/browser tests in this suite |
| Production build | Passed, including root TypeScript check | Warnings remain; passing does not establish offline or live-provider behavior |
| MCP TypeScript | Passed | Not a clean-install or real-client integration test |
| Root and MCP dependency audits | Zero advisories returned by both | Point-in-time registry results, not proof of application safety |
| Targeted defective-behavior reproductions | 15 passed: 10 study/progression, 5 data/AI | These assert that bugs exist; they are not passing repair regressions |
| Browser checks | Invalid cloze save, missing modal semantics/initial focus, and narrow-screen overflow reproduced | Separate local origin with sample data; no real credentials or AI calls |
| Browser console during exercised flows | No captured warnings/errors | The silent draft-save bug produces no console error |

The production entry bundle is about **1,094.62 kB minified / 311.47 kB gzip**. Build output reports Node filesystem/path externalizations in the Anthropic SDK and an ineffective dynamic import of grading normalization. The PWA precache excludes the emitted 658.41 kB SQL WebAssembly asset. These are concrete investigation and packaging targets, not evidence that every AI request or all offline navigation fails.

## Findings that determine the overhaul

Priority P1 means fix before relying on the affected everyday workflow. P2 is a material correctness, usability, or maintainability problem. These are existing defects; this review does not claim a new branch introduced them.

### P1 — Several writers can overwrite or double-count the same study progress

`src/services/commitReview.ts:9` accepts a card ID without the version the session observed; `:49` checks review state but does not reject a stale occurrence. Two answers from the same loaded occurrence both commit and advance the card twice. `src/services/undo.ts:33` and `src/services/manualSrs.ts:276` restore snapshots without establishing that later mutations have not occurred. Executed reproductions show stale undo removing later progress/statistics while leaving the later review log intact.

The defect is shared ownership, not a missing button-disable flag. One study-mutation module should own revisions, review commits, manual changes, lesson activation, ghost lifecycle, undo, and required progression updates. Pure grading and scheduling remain internal collaborators. Every writer that invalidates a loaded card must participate, including type/ladder edits and deletion.

Use a dedicated monotonically increasing revision, not `updatedAt`. Wall-clock collisions and an undo restoring old state make timestamps unsuitable. Graduated/deleted ghosts need an explicit retained mutation identity or equivalent tombstone rule so the absence of a card cannot bypass the stale-undo check.

### P1 — Backup restore can redirect the destination associated with an existing local key

`src/db/import.ts:178` preserves device-local AI rows, but later incoming metadata overwrites them. `src/db/export.ts:14` excludes API keys while exporting endpoint/provider settings; `src/ai/client.ts:99` combines the restored destination with the preserved key. An executed sentinel-only test changed the destination to a foreign endpoint without changing the local key. A subsequent AI request would send the key to that destination.

Keep the entire credential/provider/destination configuration device-local. Exclude it from export and reject or discard imported protected metadata before an atomic restore. Bind configuration changes to the user's explicit settings action.

### P1 — Successful restore can replace a working database with unusable records

`src/db/import.ts:42` onward validates only partial runtime shapes and then relies on broad casts. Relationships between cards, templates, types, courses, ladders, and plans are not validated. Executed: a backup missing the required `item.synonyms` map and containing a dangling template reference restored successfully; a following course export threw.

Validate and migrate a complete candidate snapshot before destructive writes. Separate supported historical defaults from corruption using actual old-format fixtures. A transaction guarantees all-or-nothing writes; it does not guarantee that the written data is usable.

### P1 — Grading applies typed-input assumptions to other answer modes

`src/engine/grading/context.ts:29` defaults every non-typed mode to Latin. `src/engine/grading/match.ts:50` treats mismatched script as a penalty-free retry. The same verdict also filters potential choice distractors. Executed: Japanese choice distractors disappear, the UI falls back to typed input, and wrong Japanese guesses can retry without recording a miss. Kanji sentence-cloze answers also reproduce an inappropriate retry.

The older audit's statement that *all* Japanese cloze answers cannot fail is too broad: the new reproduction confirms a kana-only sentence-cloze case grades a wrong kana answer as incorrect. Preserve the defect with its exact mode/script conditions instead of retaining an exaggerated claim.

A prepared question should explicitly determine its answer mode, valid content, accepted answers, script policy, and available choices. Typed keyboard assistance must not turn a wrong selected option into a free retry. Tests must cross script, mode, synonyms, block lists, guidance, and ghost behavior.

### P1 — Async completion replaces newer edits with stale snapshots

`src/ai/plan.ts:354` loads the plan before a network request and `:392` writes that old plan back afterward. Executed: appending a unit and editing plan/unit titles while generation waits are undone when it completes. Concurrent unit edits also lose updates through `src/services/plans.ts` whole-row writes.

The same pattern appears in `src/components/editor/ItemEditor.tsx:54,96`: a mnemonic callback spreads the draft captured before its await, potentially overwriting subsequent field edits. Media completion has similar stale field callbacks in `FieldValueInput.tsx:138` and callers.

AI adapters should return candidate content. A current-state commit checks whether its target and assumptions remain valid and atomically applies proposals plus the targeted plan stamp. Editor results patch a specific field against the current draft and reject completion for a reset or replaced draft.

### P2 — The visible draft and the saved draft can differ

`src/components/editor/FieldValueInput.tsx:100` stores raw cloze text internally and emits values only after successful parsing. `src/pages/CoursePage.tsx:220` clears the error on submit and saves the parent's last valid value.

Browser reproduction: enter `We meet ⟦at⟧ noon.`, replace it with `We meet at noon.`, observe the validation error, then click Add item. The item count increases and the form clears. Reopening the item shows the *older bracketed sentence*. Other editors use one shared error slot for multiple fields, allowing one successful field to hide another field's error.

One item-draft module should own raw values, parsed values, field errors, pending media, and draft identity. A submit validates the current visible draft. All authoring paths use the same content rules; they must not each implement a slightly different validator.

### P2 — Content can be stored even when it cannot produce a usable question

`src/packages/importPacket.ts:50` validates answers without fully validating prompts and field kinds. Executed: an answer-only item with no prompt imports successfully. `src/db/repo/items.ts` lacks a canonical content validator. An executed item-type migration leaves active cards with no accepted answer. Empty-answer sessions can become impossible to complete.

Enforce content and ownership invariants in the public mutation interface. Migration must produce an actionable repair report for newly unanswerable content. Session loading needs an explicit recoverable problem state for legacy invalid entries, without counting them as successful or silently hiding them forever.

### P2 — Proposal and interchange contracts diverge

`srs-mcp/index.ts:107` omits the per-item type from its item schema, while `:366` supports plans with up to three types. The app requires that type when a course has multiple types (`src/packages/importPacket.ts:111`). Those MCP-generated proposals cannot identify their types. This is source-traced in this pass.

Executed study tests also show duplicated proposal IDs creating duplicate items and a handle pointing to a deleted accepted prerequisite rolling back an otherwise valid acceptance batch. Handles, accepted targets, pending dependencies, and invalid rows require one clear course-scoped resolution policy.

Packets also lack durable consumption receipts; timestamp-named MCP writes can collide. Re-import after archive failure can duplicate content. Share portable schemas between real browser and Node adapters, publish complete uniquely named files, and apply packet identity plus receipt within the same database transaction as content.

### P2 — Course export changes supported content without an adequate preservation contract

`src/packages/exportPackage.ts:57,119` omits media and converts supported grading/field modes. Mutable ladder names are used to guess presets. Planned courses can retain a held-level setting while losing the plan that releases their units. These are source-traced here and appear in the earlier inventory.

The proposed default is a lossless course-content package with media and custom learning configuration; full backups separately retain personal review history. The alternative is an explicitly labeled lightweight export with a visible loss report. This product choice is pending, not silently settled by this review. Either choice must prevent importing an unusable course.

An independent executed Anki case proves `dedupeNames(['Front','Front','Front (2)'])` emits a duplicate field name, causing packet rejection. Reserve generated names as well as original names.

### P2 — The interface is inaccessible in common keyboard and phone use

`src/components/ui.tsx:96` lacks modal semantics, title association, initial focus, focus containment, and background inertness. Browser inspection found zero dialog elements/roles and focus remaining on the underlying Edit button immediately after opening. Full focus-cycle and screen-reader qualification remains to be performed.

At 320 × 740, the Dashboard has a 345px scroll width, and the New course action extends to x=345.47. The screenshot cuts off both that action and Settings navigation. `Dashboard.tsx:239` and `App.tsx:30` need responsive action/navigation behavior.

Shared form primitives also need explicit labels, field-group semantics, described errors, live status, and reduced-motion support. Course Items currently renders every item without search or paging, placing large imported decks ahead of advanced controls.

## Why structural work is necessary

The largest files are CoursePage (845 lines), PlanPage (762), InboxPage (684), ItemTypeDesigner (569), and importPacket (540). **No authored file exceeds 1,000 lines**, so there is no evidence for a thousand-line regression. Size is a symptom: course administration, raw data joins, forms, AI generation, and progression policy share large page implementations.

Three repeating patterns deserve removal:

1. Domain interfaces, backup schemas, packet schemas, and AI/MCP schemas describe overlapping facts differently. Put canonical content validation in one module, with explicit adapters for genuinely different formats.
2. UI, repo helpers, imports, and services share responsibility for consistency. Give each user-intent mutation one owner that guarantees related writes and error behavior.
3. Forms and study pages coordinate independent flags and cached snapshots. Model valid states and field-specific operations so contradictory/stale states cannot be submitted.

Keep the pure scheduler, normalization, cloze parser, queue rules, and useful existing regression tests where they remain cohesive. Do not manufacture a generic event bus, a universal repository abstraction, or a backend merely to make the folder tree look architectural. One shared interface should hide real rules; moving a function into another file is not sufficient.

## Reconciliation with the September 7 audit

The previous audit records SRS-01 through SRS-65, with SRS-11 subsequently refuted as an acceptance blocker: Edit → Save already clears its stale error. Its remaining issue is advisory usability. Keep the ID traceability in [the prior finding inventory](AUDIT_INVENTORY.md), but do not call all 64 remaining entries newly reproduced in this pass.

Correct the old implementation recipes before using them:

- SRS-03/05: dedicated revisions supersede the early timestamp proposal.
- SRS-02: the old text both defaults missing grading and expects the same omission to be rejected. Resolve that from real historical format support; do not implement contradictory tests.
- SRS-04: checking before the async request or before a separate write still leaves a race. Validate current state and commit related proposal/plan changes together.
- SRS-11: do not add a new persistent hold/error system solely to fix a refuted claim.
- SRS-39: retain the exact mode/script scope described above.

The two bugs mentioned in the repository memory banner were already identified and repaired in earlier work; the project note records both. They are not unknown new blockers.

## Remaining qualification

No real provider calls, credentials, user dataset migration, system Japanese IME, Firefox/Safari download, live filesystem exchange, multi-tab browser race, installed-PWA update, or clean-clone MCP run was performed here. The new design itself has not been implemented or visually tested. These are named acceptance tasks in the execution plan, not reasons to label the app perfect based on its baseline suite.

All three requested `npx skills use` commands completed successfully and their full output/supporting instructions were read. The local `grill-with-docs`, `teach`, and `frontend-design` installations already matched the downloaded skill content after normalizing line endings; no missing installation or overwrite was necessary. The requested review/design/conflict skills and the grilling/domain-modeling dependencies were also read. There was no conflict to resolve.
