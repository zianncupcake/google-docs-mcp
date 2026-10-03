import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { google } from 'googleapis'
import { getAuth } from '../auth.mjs'

export async function connect() {
  const client = new Client({ name: 'gdocs-e2e', version: '0' }, { capabilities: {} })
  // Scratch-doc baselines go to a temp dir, never the user's real snapshot folder.
  const snapshots = await mkdtemp(join(tmpdir(), 'gdocs-mcp-e2e-'))
  await client.connect(new StdioClientTransport({
    command: 'node', args: [fileURLToPath(new URL('../index.mjs', import.meta.url))],
    env: { ...process.env, GOOGLE_DOCS_MCP_SNAPSHOTS: snapshots },
  }))
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args })
    return { error: !!res.isError, text: res.content[0].text }
  }
  // An edit with the live revisionId, unless the caller pins one to prove a stale id is refused.
  const edit = async (name, args) => {
    const read = await call('read_doc', { documentId: args.documentId, withIndices: false, withProtected: false, withBaseline: false })
    return call(name, { revisionId: /revisionId: (\S+)/.exec(read.text)[1], ...args })
  }
  let failures = 0
  const check = (label, pass, detail = '') => {
    if (!pass) failures++
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `\n      ${detail}`}`)
  }
  const auth = await getAuth()
  const docs = google.docs({ version: 'v1', auth })
  const drive = google.drive({ version: 'v3', auth })

  // Drive answers the first HTML upload of a session with a 500 often enough to need a retry.
  const scratch = async (html) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const created = await call('create_doc', { title: 'gdocs-mcp scratch', html })
      if (!created.error) return /id: (\S+)/.exec(created.text)[1]
      console.log(`create_doc attempt ${attempt} failed: ${created.text}`)
    }
    process.exit(1)
  }
  const finish = async (documentId) => {
    await drive.files.update({ fileId: documentId, requestBody: { trashed: true } })
    console.log('scratch doc moved to trash')
    await client.close()
    console.log(failures ? `${failures} FAILED` : 'ALL PASSED')
    process.exit(failures ? 1 : 0)
  }
  return { client, call, edit, check, docs, scratch, finish }
}
