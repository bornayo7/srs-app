# SRS — Spaced Repetition for Anything

A local-first spaced-repetition PWA that combines **WaniKani's structure** (SRS stage ladders,
lessons vs reviews, typed answers with typo tolerance, levels), **Anki's flexibility** (your own
courses, item types, fields, and templates), and **Bunpro's options** (ghost reviews,
sentence-cloze, cram mode) — plus an AI layer that builds decks for you.

Everything lives in your browser (IndexedDB). No accounts, no server, one-click JSON backup.

## Features

- **WaniKani-style SRS**: editable stage ladders (Classic 4h→4mo with burning, Gentle,
  Bunpro-like), exact delays through 60 minutes and hour-aligned longer stages, stage drops on wrong answers
- **Prerequisite gating & levels**: items unlock only when their prerequisites *pass*
  (radical → kanji → vocab), and levels advance when enough of the level's gate items pass
- **Item-type designer**: build your own content model per course — fields (text, rich text,
  list, image, audio, cloze sentences) and card templates (what's prompted, what's typed, hints,
  kana/latin, typo tolerance). Saving migrates every existing item, and the impact is spelled out
  before you commit
- **Item editor**: field values, mnemonics, prerequisites, per-template synonyms / block lists /
  guidance answers, and manual SRS control — set any card's stage, suspend, burn, or send an item
  back to lessons, all logged with the previous state and undoable in one click
- **Images & audio**: picture prompts downscaled to 1024px and stored (with your backup) locally
- **Typed reviews**: typo tolerance (Damerau-Levenshtein), synonyms, block lists, wrong-facet
  shake, kana/kanji-aware input guards, progressive hints, and a built-in **kana IME**
  (type `moku` → もく)
- **Multiple choice**: any template can be answered by clicking (or pressing 1–6) instead of
  typing. Wrong options are drawn from sibling items at a similar level and are checked against
  the real grading pipeline first, so a "wrong" option can never be a synonym or a typo-range
  twin of the answer. Correct answers commit exactly like a typed one
- **Lessons**: batched study + quiz gate with a daily new-item limit
- **Answer overrides**: switch a graded answer with **Mark correct** or **Mark wrong** in
  reviews, lesson quizzes, and cram. **Continue** confirms the result; earlier confirmed
  mistakes still count. Reviews update the schedule only after confirmation
- **Ghost reviews** (Bunpro-style): missed cards spawn short-cycle drill ghosts that graduate
  and vanish, without touching the parent card's schedule
- **Sentence cloze**: fill-in-the-blank inside rotating example sentences
- **Cram / extra study**: drill anything (all learned, leeches, recent misses) with zero SRS impact
- **Stats**: review heatmap, retention, per-course accuracy and stage distribution
- **AI (bring your own key)**: generate whole courses or items from a topic/pasted text, and
  one-click mnemonics — Anthropic (Claude) or any OpenAI-compatible API (OpenAI, Gemini,
  OpenRouter, Ollama, …), called directly from the browser
- **Course plans (progressive AI courses)**: paste a syllabus or your notes and the AI splits
  it into ordered units (one per week/chapter) with 1-3 item types — terms, multiple-choice
  questions, vocab. Each unit's items are drafted on demand into a **review queue** where you
  accept, edit, or reject every one (rejections, with reasons, steer the next draft). Units are
  course levels, so they open one at a time — by progress, by date, or by hand — and the daily
  lesson cap drips items within a unit. Old units stay in your reviews for the whole course
- **MCP server** (`srs-mcp/`): let Claude, ChatGPT/Codex, or any MCP client read your courses,
  drop new decks into the app's Inbox, or propose a whole course plan / items into the review queue
- **Anki `.apkg` import**, JSON course packages, quick-capture notes, browser TTS

## Run it

```bash
npm ci             # Node 24; installs both the app and MCP workspace
npm run dev        # http://localhost:5173
npm test           # engine, database, component and adapter behavior
npm run check      # app + MCP typechecks, all tests, production build
npm run build      # production PWA build
```

Chrome/Edge recommended (the MCP exchange folder uses the File System Access API).
File and paste imports work without a connected folder. See [recovery and release checks](docs/RECOVERY_AND_RELEASE.md).

## Backups and sharing

Full backups contain study progress, history, media, plans, drafts and delivery receipts.
Restoring validates the entire file before replacing study data and leaves this device's AI
credentials, provider destinations and exchange connection intact. Restore cancels old undo
authority and makes edits or reviews prepared in another tab stale.

Course packages share supported learning content, exact ladders, media, grading rules and
release plans; they start with fresh study progress. Self grading, plain cloze, FSRS and
reveal-style scheduling are not available study modes and are rejected with repair guidance.

## AI setup

Settings → AI: pick a provider, paste an API key (stored only in this browser, excluded from
backups). ChatGPT-subscription OAuth (Codex sign-in) can't be used by third-party web apps —
instead, register `srs-mcp` with the Codex CLI and your subscription can build decks through
the Inbox. See [srs-mcp/README.md](srs-mcp/README.md).

## Architecture

- `src/engine/` — pure TypeScript: schedulers, grading pipeline, gating/levels, queue, forecast
  (the test target)
- `src/db/` — Dexie (IndexedDB) schema, repos, backup import/export
- `src/services/` — transactional write paths; expected revisions and lifetime identities prevent stale writes
- `src/services/plans.ts`, `proposals.ts` — course plans (units = levels, release modes) and the
  AI review queue; `src/ai/plan.ts` / `generateUnit.ts` — outline design and guarded unit generation
- `src/packages/` — the `srs-packet` format: one validated JSON shape shared by MCP, AI
  generation, and file import
- `src/exchange/` — snapshot + inbox folder bridge to the MCP server
- `srs-mcp/` — stdio MCP server (Node + tsx)

Built with Vite, React 19, TypeScript, Tailwind v4, Dexie, Zustand, Zod.
