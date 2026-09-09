# Recovery and release checks

The app remains local-first. The browser origin owns its database; changing hostname, port or
browser profile opens a separate study library. Keep the original profile when qualifying an update.

## Reproducible installation

Use Node 24. From the repository root, run `npm ci` and `npm run check`. The root lockfile
installs both the browser app and `srs-mcp`; do not install the MCP directory separately.
`npm run check` includes both typechecks, database/engine/component/adapter tests, a real stdio
MCP client round trip and the production PWA build. GitHub Actions runs the same gate on Windows
and Linux. A locally passing run does not establish the remote CI result.

Serve `dist` at the site root over HTTPS (localhost also works). The host must rewrite unknown
application paths to `index.html`; BrowserRouter routes such as `/course/:id` need this on refresh.
Use `npm run preview -- --host 127.0.0.1` for local production qualification, not the development server.

## Backup replacement

1. In Settings, download a full backup before updating an existing study library.
2. Verify a copy in a separate browser profile or local test origin: inspect the import preview,
   restore, compare courses/items/cards/media/history and complete a representative study question.
3. The current database is schema 6. Upgrades add revision/log ownership, delivery receipts,
   graduated-ghost tombstones, a daily lesson ledger and record lifetime identities. Each numbered
   migration is additive and covered by database upgrade regressions.
4. Backup format 2 validates required records, ranges and live relationships before replacement.
   Supported format-1 omissions migrate explicitly. Historical references may outlive deleted
   items/cards; they never authorize a current undo. Unsupported study modes fail before mutation.
5. Every restore assigns a new lifetime identity to cards/items/types and removes undo authority
   from restored history. Other tabs must reload their stale questions or drafts. Repeated restores
   after deletion cannot revive old commands. Existing local credentials and destinations stay paired.

Import failure leaves the current database intact. Keep the file and its error, repair the candidate
or use a known-good backup, then retry. Do not clear browser storage to work around a validation error.
Study reset is a separate destructive operation and preserves local device configuration.

## Rollback

Older code cannot safely reopen schema 6. Rolling back a build alone is insufficient. Keep a verified
pre-upgrade backup and matching build; restore that backup in a separate profile using compatible
code, then compare the recovered content before changing the active library. Do not downgrade
IndexedDB versions manually. A current backup is intended for current compatible code, not arbitrary
older releases.

## Portable content and assistant delivery

Course packet format 2 preserves supported text, rich text, lists, sentence cloze, media, hints,
answer exceptions, exact ladder intervals, release policy and course material. Progress and device
configuration belong in a full backup. Supported format-1 packets remain readable. Lossy/unsupported
study modes are refused; Anki imports clearly retain notes/fields but omit Anki scheduling/media/HTML.

MCP publishes complete JSON under a fresh UUID. The app commits imported rows and a payload-digest
receipt together. If archive cleanup fails, retry cleanup: the receipt prevents another content import.
Reuse of a packet ID with different content is an error. A missing explicit target course ID is an
error even if another course has its old name. Browser folder copy/delete is not an atomic filesystem
rename; recovery depends on the durable receipt.

## Acceptance checklist

- Study typed/kana/choice/sentence-cloze questions, mistakes/retries, lessons and daily allowance,
  cram, ghost graduation, manual controls and current/stale undo.
- Edit raw invalid content, upload/replace media, change fields while an AI request is pending,
  and verify saved text or explicit suggestions are preserved.
- Accept drafts with dependencies, including deleted/ambiguous handles; valid siblings should
  remain acceptable. Exercise a no-plan queue and drafts outside the visible plan units.
- Save dates explicitly. Date-only input means midnight UTC; complete ISO timestamps can include
  an offset. Real calendar dates are validated. Local-day lesson/forecast bins follow calendar days
  across daylight-saving changes. Stage delays through 60 minutes remain exact.
- Test 320/375/768px and desktop layouts, keyboard focus, both themes and long Japanese/coursework text.
- Load the production app, let its worker finish caching, stop the local server, reload a deep route,
  and import a legacy `.apkg` offline. The emitted sql.js WASM must be listed in `dist/sw.js`.
- Qualify Chrome/Edge folder permissions, Firefox/Safari file fallback, an installed PWA update,
  real system Japanese IME and any user-configured AI endpoint separately. Mocked transport and
  synthetic composition tests do not prove these environments.

AI/network failure must leave local study available. No paid provider request is part of automated
verification. Actual endpoint/model compatibility remains subject to that provider's response.
