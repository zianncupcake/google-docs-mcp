// keepWithNext is a plain boolean on ParagraphStyle (not a pt() measurement), so the one bug
// worth guarding is that it reaches the API as a boolean and names itself in fields. Driving
// the real handler with a mocked batchUpdate pins that down without touching Google.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCallTool } from '../tools.mjs'

const REVISION = 'rev-1'
// One paragraph "hello", body indices starting at 1, wrapped as loadDoc expects a tab.
const doc = () => ({
  title: 'T', revisionId: REVISION,
  tabs: [{ tabProperties: { tabId: 't.0', title: 'Tab' }, documentTab: { body: { content: [
    { paragraph: { elements: [{ startIndex: 1, endIndex: 6, textRun: { content: 'hello' } }] } },
  ] } } }],
})

test('format_paragraph sends keepWithNext as a boolean in the batchUpdate request', async (t) => {
  const saved = process.env.GOOGLE_DOCS_MCP_BASELINE
  process.env.GOOGLE_DOCS_MCP_BASELINE = 'off'
  t.after(() => { if (saved === undefined) delete process.env.GOOGLE_DOCS_MCP_BASELINE; else process.env.GOOGLE_DOCS_MCP_BASELINE = saved })

  let sent
  const google = { getDoc: async () => doc(), batchUpdate: async (_id, body) => { sent = body; return {} } }
  const callTool = createCallTool({ google, baseline: {} })

  const res = await callTool('format_paragraph', { documentId: 'doc1', startIndex: 1, endIndex: 6, keepWithNext: true, revisionId: REVISION })
  assert.equal(res.isError, undefined)

  const style = sent.requests.find(r => r.updateParagraphStyle).updateParagraphStyle
  assert.equal(style.paragraphStyle.keepWithNext, true)
  assert.ok(style.fields.split(',').includes('keepWithNext'))
})
