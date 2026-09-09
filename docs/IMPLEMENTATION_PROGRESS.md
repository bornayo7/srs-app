# SRS overhaul: delivery and acceptance record

Completed implementation on `codex/srs-overhaul`, following explicit authorization on September 8, 2026. The review baseline is `42c55fc`; the verified implementation milestone is `420b8ad`. This follow-up removes stale proposal hints as an acceptance-button prerequisite, adds two real component/database regressions, and closes the documentation record. The default branch has not been merged or deployed.

[IMPLEMENTATION_REVIEW.md](IMPLEMENTATION_REVIEW.md) maps all 65 historical labels to their exact disposition and evidence. It includes the SRS-11 refutation and the later convenience improvement without counting those labels as 65 independently reproduced defects. [RECOVERY_AND_RELEASE.md](RECOVERY_AND_RELEASE.md) covers installation, supported formats, schema upgrades, rollback and remaining manual qualification. The accepted decisions are in [0001-overhaul-contracts.md](decisions/0001-overhaul-contracts.md).

## Delivered behavior

- Study writes and undo compare Card, Item and ItemType lifetime/revision tokens inside transactions. Same-millisecond writes, competing tabs, ghost graduation and restored datasets cannot reuse stale authority. Quiz activation and daily lesson consumption are transactional; a durable ledger prevents deletion from reclaiming the allowance.
- Shared content validation protects editing, conversions, imports, backups and question preparation. Backup format 2 validates the full supported graph before atomic replacement, captures content/media coherently and protects all device provider/exchange configuration. Schema 6 adds deterministic legacy versions and new lifetime identities on restore.
- Plan commands patch current rows. Generation checks current target assumptions before committing proposals and its marker together. Acceptance resolves current prerequisites, preserves valid siblings and rejects ambiguous handles. Date edits require Save; scheduled releases refresh through app lifecycle events.
- Packet format 2 preserves supported media, rich text, grading, hints, answer exceptions, exact custom ladders and release plans; version 1 remains readable. Durable packet-ID/digest receipts separate content import from retryable archive cleanup. MCP shares the canonical schema and publishes complete files under unique identifiers.
- Browser-native AI transports send the actual output schema, validate the response, reject refusal/truncation/empty output, preserve embedded backticks and negotiate only explicitly unsupported parameters. Type-specific generation and current-draft mnemonic candidates avoid silent content loss.
- Shared drafts retain invalid raw text and independent field errors. Failed uploads and saves remain recoverable. Course Study/Items/Plan/Settings navigation, bounded item lists, full candidate previews, native dialogs, dark/light themes and visible operation errors replace the previous long-page orchestration.
- Root npm workspaces install and check the app and MCP together. Route loading reduces the initial bundle; the PWA precaches Anki's WASM dependency.

## Automated evidence

