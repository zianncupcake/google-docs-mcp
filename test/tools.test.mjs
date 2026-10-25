// The two paragraph-format features, driven through the real handlers with a fake Google
// client that records the batchUpdate it would send — no credentials, no network. The
// baseline is switched off so a handler's path is just preflight → build requests.
process.env.GOOGLE_DOCS_MCP_BASELINE = 'off'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCallTool } from '../tools.mjs'

// One numbered, indented paragraph and one plain one, with the list the bullet points into.
const doc = {
  title: 'T', revisionId: 'rev1',
  tabs: [{
    tabProperties: { tabId: 't.0', title: 'Main' },
    documentTab: {
      body: { content: [
        { startIndex: 1, endIndex: 8, paragraph: {
          elements: [{ startIndex: 1, endIndex: 8, textRun: { content: 'Agenda\n', textStyle: {} } }],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT', indentStart: { magnitude: 18, unit: 'PT' } },
          bullet: { listId: 'kix.src', nestingLevel: 0 },
        } },
        { startIndex: 8, endIndex: 14, paragraph: {
          elements: [{ startIndex: 8, endIndex: 14, textRun: { content: 'Notes\n', textStyle: {} } }],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        } },
      ] },
      lists: { 'kix.src': { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL' }] } } },
    },
  }],
}

function run() {
  const calls = []
  const google = { getDoc: async () => doc, batchUpdate: async (_id, body) => { calls.push(body); return {} } }
  return { call: createCallTool({ google, baseline: { load: async () => null, save: async () => {} } }), calls }
}

test('copy_paragraph_format paints a numbered, indented source onto a plain target', async () => {
  const { call, calls } = run()
  const res = await call('copy_paragraph_format', { documentId: 'd', source: { find: 'Agenda' }, target: { find: 'Notes' }, revisionId: 'rev1' })
  assert.ok(!res.isError, res.content[0].text)
  const { requests } = calls[0]
  const bullets = requests.find(r => r.createParagraphBullets)
  assert.equal(bullets.createParagraphBullets.bulletPreset, 'NUMBERED_DECIMAL_ALPHA_ROMAN')
  assert.equal(bullets.createParagraphBullets.range.startIndex, 8)
  const styled = requests.find(r => r.updateParagraphStyle).updateParagraphStyle
  assert.equal(styled.paragraphStyle.indentStart.magnitude, 18)
  assert.ok(styled.fields.includes('indentStart'))
})

test('copy_paragraph_format clears the target bullet when the source has none', async () => {
  const { call, calls } = run()
  const res = await call('copy_paragraph_format', { documentId: 'd', source: { find: 'Notes' }, target: { find: 'Agenda' }, revisionId: 'rev1' })
  assert.ok(!res.isError, res.content[0].text)
  const { requests } = calls[0]
  assert.ok(requests.some(r => r.deleteParagraphBullets))
  assert.ok(!requests.some(r => r.createParagraphBullets))
})

test('read_doc reports per-paragraph style, omitting default paragraphs', async () => {
  const { call } = run()
  const res = await call('read_doc', { documentId: 'd' })
  const text = res.content[0].text
  assert.match(text, /--- PARAGRAPHS ---/)
  assert.match(text, /\[1\] indent:18 list:numbered L0 id:kix\.src/)
  assert.doesNotMatch(text, /\[8\] /) // the plain NORMAL_TEXT paragraph has nothing to report
})
