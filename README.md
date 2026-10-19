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
| `read_doc` | text, per-run character indices and styles, baseline status, protected ranges (when the opt-in marker guard is on), page setup, tabs, tables, images, named ranges, header/footer/footnotes |
| `replace_all_text` | safest edit; no index arithmetic |
| `insert_text` / `delete_range` | surgical, index-based |
| `replace_range` | swap the text between two indices in one atomic call |
| `append_text` | resolves the end index for you |
| `format_text` | bold, italic, underline, strikethrough, size, font, colours, link — by `find` text or index range |
| `format_paragraph` | alignment, heading level, line spacing, spacing, indents, bullets |
| `set_page_setup` | margins, page size (A4 / LETTER / LEGAL or custom), orientation |
| `insert_table` | new table, optionally filled from a 2D array |
| `edit_table` | insert/delete a row or column, merge/unmerge cells, column width, delete the table |
| `set_table_cell_text` | replace one cell's text |
| `style_table_cells` | fill, borders, padding, vertical alignment — one block or the whole table |
| `insert_image` / `replace_image` | inline image from a public URL; swap one in place |
| `insert_break` | page break, or a section break (new page / continuous) |
| `set_section_columns` | 1–3 newspaper-style columns on a section |
| `set_header_footer` | set, replace or remove the page header or footer |
| `insert_footnote` | footnote at an index or after matched text |
| `create_named_range` / `replace_named_range` / `delete_named_range` | bookmark a span, rewrite it later without indices |
| `replace_body` | swap the whole body via Drive upload, **keeps the URL** |
| `create_doc` | new doc, optionally from HTML |
| `sync_baseline` | adopt the doc's current text as the baseline; the only way to clear drift |

Every tool takes an optional `tabId`. Without one it uses the tab named in the URL
(`?tab=t.…`), else the first tab; `read_doc` lists a document's tabs. Tables are addressed
by their 1-based number in reading order, cells by 1-based row and column. Text can be
addressed by `find` (exact text, with `occurrence` when it matches more than once) or by
index range.

## Protecting your own writing — the marker guard (opt-in, off by default)

