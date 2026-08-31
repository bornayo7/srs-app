# srs-mcp

MCP server that lets AI assistants (Claude, ChatGPT, Hermes — any MCP client) read your SRS
courses and create new ones. It talks to the app through an **exchange folder**, never touching
the browser database directly:

```
~/srs-exchange/
├─ snapshot.json   ← written by the app (courses, schemas, stats, leeches)
└─ inbox/          ← packets written by this server; imported in the app's Inbox page
   └─ done/        ← packets the app already imported
```

## Setup

1. `npm install` in this folder (once).
2. In the SRS app: **Inbox → Connect exchange folder** → pick (or create) `~/srs-exchange`
   (Chrome/Edge only — the File System Access API).
3. Register the server in your MCP client.

### Claude Code

```bash
claude mcp add srs -- npx tsx "C:\Users\yashb\Desktop\Github\srs-app\srs-mcp\index.ts"
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "srs": {
      "command": "npx",
      "args": ["tsx", "C:\\Users\\yashb\\Desktop\\Github\\srs-app\\srs-mcp\\index.ts"]
    }
  }
}
```

Other MCP clients (ChatGPT desktop, Hermes, …): any client that supports **stdio** servers works
with the same command. Set the `SRS_EXCHANGE` environment variable to use a folder other than
`~/srs-exchange`.

## Tools

| Tool | What it does |
|---|---|
| `list_courses` | Courses + counts + item-type schemas (call first) |
| `get_course` | Full detail incl. every item — for matching field names / avoiding dupes |
| `get_struggling_items` | Your leeches, most-failed first |
| `create_course` | Design a new course (type, templates, items) → Inbox packet |
| `add_items` | Add items to an existing course → Inbox packet |

Packets are validated twice — here before writing, and again in the app before import. Nothing
is ever auto-imported; you always click Import in the Inbox.

Try: *“Make me a 30-item deck of the most common French verbs with mnemonics”* or
*“Look at what I keep failing in CS Terms and write better mnemonics for those items.”*
