# google-docs-mcp

In-place Google Docs editing for Claude Code. The first-party Drive connector can
create Docs but its `update_file` only changes title and parent — never the body.
This server closes that gap.

## Requirements

- Node 18 or newer (developed on 24)
- A Google account, and a Google Cloud project you can add an OAuth client to
- Claude Code

## Setup on a new machine

**1. Clone and install**

```bash
git clone https://github.com/zianncupcake/google-docs-mcp.git
cd google-docs-mcp
npm install
```

**2. Google Cloud — one-off per project** (existing setup uses project `docs-508014`)

- Enable **Google Docs API** and **Google Drive API**.
- APIs & Services → Credentials → Create credentials → **OAuth client ID** → application type
  **Desktop app**. The login listens on a random localhost port, which only the desktop
  type allows.
- Download the client JSON.

**3. Install the client JSON**

```bash
mkdir -p ~/.config/google-docs-mcp
cp ~/Downloads/client_secret_*.json ~/.config/google-docs-mcp/credentials.json
chmod 600 ~/.config/google-docs-mcp/credentials.json
```

**4. Authorise**

```bash
npm run auth
```

Prints the credentials path, the token path and the scopes, opens a consent URL, and
caches a refresh token at `~/.config/google-docs-mcp/token.json` (mode 600). It ends with
`✅ Authorised.` — anything else means the token was not written.

**5. Register with Claude Code**

```bash
claude mcp add gdocs -s user -- node "$PWD/index.mjs"
```

`-s user` registers it for every project on this machine. The path is stored absolute, so
run this from the repo directory (or substitute the full path).

**6. Restart Claude Code and check**

```bash
claude mcp list          # gdocs — ✓ Connected
```

Then ask Claude to read any Google Doc URL; `read_doc` returns its text.

## Tools

| tool | use |
|---|---|
| `read_doc` | text + per-run character indices (the edit tools need these) |
| `replace_all_text` | safest edit; no index arithmetic |
| `insert_text` / `delete_range` | surgical, index-based |
| `append_text` | resolves the end index for you |
| `replace_body` | swap the whole body via Drive upload, **keeps the URL** |
| `create_doc` | new doc, optionally from HTML |

## Configuration

| variable | default |
|---|---|
| `GOOGLE_OAUTH_CREDENTIALS` | `~/.config/google-docs-mcp/credentials.json` |
| `GOOGLE_DOCS_MCP_TOKEN` | `~/.config/google-docs-mcp/token.json` |
| `GOOGLE_DOCS_MCP_SCOPES` | `…/auth/documents …/auth/drive.file` (space separated) |

## Gotchas

- **Indices shift after every edit.** Re-read between edits, or batch into one call.
- `replace_body` needs the `drive.file` scope, which only covers files this app
  created. To rewrite a doc created elsewhere, add `https://www.googleapis.com/auth/drive`
  to `GOOGLE_DOCS_MCP_SCOPES` and re-run `npm run auth` — that grants full Drive access.
- `documents` scope already covers every doc you can open, so the index-based edit
  tools work on existing docs without widening anything.
- If Google Drive tools vanish in another terminal, unset `ANTHROPIC_API_KEY` — it
  takes precedence over the claude.ai login and disables connectors.
- If the login dies about a week after authorising, the Cloud consent screen is still in
  **Testing**, which expires refresh tokens after 7 days. Publish the app.
- **Set `namedStyleType` BEFORE text styling, never after.** An `updateParagraphStyle`
  that sets `namedStyleType` re-applies the named style and wipes run-level font, size
  and bold. In one batch: paragraph style → bullets → text style → indents (indents
  alone are safe to set last; `createParagraphBullets` resets them).

## Running it on a second machine

Repeat steps 1–6 there. Two things do **not** travel:

- **The Claude account carries no MCP config** — registrations live in that machine's
  `~/.claude.json`, so `claude mcp add` has to run on each one.
- **The Google login is per machine.** Reuse the same OAuth client (copy
  `credentials.json` or download it again), but run `npm run auth` locally rather than
  copying `token.json` — that file is a live refresh token. Authorising again does not
  invalidate the first machine.
