#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { google } from 'googleapis'
import { getAuth } from './auth.mjs'
import { TOOLS, createCallTool, driveQuery } from './tools.mjs'
import * as snapshots from './snapshots.mjs'

let _auth, _docs, _drive
async function apis() {
  if (!_docs) {
    _auth = await getAuth()
    _docs = google.docs({ version: 'v1', auth: _auth })
    _drive = google.drive({ version: 'v3', auth: _auth })
  }
  return { auth: _auth, docs: _docs, drive: _drive }
}

const googleDocs = {
  async getDoc(documentId) {
    const { docs } = await apis()
    return (await docs.documents.get({ documentId, includeTabsContent: true })).data
  },
  async batchUpdate(documentId, requestBody) {
    const { docs } = await apis()
    return (await docs.documents.batchUpdate({ documentId, requestBody })).data
  },
  async createDoc({ title, html, folderId }) {
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
    return res.data
  },
  async replaceDocHtml(fileId, html) {
    const { drive } = await apis()
    await drive.files.update({ fileId, media: { mimeType: 'text/html', body: html } })
  },
  async findFiles({ query, limit, mimeType }) {
    const { drive } = await apis()
    const res = await drive.files.list({
      q: driveQuery(query, mimeType),
      pageSize: Math.min(Math.max(limit, 1), 100),
      orderBy: 'modifiedTime desc',
      fields: 'files(id,name,modifiedTime,webViewLink)',
      spaces: 'drive',
    })
    return res.data.files ?? []
  },
  // The same download as worker/google-api.mjs, over fetch: googleapis has no call for the Docs export URL.
  async exportDoc(id, format) {
    const { auth } = await apis()
    const { token } = await auth.getAccessToken()
    const res = await fetch(`https://docs.google.com/document/d/${encodeURIComponent(id)}/export?format=${format}`, { headers: { Authorization: `Bearer ${token}` } })
    if (res.status === 429) throw new Error('Google is rate-limiting exports. Try again in a moment.')
    if (!res.ok) throw new Error(`Google answered ${res.status}`)
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mimeType: res.headers.get('Content-Type').split(';')[0],
      filename: decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(res.headers.get('Content-Disposition'))[1]),
    }
  },
}

const callTool = createCallTool({ google: googleDocs, baseline: snapshots })

const server = new Server({ name: 'google-docs-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
server.setRequestHandler(CallToolRequestSchema, (req) => callTool(req.params.name, req.params.arguments))

await server.connect(new StdioServerTransport())
