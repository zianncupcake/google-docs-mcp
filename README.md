# google-docs-mcp

In-place Google Docs editing for Claude Code. The first-party Drive connector can
create Docs but its `update_file` only changes title and parent — never the body.
This server closes that gap.

## Setup

1. Enable **Google Docs API** and **Google Drive API** on Cloud project `docs-508014`.
2. `npm install`
3. `npm run auth` — opens a consent URL, caches a refresh token at
   `~/.config/google-docs-mcp/token.json` (mode 600).
4. Restart Claude Code.

Registered at user scope via:
`claude mcp add gdocs -s user -- node ~/Atlas/tools/google-docs-mcp/index.mjs`

## Tools

| tool | use |
|---|---|
| `read_doc` | text + per-run character indices (the edit tools need these) |
| `replace_all_text` | safest edit; no index arithmetic |
| `insert_text` / `delete_range` | surgical, index-based |
| `append_text` | resolves the end index for you |
| `replace_body` | swap the whole body via Drive upload, **keeps the URL** |
| `create_doc` | new doc, optionally from HTML |

## Gotchas

- **Indices shift after every edit.** Re-read between edits, or batch into one call.
- `replace_body` needs the `drive.file` scope, which only covers files this app
  created. To rewrite a doc created elsewhere, add `https://www.googleapis.com/auth/drive`
  to `GOOGLE_DOCS_MCP_SCOPES` and re-run `npm run auth` — that grants full Drive access.
- `documents` scope already covers every doc you can open, so the index-based edit
  tools work on existing docs without widening anything.
- If Google Drive tools vanish in another terminal, unset `ANTHROPIC_API_KEY` — it
  takes precedence over the claude.ai login and disables connectors.
- **Set `namedStyleType` BEFORE text styling, never after.** An `updateParagraphStyle`
  that sets `namedStyleType` re-applies the named style and wipes run-level font, size
  and bold. In one batch: paragraph style → bullets → text style → indents (indents
  alone are safe to set last; `createParagraphBullets` resets them).