| Check | Observed result |
|---|---|
| Original source baseline | 236 tests in 22 suites; build passed despite the reproduced failures documented in the initial review. |
| Implementation milestone `420b8ad` | Both TypeScript checks, 386 tests in 47 suites, production/PWA build passed. |
| Clean install of the milestone snapshot | Isolated copy outside the Windows junction; Node 24.11.1/npm 11.6.2; root `npm ci` succeeded with zero reported vulnerabilities; full gate passed all 386 tests at 23:58 CDT September 8. A transitive glob deprecation notice did not fail installation. |
| Remote milestone CI | [Run 34312970779](https://github.com/bornayo7/srs-app/actions/runs/34312970779), exact head `420b8ad1d9c466b3dfa0c12a1471223f13f76234`: both Windows and Ubuntu jobs passed with Node 24. |
| Final source follow-up | `npm run check`, September 9 starting 00:01 CDT: application and MCP typechecks, **388 tests in 47 suites**, Vite build and PWA generation passed. The two additional cases exercise single and bulk acceptance after a separately accepted prerequisite. |
| Production artifacts | Initial index JavaScript 222.42 kB / 69.95 kB gzip, versus the reviewed baseline 1,094.62 / 311.47 kB. Final precache: 43 entries / 1,544.25 KiB; emitted sql.js WASM is 658,410 bytes. Initial-chunk reduction is not a claim that all application assets disappeared. |
| Source review | Implementation owners fully read their changes; independent reviewers fully read assigned cross-boundary changes and reported no remaining high-conviction material defect after corrections. Final proposal diff and report received an additional read-only review. |

The source follow-up `f6cb68ee7014ac49e8706f7b37298f3d27490462` passed both Windows and Ubuntu in [run 34313671083](https://github.com/bornayo7/srs-app/actions/runs/34313671083). That run exposed deprecated Node 20 action helpers. The workflow now pins the official [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) and [setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0) commits, which use Node 24; application source is unchanged. Its exact CI result is available in the branch's [verification runs](https://github.com/bornayo7/srs-app/actions/workflows/check.yml). Earlier CI results are identified by their own revisions rather than substituted for a later revision's result.

Database tests use fake IndexedDB with versioned upgrade and transaction behavior; component tests use jsdom. Provider tests exercise captured requests and controlled responses. The MCP protocol test starts the actual server and sends a multi-type plan through an SDK stdio client, then imports and accepts its content through the browser-domain services.

## Native browser acceptance

The in-app Chromium shell used isolated local test origins on ports 5194 and 5195. No personal provider credential was entered. These are actual UI actions, distinct from the automated cases above:

1. Created a course and Basic item. The native edit dialog had a name, focused the first field and returned focus to its edit trigger on cancellation.
2. Entered valid cloze, changed it to invalid raw text, and submitted. No item was saved and the text/error remained available; correcting the cloze then saved it.
3. Checked dashboard/course/editor at 320px, a plan at 375px and settings at 768px, plus desktop dark and light layouts. No horizontal page overflow was observed in those views; the narrow course-tab strip scrolls within itself.
4. Completed a lesson after a wrong answer, retry and correct answer. Advanced the development clock to make the card due, committed a review, and immediately undid it successfully.
5. Prepared the same review in two tabs. The first committed; the second reported that the card changed and left it unchanged. Wrap-up counted one completed card and the summary reported one correct answer.
6. Pasted a two-unit manual plan packet, inspected its full proposal content, accepted it and released the next unit. An unsaved date edit disappeared on reload; an explicit date Save persisted.
7. Loaded the production build, confirmed the WASM entry in its worker, stopped the preview server, and verified that the server refused HTTP connections. A deep `/inbox` reload still worked. Uploading a synthetic legacy `.apkg` previewed and imported one Basic note while the server remained stopped. This offline rehearsal used the earlier integrated production build; later changes did not modify Anki parsing or precache policy.

The development clock was reset to real time after acceptance. Temporary viewport overrides and test tabs were cleared; the preview and development servers were stopped.

## Qualifications and preserved policies

- Live provider/model/CORS behavior, native Japanese IME, physical folder permission/reconnect behavior, Safari/Firefox/native Edge, screen readers and installed-PWA update behavior were not exercised. They have explicit procedures in the recovery/release guide; passing mocked or Chromium-shell checks does not establish those environments.
- Course packages preserve supported content and authoring/release settings. Personal review progress belongs in a full backup. Device credentials and destinations stay local.
- Date-only releases retain midnight UTC. Daily allowance and forecast use local calendar boundaries. Intervals through 60 minutes remain exact; longer stages retain hour alignment.
- Reset/suspend leaving existing ghost drills alive remains a deliberate policy. Scheduled MCP, attaching plans to existing courses, unit reordering and AI-written distractors remain previously deferred features.
- Unsupported self grading, plain cloze, reveal-style study and FSRS fail with guidance. The overhaul does not advertise them as implemented modes.
- Platform fonts replace the proposed downloaded Barlow/Zen assets to avoid a new offline dependency. Dark remains the default, with a persisted light option.

The scoped implementation and local acceptance gates are complete. No known material defect remains from the reviewed repair scope; this is bounded evidence, not a guarantee of perfect behavior in every environment.
