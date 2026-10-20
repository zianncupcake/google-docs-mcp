import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textStyleAt } from '../walk.mjs'

// One paragraph, three runs: plain, bold, plain.
const content = [{ paragraph: { elements: [
  { startIndex: 1, endIndex: 6, textRun: { content: 'plain', textStyle: {} } },
  { startIndex: 6, endIndex: 10, textRun: { content: 'bold', textStyle: { bold: true } } },
  { startIndex: 10, endIndex: 15, textRun: { content: ' tail', textStyle: {} } },
] } }]

test('carries the style of the run holding the index', () => {
  assert.deepEqual(textStyleAt(content, 7), { bold: true })
})

// The boundary is the bug worth a row of its own: an index at a run's start belongs to that
// run, not the one before it, so replacing a bold span from its first character stays bold.
test('an index at a run boundary belongs to the run it starts', () => {
  assert.deepEqual(textStyleAt(content, 6), { bold: true })
  assert.equal(textStyleAt(content, 99), undefined)
})
