#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { google } from 'googleapis'
import { getAuth } from './auth.mjs'

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

const TOOLS = [
  { name: 'read_doc',
    description: 'Read a Google Doc as plain text plus the character index of each run, which is what the edit tools need for ranges.',
    inputSchema: { type: 'object', required: ['documentId'],
      properties: { documentId: { type: 'string', description: 'Doc id or full Docs URL' },
                    withIndices: { type: 'boolean', description: 'Also return the per-run index map (default true)' } } } },
  { name: 'replace_all_text',
    description: 'Replace every occurrence of a string throughout the document. The safest edit — no index arithmetic.',
    inputSchema: { type: 'object', required: ['documentId', 'find', 'replace'],
      properties: { documentId: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' },
                    matchCase: { type: 'boolean', description: 'Default true' },
                    revisionId: { type: 'string', description: 'From read_doc. The edit is refused if the document changed since.' } } } },
  { name: 'insert_text',
    description: 'Insert text at a character index. Get indices from read_doc first — they shift after every edit.',
    inputSchema: { type: 'object', required: ['documentId', 'index', 'text'],
      properties: { documentId: { type: 'string' }, index: { type: 'number' }, text: { type: 'string' },
                    revisionId: { type: 'string', description: 'From read_doc. The edit is refused if the document changed since.' } } } },
  { name: 'append_text',
    description: 'Append text to the end of the document body.',
    inputSchema: { type: 'object', required: ['documentId', 'text'],
      properties: { documentId: { type: 'string' }, text: { type: 'string' } } } },
  { name: 'delete_range',
    description: 'Delete the content between two character indices.',
    inputSchema: { type: 'object', required: ['documentId', 'startIndex', 'endIndex'],
      properties: { documentId: { type: 'string' }, startIndex: { type: 'number' }, endIndex: { type: 'number' },
                    revisionId: { type: 'string', description: 'From read_doc. The edit is refused if the document changed since.' } } } },
  { name: 'replace_body',
    description: 'DESTRUCTIVE: replaces the ENTIRE document body, discarding any edits made in the doc. Prefer replace_all_text or the index-based tools. Requires a revisionId from read_doc and refuses if the document changed since. Only works on docs this app created (drive.file scope).',
    inputSchema: { type: 'object', required: ['documentId', 'html', 'revisionId'],
      properties: { documentId: { type: 'string' }, html: { type: 'string', description: 'Full HTML document body' },
                    revisionId: { type: 'string', description: 'From read_doc. Required: the write is refused if the document changed since.' } } },
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

const handlers = {
  async read_doc({ documentId, withIndices = true }) {
    const { docs } = await apis()
    const id = docId(documentId)
    const { data } = await docs.documents.get({ documentId: id })
    const runs = flatten(data)
    const text = runs.map(r => r.text).join('')
    let out = `title: ${data.title}\nid: ${id}\nrevisionId: ${data.revisionId}\nendIndex: ${runs.at(-1)?.end ?? 1}\n`
      + `\nPass this revisionId to any edit tool; the edit is refused if the document changed since.\n`
      + `\n--- TEXT ---\n${text}`
    if (withIndices) {
      out += `\n\n--- INDEX MAP ---\n` +
        runs.map(r => `[${r.start}-${r.end}] ${JSON.stringify(r.text.slice(0, 80))}`).join('\n')
    }
    return out
  },

  async replace_all_text({ documentId, revisionId, find, replace, matchCase = true }) {
    const d = await batch(docId(documentId), [
      { replaceAllText: { containsText: { text: find, matchCase }, replaceText: replace } },
    ], revisionId)
    const n = d.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0
    return `Replaced ${n} occurrence(s) of ${JSON.stringify(find)}.` +
      (n === 0 ? ' Nothing matched — check exact casing and whitespace.' : '')
  },

  async insert_text({ documentId, revisionId, index, text }) {
    await batch(docId(documentId), [{ insertText: { location: { index }, text } }], revisionId)
    return `Inserted ${text.length} chars at index ${index}.`
  },

  async append_text({ documentId, text }) {
    const { docs } = await apis()
    const id = docId(documentId)
    const { data } = await docs.documents.get({ documentId: id })
    // The body's final newline is not a valid insert location, hence the -1.
    const end = (data.body.content.at(-1)?.endIndex ?? 2) - 1
    await batch(id, [{ insertText: { location: { index: end }, text } }])
    return `Appended ${text.length} chars at index ${end}.`
  },

  async delete_range({ documentId, revisionId, startIndex, endIndex }) {
    await batch(docId(documentId), [{ deleteContentRange: { range: { startIndex, endIndex } } }], revisionId)
    return `Deleted range ${startIndex}-${endIndex}.`
  },

  async replace_body({ documentId, html, revisionId }) {
    const { drive, docs } = await apis()
    const id = docId(documentId)
    // This overwrites the WHOLE document, so it is gated hardest: without a revisionId it
    // refuses outright, and a stale one is a refusal rather than a silent clobber.
    if (!revisionId) {
      throw new Error('replace_body replaces the entire document and needs a revisionId. Call read_doc first and pass the revisionId it returns.')
    }
    const live = (await docs.documents.get({ documentId: id, fields: 'revisionId' })).data.revisionId
    if (live !== revisionId) {
      throw new Error('The document changed since you read it. replace_body would discard those edits, so it was refused. Call read_doc again and rebuild the body from the current text.')
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