> **Off by default.** The [content baseline](#the-baseline--catching-what-revisionid-cannot)
> is the primary protection and it is always on. The marker guard is a second, narrower
> mechanism you switch on yourself:
>
> ```bash
> GOOGLE_DOCS_MCP_PROTECT=italic      # or: highlight, both
> ```
>
> **Why it is no longer the default.** Italic is ordinary formatting — document subtitles,
> emphasis, titles of works. Treating it as a protection marker silently marked text nobody
> meant to protect, and then refused edits the user had explicitly asked for. The baseline
> catches the case that actually matters (someone changed the doc since the last write,
> including deletions, which no marker can survive), so the marker guard is opt-in and an
> unset *or misspelled* `GOOGLE_DOCS_MCP_PROTECT` leaves it off. Use `highlight` if you want
> a marker that is not also everyday formatting.

With it on, every mutating tool refuses to touch text you marked in the document. **Italicise
it** (or highlight it) and the edit tools will work around it. Nothing is stored outside the
doc — the marker is the formatting, so it survives sharing, copying and editing by hand.

Two guarantees, and neither can be bypassed by accident:

- **Read before write.** `revisionId` is required on `replace_all_text`, `insert_text`,
  `delete_range`, `replace_range` and `replace_body`. The server re-fetches the document
  itself before every write, refuses if the live revision differs from the one you passed,
  and computes the protected ranges from that same fetch — so the check can never run
  against a stale copy.
- **Protected ranges are off limits.** `insert_text` refuses an index strictly inside one
  (inserting at either edge is fine); `delete_range` and `replace_range` refuse a range
  that overlaps one; `replace_all_text` refuses the whole call if any occurrence of `find`
  lands in one, because the Docs API replaces every occurrence atomically and cannot skip
  some; `replace_body` refuses if the doc contains any protected text at all.
  `append_text` is always allowed — it only adds at the end — but it strips the marker off
  the text it inserts, which would otherwise be inherited from the run above it.
  `create_doc` is unaffected.
- **The formatting and structure tools follow the same rules.** All of them require
  `revisionId`. `format_text` refuses a range that overlaps protected text (it could remove
  the marker itself); `format_paragraph` refuses only `namedStyleType` on a paragraph
  holding protected text, since that wipes italics; `insert_table`, `insert_image`,
  `insert_break` and `insert_footnote` refuse an index strictly inside protected text;
  `set_table_cell_text`, `replace_named_range` and the `edit_table` deletes refuse to
  overwrite or remove it. Page setup, cell styling, columns and named-range bookkeeping
  change no text, so they have no protection check.
- **Text inside table cells is covered** by protection and by the baseline. Header, footer
  and footnote text is not — it sits outside the body.

Each mutating tool takes an optional `allowProtected: true` that skips the protection
check **only** — the `revisionId` check still applies. It is for when you have explicitly
asked for your own marked text to be overwritten.

`read_doc` lists the ranges under a `--- PROTECTED ---` section (pass
`withProtected: false` to omit it). With no mode set it reads `disabled
(GOOGLE_DOCS_MCP_PROTECT=off)` rather than `(none)`, so "nothing is marked" is never
confused with "nothing was checked".

## The baseline — catching what `revisionId` cannot

This is the protection that is on by default, and the one doing the real work.

`revisionId` only covers the gap between one read and the write that immediately follows
it. It is blind to the gap that actually matters: a change you made **between the
assistant's last write and its next read**. By the time it re-reads, your version *is* the
current revision, so the stale-edit check passes and the regenerated text lands on top of
your edit with the server's blessing.

Deletions are the case nothing else catches. Marker protection can only defend text that
still exists — delete a paragraph and the marker goes with it — and it is off unless you ask
for it. The baseline covers both.

So the server keeps its own copy of what it last wrote, and compares **content**, not
revisions. After every successful mutating call it re-fetches the document and snapshots
the text; before every write it diffs that snapshot against the live document, paragraph by
paragraph (an LCS diff, so a paragraph you merely moved is not reported as a change). If
anything was removed or added in between, the write is refused with a summary of what
changed:

```
delete_range refused: 2 paragraphs removed, 1 added since my last write
removed:
  - "The pilot ran for six weeks across three teams."
  …
```

**`sync_baseline` is the only way to clear drift**, and that asymmetry is the point. No
edit tool has a flag to override it — `allowProtected` applies to the italic/highlight
check only and never to drift. The intended recovery is `read_doc` to see what the document
actually says now, decide what to keep, then `sync_baseline` to adopt it — not re-sending
the same edit. `sync_baseline` writes nothing to the document; it only moves the snapshot.

`read_doc` reports the current state under a `--- BASELINE ---` section — `in sync`, `no
baseline recorded`, or the drift description (pass `withBaseline: false` to omit it).

The baseline is kept per tab, and it includes table text. A document with tables whose
snapshot predates that will report its table text as added once; `sync_baseline` clears it.

Snapshots live one JSON file per document (plus one per extra tab) at
`~/.config/google-docs-mcp/snapshots/<documentId>.json` (mode 600 — they contain the
document's text). A missing or unreadable snapshot degrades to "no baseline", never to an
error; the next write re-creates it.

## Configuration

| variable | default |
|---|---|
| `GOOGLE_OAUTH_CREDENTIALS` | `~/.config/google-docs-mcp/credentials.json` |
| `GOOGLE_DOCS_MCP_TOKEN` | `~/.config/google-docs-mcp/token.json` |
| `GOOGLE_DOCS_MCP_SCOPES` | `…/auth/documents …/auth/drive.file` (space separated) |
| `GOOGLE_DOCS_MCP_PROTECT` | `off` — the marker guard is opt-in. Set `italic`, `highlight` (any non-white background colour) or `both` to switch it on. Unset, empty or unrecognised all mean `off`, so a typo never blocks a write; the baseline is the always-on protection. |
| `GOOGLE_DOCS_MCP_SNAPSHOTS` | `~/.config/google-docs-mcp/snapshots` — directory holding one baseline snapshot per document. |
| `GOOGLE_DOCS_MCP_BASELINE` | on. Set to `off` to disable drift detection entirely. Any other value leaves it on. |

## Tests

```bash
npm test
```

Runs the protection rules against hand-built documents and the drift diff against plain
text. No credentials, no network.

```bash
npm run test:e2e
```

Drives the real server over stdio against scratch docs it creates and then moves to the
Drive trash, with snapshots in a temp directory. Covers every formatting and structure tool,
including the calls that must be refused, and exits non-zero on any failed check. Needs the
Google login and takes about four minutes.

`worker/` has its own tests: `cd worker && npm install && npm test`.

## Gotchas

- **Indices shift after every edit.** Re-read between edits. To rewrite a region, use
  `replace_range` rather than `delete_range` + `insert_text` — it is one atomic call, so
  nothing shifts in between.
- `replace_body` needs the `drive.file` scope, which only covers files this app
  created. To rewrite a doc created elsewhere, add `https://www.googleapis.com/auth/drive`
  to `GOOGLE_DOCS_MCP_SCOPES` and re-run `npm run auth` — that grants full Drive access.
- `documents` scope already covers every doc you can open, so the index-based edit
  tools work on existing docs without widening anything.
- If Google Drive tools vanish in another terminal, unset `ANTHROPIC_API_KEY` — it
  takes precedence over the claude.ai login and disables connectors.
- If the login dies about a week after authorising, the Cloud consent screen is still in
  **Testing**, which expires refresh tokens after 7 days. Publish the app.
- **`find` refuses an ambiguous match.** Text that appears more than once needs `occurrence`
  (a 1-based number, or `"all"`).
- **Docs underlines and recolours any text you link.** Clearing the link with `link: ""`
  leaves that underline; pass `underline: false` with it.
- `read_doc`'s index map shows each run's styles in braces, e.g. `{bold,14pt}`, which is how
  to confirm a format call landed. Bolding every character of a line also bolds its line
  ending, so the run shows as `"text\n" {bold}`.
- **Merging cells moves their text into the first cell**, and unmerging leaves it there.
- **Docs keeps an image's proportions.** `width` and `height` are a box it is fitted into, so
  a 60×20 request can come back 59×20.
- **A section break is needed before `set_section_columns`** if only part of the document
  should be in columns; otherwise the whole first section changes.
- The server can read and edit any tab but has no tool to create one.
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

## Hosted (Cloudflare)

`worker/` serves the same tools as a remote MCP server on Cloudflare Workers, so claude.ai
(or any MCP client) can add it as a custom connector. Each person signs in with their own
Google account. It fits the Workers free plan.

**1. Google Cloud** — a new OAuth client, separate from the desktop one above

- Enable **Google Docs API** and **Google Drive API**.
- OAuth consent screen: add the scopes `openid`, `…/auth/documents` and `…/auth/drive.file`,
  then **publish** the app. In Testing, only listed test users can sign in and Google expires
  their refresh tokens after 7 days.
- Credentials → Create credentials → **OAuth client ID** → **Web application**, with the
  authorised redirect URI `https://google-docs-mcp.<subdomain>.workers.dev/callback`.
  `<subdomain>` is your account's workers.dev subdomain (Workers & Pages in the Cloudflare
  dashboard); `google-docs-mcp` is `name` in `worker/wrangler.jsonc`.
- Branding page: the Worker serves the homepage at `/` and the privacy policy at `/privacy`.
  Their contact email and wording live in `worker/pages.mjs`.

**2. Deploy**

```bash
cd worker
npm install
npx wrangler login
npx wrangler deploy          # the first deploy also creates the OAUTH_KV namespace and the Baselines Durable Object
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

**3. Connect** — in claude.ai, Settings → Connectors → Add custom connector, URL
`https://google-docs-mcp.<subdomain>.workers.dev/mcp`. Connecting shows this server's page
naming the app that asked, then Google's sign-in.

**Deploying** — after the first deploy, merging to `main` deploys: CI runs both test suites,
then `wrangler deploy`, then checks the live Worker. The repository needs two GitHub secrets,
`CLOUDFLARE_API_TOKEN` (a Cloudflare API token from the "Edit Cloudflare Workers" template) and
`CLOUDFLARE_ACCOUNT_ID`. The Google client id and secret stay Worker secrets, set with
`wrangler secret put` as above; GitHub never sees them. The KV namespace ids in
`worker/wrangler.jsonc` are this deployment's, so a fork deploying its own Worker replaces them.

Same tools and gotchas as the local server; `replace_body` still only works on docs created
through this connector.

**Limits**

- Free-plan Workers get 10 ms of CPU per request. Reading or diffing a very large document can
  run out and fail; the local server has no such limit.
- Free-plan Workers KV allows 1,000 writes a day for the whole account. Each sign-in and hourly
  token refresh writes a few OAuth records, so the free plan suits a handful of active users.
  Baseline snapshots are in a Durable Object, whose free-plan limits are far higher.
- A connection lasts 30 days, then the client asks to connect again. If someone removes the
  app's access in their Google account, their tool calls fail until the next hourly refresh,
  which then asks them to connect again.

**Privacy**

- Google access and refresh tokens are kept in `OAUTH_KV`, encrypted by the OAuth provider with
  a key only the holder of the user's MCP token can unwrap.
- Baseline snapshots hold the **whole text** of every document the server edits, unencrypted,
  in a Durable Object of the user's own (`Baselines`). Anyone with access to the Cloudflare
  account can read them. Each is deleted 30 days after its last save; after that the next edit of
  that document runs as if there were no baseline yet.

**Distribution**

`documents` is a Google *sensitive* scope. Until the app passes Google's OAuth verification,
users see an "unverified app" warning, and the project is capped at 100 users for its
lifetime. Verification needs a homepage and a privacy policy on a domain you own.
