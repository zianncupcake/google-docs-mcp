#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { google } from 'googleapis'
import { getAuth } from './auth.mjs'
import { protectMode, protectedRanges, overlapping, strictlyInside, textAt, findOccurrences } from './protect.mjs'

let _docs, _drive
async function apis() {
  if (!_docs) {
    const auth = await getAuth()
    _docs = google.docs({ version: 'v1', auth })
    _drive = google.drive({ version: 'v3', auth })
  }
  return { docs: _docs, drive: _drive }
}

// Accepts a bare id or any /document/d/<id>/ URL.
function docId(input) {
  const m = String(input).match(/\/d\/([a-zA-Z0-9_-]{20,})/)
  return m ? m[1] : String(input).trim()
}

function flatten(doc) {
  const runs = []
  for (const el of doc.body?.content ?? []) {
    for (const pe of el.paragraph?.elements ?? []) {
      const t = pe.textRun?.content
      if (t) runs.push({ start: pe.startIndex, end: pe.endIndex, text: t })
    }
  }
  return runs
}

const REV = 'From read_doc. Required: the edit is refused if the document changed since.'
const ALLOW = 'Skip the protected-text check. Only pass true when the user has explicitly asked to overwrite their own marked text. The revisionId check still applies.'

const TOOLS = [
  { name: 'read_doc',
    description: 'Read a Google Doc as plain text plus the character index of each run, which is what the edit tools need for ranges. Also lists the ranges the user marked as protected — the edit tools refuse to touch those.',
    inputSchema: { type: 'object', required: ['documentId'],
      properties: { documentId: { type: 'string', description: 'Doc id or full Docs URL' },
                    withIndices: { type: 'boolean', description: 'Also return the per-run index map (default true)' },
                    withProtected: { type: 'boolean', description: 'Also return the protected ranges (default true)' } } } },
  { name: 'replace_all_text',
    description: 'Replace every occurrence of a string throughout the document. The safest edit — no index arithmetic. Refused if any occurrence sits in protected text, because the API replaces all of them at once.',
    inputSchema: { type: 'object', required: ['documentId', 'find', 'replace', 'revisionId'],
      properties: { documentId: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' },
                    matchCase: { type: 'boolean', description: 'Default true' },
                    revisionId: { type: 'string', description: REV },
                    allowProtected: { type: 'boolean', description: ALLOW } } } },
  { name: 'insert_text',
    description: 'Insert text at a character index. Get indices from read_doc first — they shift after every edit. Refused if the index falls inside protected text; inserting at either edge of it is fine.',
    inputSchema: { type: 'object', required: ['documentId', 'index', 'text', 'revisionId'],
      properties: { documentId: { type: 'string' }, index: { type: 'number' }, text: { type: 'string' },
                    revisionId: { type: 'string', description: REV },
                    allowProtected: { type: 'boolean', description: ALLOW } } } },
  { name: 'append_text',
    description: 'Append text to the end of the document body. Always allowed — it adds, never overwrites — and the appended text is stripped of the protection marker so it does not inherit one from the text above it.',
    inputSchema: { type: 'object', required: ['documentId', 'text'],
      properties: { documentId: { type: 'string' }, text: { type: 'string' },
                    allowProtected: { type: 'boolean', description: 'Keep whatever styling the appended text inherits, marker included. Only pass true when the user has explicitly asked for that.' } } } },
  { name: 'delete_range',
    description: 'Delete the content between two character indices. Refused if the range overlaps protected text.',
    inputSchema: { type: 'object', required: ['documentId', 'startIndex', 'endIndex', 'revisionId'],
      properties: { documentId: { type: 'string' }, startIndex: { type: 'number' }, endIndex: { type: 'number' },
                    revisionId: { type: 'string', description: REV },
                    allowProtected: { type: 'boolean', description: ALLOW } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
  { name: 'replace_range',
    description: 'Replace the text between two character indices with new text, in one atomic call. Use this instead of delete_range + insert_text, whose indices shift in between. Refused if the range overlaps protected text.',
    inputSchema: { type: 'object', required: ['documentId', 'startIndex', 'endIndex', 'text', 'revisionId'],
      properties: { documentId: { type: 'string' }, startIndex: { type: 'number' }, endIndex: { type: 'number' },
                    text: { type: 'string' }, revisionId: { type: 'string', description: REV },
                    allowProtected: { type: 'boolean', description: ALLOW } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
  { name: 'replace_body',
    description: 'DESTRUCTIVE: replaces the ENTIRE document body, discarding any edits made in the doc. Prefer replace_all_text or the index-based tools. Requires a revisionId from read_doc and refuses if the document changed since, or if the document contains any protected text at all. Only works on docs this app created (drive.file scope).',
    inputSchema: { type: 'object', required: ['documentId', 'html', 'revisionId'],
      properties: { documentId: { type: 'string' }, html: { type: 'string', description: 'Full HTML document body' },
                    revisionId: { type: 'string', description: REV },
                    allowProtected: { type: 'boolean', description: ALLOW } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
  { name: 'create_doc',
    description: 'Create a new Google Doc, optionally from HTML. Returns its id and URL.',
    inputSchema: { type: 'object', required: ['title'],
      properties: { title: { type: 'string' }, html: { type: 'string' }, folderId: { type: 'string' } } } },
]

const server = new Server({ name: 'google-docs-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

// requiredRevisionId makes a stale edit FAIL instead of silently overwriting whatever
// the document became since the caller last read it.
async function batch(documentId, requests, revisionId) {
  const { docs } = await apis()
  const requestBody = { requests, ...(revisionId ? { writeControl: { requiredRevisionId: revisionId } } : {}) }
  try {
    const res = await docs.documents.batchUpdate({ documentId, requestBody })
    return res.data
  } catch (e) {
    const msg = e?.response?.data?.error?.message || e.message
    if (/revision/i.test(msg)) {
      throw new Error(`The document changed since you read it, so this edit was refused rather than overwriting someone else's work. Call read_doc again and redo the edit against the current text. (${msg})`)
    }
    throw e
  }
}

// Read before write, once: the same fetch that proves the caller holds the current
// revision also supplies the protected ranges, so the protection check can never be
// made against a copy of the document that has since moved on.
async function preflight(tool, documentId, revisionId, allowProtected) {
  const { docs } = await apis()
  const id = docId(documentId)
  if (!revisionId) {
    throw new Error(`${tool} needs a revisionId so a stale edit cannot silently overwrite newer text. Call read_doc first and pass the revisionId it returns.`)
  }
  const { data } = await docs.documents.get({ documentId: id })
  if (data.revisionId !== revisionId) {
    throw new Error(`${tool} refused: the document changed since you read it (you passed ${revisionId}, it is now ${data.revisionId}). Call read_doc again and redo the edit against the current text.`)
  }
  const mode = protectMode()
  // allowProtected drops the protection check only — the revision check above still ran.
  return { id, doc: data, mode, ranges: allowProtected ? [] : protectedRanges(data, mode) }
}

function quote(doc, [s, e]) {
  return JSON.stringify(textAt(doc, s, e).replace(/\s+/g, ' ').slice(0, 60))
}

// One shape for every protection refusal: what was attempted, what it would have hit,
// and the two ways out.
function refuse(tool, what, doc, range, mode, extra = '') {
  return new Error(`${tool} refused: ${what} text the user marked as protected (${mode}) at ${range[0]}-${range[1]}: ${quote(doc, range)}.${extra} Re-read the doc and edit around it, or pass allowProtected: true only if the user explicitly asked to replace their own text.`)
}

const handlers = {
  async read_doc({ documentId, withIndices = true, withProtected = true }) {
    const { docs } = await apis()
    const id = docId(documentId)
    const { data } = await docs.documents.get({ documentId: id })
    const runs = flatten(data)
    const text = runs.map(r => r.text).join('')
    let out = `title: ${data.title}\nid: ${id}\nrevisionId: ${data.revisionId}\nendIndex: ${runs.at(-1)?.end ?? 1}\n`
      + `\nPass this revisionId to any edit tool; the edit is refused if the document changed since.\n`
    if (withProtected) {
      const mode = protectMode()
      const ranges = protectedRanges(data, mode)
      out += `\n--- PROTECTED ---\n` + (ranges.length
        ? ranges.map(r => `[${r[0]}-${r[1]}] ${quote(data, r)}`).join('\n')
        : '(none)') + '\n'
    }
    out += `\n--- TEXT ---\n${text}`
    if (withIndices) {
      out += `\n\n--- INDEX MAP ---\n` +
        runs.map(r => `[${r.start}-${r.end}] ${JSON.stringify(r.text.slice(0, 80))}`).join('\n')
    }
    return out
  },

  async replace_all_text({ documentId, revisionId, find, replace, matchCase = true, allowProtected = false }) {
    const { id, doc, mode, ranges } = await preflight('replace_all_text', documentId, revisionId, allowProtected)
    const hits = findOccurrences(doc, find, matchCase)
    const blocked = hits.filter(([s, e]) => overlapping(ranges, s, e))
    if (blocked.length) {
      const hit = overlapping(ranges, blocked[0][0], blocked[0][1])
      throw refuse('replace_all_text', `${blocked.length} of ${hits.length} occurrence(s) of ${JSON.stringify(find)} land in`, doc, hit, mode,
        ` The other ${hits.length - blocked.length} are safe, but the Docs API replaces every occurrence in one atomic call and cannot skip any, so the whole call was refused; narrow the find string, or use replace_range on the safe occurrences one at a time.`)
    }
    const d = await batch(id, [
      { replaceAllText: { containsText: { text: find, matchCase }, replaceText: replace } },
    ], revisionId)
    const n = d.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0
    return `Replaced ${n} occurrence(s) of ${JSON.stringify(find)}.` +
      (n === 0 ? ' Nothing matched — check exact casing and whitespace.' : '')
  },

  async insert_text({ documentId, revisionId, index, text, allowProtected = false }) {
    const { id, doc, mode, ranges } = await preflight('insert_text', documentId, revisionId, allowProtected)
    const hit = strictlyInside(ranges, index)
    if (hit) throw refuse('insert_text', `the index ${index} falls inside`, doc, hit, mode,
      ` Inserting at ${hit[0]} or ${hit[1]} instead would leave it intact.`)
    await batch(id, [{ insertText: { location: { index }, text } }], revisionId)
    return `Inserted ${text.length} chars at index ${index}.`
  },

  async append_text({ documentId, text, allowProtected = false }) {
    const { docs } = await apis()
    const id = docId(documentId)
    const { data } = await docs.documents.get({ documentId: id })
    // The body's final newline is not a valid insert location, hence the -1.
    const end = (data.body.content.at(-1)?.endIndex ?? 2) - 1
    const mode = protectMode()
    const requests = [{ insertText: { location: { index: end }, text } }]
    // Inserted text inherits the style of the run it follows, so appending below protected
    // text would quietly mark the new text protected too. Strip the marker back off.
    const clearHighlight = mode === 'highlight' || mode === 'both'
    if (!allowProtected && mode !== 'off') {
      requests.push({ updateTextStyle: {
        range: { startIndex: end, endIndex: end + text.length },
        textStyle: { italic: false, ...(clearHighlight ? { backgroundColor: {} } : {}) },
        fields: clearHighlight ? 'italic,backgroundColor' : 'italic',
      } })
    }
    // The revisionId from the fetch above makes the append atomic with the end index it read.
    await batch(id, requests, data.revisionId)
    return `Appended ${text.length} chars at index ${end}.`
  },

  async delete_range({ documentId, revisionId, startIndex, endIndex, allowProtected = false }) {
    const { id, doc, mode, ranges } = await preflight('delete_range', documentId, revisionId, allowProtected)
    const hit = overlapping(ranges, startIndex, endIndex)
    if (hit) throw refuse('delete_range', `the range ${startIndex}-${endIndex} overlaps`, doc, hit, mode)
    await batch(id, [{ deleteContentRange: { range: { startIndex, endIndex } } }], revisionId)
    return `Deleted range ${startIndex}-${endIndex}.`
  },

  async replace_range({ documentId, revisionId, startIndex, endIndex, text, allowProtected = false }) {
    const { id, doc, mode, ranges } = await preflight('replace_range', documentId, revisionId, allowProtected)
    const hit = overlapping(ranges, startIndex, endIndex)
    if (hit) throw refuse('replace_range', `the range ${startIndex}-${endIndex} overlaps`, doc, hit, mode)
    // Delete and insert in one batch: separate calls would leave the doc half-edited and
    // every index after the deletion already shifted.
    await batch(id, [
      { deleteContentRange: { range: { startIndex, endIndex } } },
      { insertText: { location: { index: startIndex }, text } },
    ], revisionId)
    return `Replaced ${startIndex}-${endIndex} with ${text.length} chars.`
  },

  async replace_body({ documentId, html, revisionId, allowProtected = false }) {
    const { drive } = await apis()
    // This overwrites the WHOLE document, so it is gated hardest: a missing or stale
    // revisionId is a refusal rather than a silent clobber, and any protected text at all
    // blocks it, since there is no way to rewrite the body and keep that text.
    const { id, doc, mode, ranges } = await preflight('replace_body', documentId, revisionId, allowProtected)
    if (ranges.length) {
      throw refuse('replace_body', `the document contains`, doc, ranges[0], mode,
        `${ranges.length > 1 ? ` There are ${ranges.length} protected ranges in all.` : ''} replace_body rewrites the entire body, so all of it would be discarded; use replace_range on the sections you actually mean to change.`)
    }
    await drive.files.update({
      fileId: id,
      media: { mimeType: 'text/html', body: html },
    })
    return `Replaced body of ${id}. URL unchanged: https://docs.google.com/document/d/${id}/edit`
  },

  async create_doc({ title, html, folderId }) {
    const { drive } = await apis()
    const res = await drive.files.create({
      requestBody: {
        name: title,
        mimeType: 'application/vnd.google-apps.document',
        ...(folderId ? { parents: [folderId] } : {}),
      },
      ...(html ? { media: { mimeType: 'text/html', body: html } } : {}),
      fields: 'id,name',
    })
    return `Created "${res.data.name}"\nid: ${res.data.id}\nhttps://docs.google.com/document/d/${res.data.id}/edit`
  },
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const fn = handlers[req.params.name]
  if (!fn) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }] }
  try {
    return { content: [{ type: 'text', text: await fn(req.params.arguments ?? {}) }] }
  } catch (e) {
    const detail = e?.response?.data?.error?.message || e.message
    return { isError: true, content: [{ type: 'text', text: `${req.params.name} failed: ${detail}` }] }
  }
})

await server.connect(new StdioServerTransport())
