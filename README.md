# SRS — Spaced Repetition for Anything

A local-first spaced-repetition PWA that combines **WaniKani's structure** (SRS stage ladders,
lessons vs reviews, typed answers with typo tolerance, levels), **Anki's flexibility** (your own
courses, item types, fields, and templates), and **Bunpro's options** (ghost reviews,
sentence-cloze, cram mode) — plus an AI layer that builds decks for you.

Everything lives in your browser (IndexedDB). No accounts, no server, one-click JSON backup.

## Features

- **WaniKani-style SRS**: editable stage ladders (Classic 4h→4mo with burning, Gentle,
  Bunpro-like), hour-aligned due times, wrong answers drop stages by the real WK formula
- **Prerequisite gating & levels**: items unlock only when their prerequisites *pass*
  (radical → kanji → vocab), and levels advance when enough of the level's gate items pass
- **Typed reviews**: typo tolerance (Damerau-Levenshtein), synonyms, block lists, wrong-facet
  shake, kana/kanji-aware input guards, and a built-in **kana IME** (type `moku` → もく)
- **Lessons**: batched study + quiz gate with a daily new-item limit
- **Ghost reviews** (Bunpro-style): missed cards spawn short-cycle drill ghosts that graduate
  and vanish, without touching the parent card's schedule
- **Sentence cloze**: fill-in-the-blank inside rotating example sentences
- **Cram / extra study**: drill anything (all learned, leeches, recent misses) with zero SRS impact
- **Stats**: review heatmap, retention, per-course accuracy and stage distribution
- **AI (bring your own key)**: generate whole courses or items from a topic/pasted text, and
  one-click mnemonics — Anthropic (Claude) or any OpenAI-compatible API (OpenAI, Gemini,
  OpenRouter, Ollama, …), called directly from the browser
- **MCP server** (`srs-mcp/`): let Claude, ChatGPT/Codex, or any MCP client read your courses
  and drop new decks into the app's Inbox
- **Anki `.apkg` import**, JSON course packages, quick-capture notes, browser TTS

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine + service test suite
npm run build      # production PWA build
```

Chrome/Edge recommended (the MCP exchange folder uses the File System Access API).

## AI setup

Settings → AI: pick a provider, paste an API key (stored only in this browser, excluded from
backups). ChatGPT-subscription OAuth (Codex sign-in) can't be used by third-party web apps —
instead, register `srs-mcp` with the Codex CLI and your subscription can build decks through
the Inbox. See [srs-mcp/README.md](srs-mcp/README.md).

## Architecture

- `src/engine/` — pure TypeScript: schedulers, grading pipeline, gating/levels, queue, forecast
  (the test target)
- `src/db/` — Dexie (IndexedDB) schema, repos, backup import/export
- `src/services/` — transactional write paths (`commitReview` is the one place reviews commit)
- `src/packages/` — the `srs-packet` format: one validated JSON shape shared by MCP, AI
  generation, and file import
- `src/exchange/` — snapshot + inbox folder bridge to the MCP server
- `srs-mcp/` — stdio MCP server (Node + tsx)

Built with Vite, React 19, TypeScript, Tailwind v4, Dexie, Zustand, Zod.
