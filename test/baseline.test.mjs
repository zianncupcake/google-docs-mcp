// The drift rules in baseline.mjs are pure, so they can be pinned down with plain strings
// and arrays — no snapshot files, no credentials, no network, nothing to clean up.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  docText, paragraphs, diffParagraphs, describeDrift, hasDrift, baselineEnabled,
} from '../baseline.mjs'

// A diff of two documents given as their raw text, which is how the server uses these.
const drift = (before, after) => diffParagraphs(paragraphs(before), paragraphs(after))

describe('docText', () => {
  test('joins every run in document order', () => {
    const doc = { body: { content: [
      { paragraph: { elements: [
        { startIndex: 1, endIndex: 7, textRun: { content: 'hello ' } },
        { startIndex: 7, endIndex: 13, textRun: { content: 'world\n' } },
      ] } },
      { paragraph: { elements: [{ startIndex: 13, endIndex: 19, textRun: { content: 'again\n' } }] } },
    ] } }
    assert.equal(docText(doc), 'hello world\nagain\n')
  })

  test('survives a document with no body content', () => {
    assert.equal(docText({}), '')
    assert.equal(docText({ body: { content: [] } }), '')
  })
})

describe('paragraphs', () => {
  test('splits on newlines and keeps the original order', () => {
    assert.deepEqual(paragraphs('one\ntwo\nthree\n'), ['one', 'two', 'three'])
  })

  test('drops blank lines so Docs reflow is not reported as an edit', () => {
    assert.deepEqual(paragraphs('one\n\n\ntwo\n   \ntwo\n'), ['one', 'two', 'two'])
  })

  test('trims each paragraph so trailing whitespace is not a change', () => {
    assert.deepEqual(paragraphs('  one  \n\ttwo\t\n'), ['one', 'two'])
  })

  test('returns nothing for empty or missing text', () => {
    assert.deepEqual(paragraphs(''), [])
    assert.deepEqual(paragraphs(undefined), [])
  })
})

describe('diffParagraphs', () => {
  test('reports no change for an identical document', () => {
    const d = drift('a\nb\nc\n', 'a\nb\nc\n')
    assert.deepEqual(d, { added: [], removed: [], unchanged: 3 })
    assert.equal(hasDrift(d), false)
  })

  test('catches a deletion, which revisionId never can', () => {
    const d = drift('a\nb\nc\n', 'a\nc\n')
    assert.deepEqual(d.removed, ['b'])
    assert.deepEqual(d.added, [])
    assert.equal(d.unchanged, 2)
  })

  test('catches an insertion', () => {
    const d = drift('a\nc\n', 'a\nb\nc\n')
    assert.deepEqual(d.added, ['b'])
    assert.deepEqual(d.removed, [])
    assert.equal(d.unchanged, 2)
  })

  test('reports a rewritten paragraph as one removed and one added', () => {
    const d = drift('a\nold line\nc\n', 'a\nnew line\nc\n')
    assert.deepEqual(d.removed, ['old line'])
    assert.deepEqual(d.added, ['new line'])
    assert.equal(d.unchanged, 2)
  })

  test('does not report a reorder of identical paragraphs as a change', () => {
    // LCS alone would call the moved paragraph both removed and added; a move is not a
    // content change and must not block a write.
    const d = drift('a\nb\nc\n', 'c\na\nb\n')
    assert.deepEqual(d, { added: [], removed: [], unchanged: 3 })
    assert.equal(hasDrift(d), false)
  })

  test('still reports the parts that really changed when something else also moved', () => {
    const d = drift('a\nb\nc\n', 'c\na\nd\n')
    assert.deepEqual(d.removed, ['b'])
    assert.deepEqual(d.added, ['d'])
  })

  test('counts duplicate paragraphs rather than cancelling them all', () => {
    // Two copies before, one after: exactly one removal, even though the text still occurs.
    const d = drift('x\nx\ny\n', 'x\ny\n')
    assert.deepEqual(d.removed, ['x'])
    assert.deepEqual(d.added, [])
  })

  test('reports a whole document replaced', () => {
    const d = drift('a\nb\n', 'c\nd\n')
    assert.deepEqual(d.removed, ['a', 'b'])
    assert.deepEqual(d.added, ['c', 'd'])
    assert.equal(d.unchanged, 0)
  })

  test('handles an empty side without special-casing', () => {
    assert.deepEqual(drift('', 'a\nb\n'), { added: ['a', 'b'], removed: [], unchanged: 0 })
    assert.deepEqual(drift('a\nb\n', ''), { added: [], removed: ['a', 'b'], unchanged: 0 })
  })
})

describe('hasDrift', () => {
  test('is false only when nothing was added and nothing removed', () => {
    assert.equal(hasDrift({ added: [], removed: [], unchanged: 9 }), false)
    assert.equal(hasDrift({ added: ['a'], removed: [], unchanged: 0 }), true)
    assert.equal(hasDrift({ added: [], removed: ['a'], unchanged: 0 }), true)
  })
})

describe('describeDrift', () => {
  test('returns empty string when there is nothing to report', () => {
    assert.equal(describeDrift(drift('a\nb\n', 'a\nb\n')), '')
  })

  test('leads with the counts and names what the assistant did last', () => {
    const out = describeDrift(drift('a\nb\nc\nd\n', 'a\nnew\n'))
    assert.equal(out.split('\n')[0], '3 paragraphs removed, 1 added since my last write')
  })

  test('pluralises a single paragraph correctly on either side', () => {
    assert.match(describeDrift(drift('a\nb\n', 'a\n')), /^1 paragraph removed since my last write$/m)
    assert.match(describeDrift(drift('a\n', 'a\nb\n')), /^1 paragraph added since my last write$/m)
  })

  test('quotes the text under a heading for each side', () => {
    const out = describeDrift(drift('a\nkeep me\n', 'a\nbrand new\n'))
    assert.match(out, /removed:\n {2}- "keep me"/)
    assert.match(out, /added:\n {2}- "brand new"/)
  })

  test('collapses whitespace and truncates a long paragraph to 80 chars', () => {
    const long = `${'x'.repeat(200)}`
    const out = describeDrift(drift(`${long}\n`, 'short\n'))
    assert.match(out, new RegExp(`- "${'x'.repeat(80)}…"`))
    assert.equal(out.includes('x'.repeat(81)), false)
  })

  test('lists at most 5 and counts the rest on an "and N more" line', () => {
    const before = Array.from({ length: 8 }, (_, i) => `gone ${i}`).join('\n')
    const out = describeDrift(drift(`${before}\n`, ''))
    assert.match(out, /^8 paragraphs removed since my last write$/m)
    assert.match(out, /- "gone 4"/)
    assert.equal(out.includes('gone 5'), false)
    assert.match(out, /… and 3 more removed/)
  })

  test('omits the "and N more" line when everything fits', () => {
    const out = describeDrift(drift('a\nb\nc\n', ''))
    assert.equal(out.includes('more'), false)
  })
})

describe('baselineEnabled', () => {
  test('defaults to on when the env var is unset, so the guard is opt-out', () => {
    assert.equal(baselineEnabled({}), true)
  })

  test('is off only for the literal value off', () => {
    assert.equal(baselineEnabled({ GOOGLE_DOCS_MCP_BASELINE: 'off' }), false)
    assert.equal(baselineEnabled({ GOOGLE_DOCS_MCP_BASELINE: 'on' }), true)
    assert.equal(baselineEnabled({ GOOGLE_DOCS_MCP_BASELINE: '' }), true)
  })

  test('ignores surrounding whitespace and case', () => {
    assert.equal(baselineEnabled({ GOOGLE_DOCS_MCP_BASELINE: ' OFF ' }), false)
    assert.equal(baselineEnabled({ GOOGLE_DOCS_MCP_BASELINE: 'Off' }), false)
  })

  test('does not treat an unrecognised value as off', () => {
    assert.equal(baselineEnabled({ GOOGLE_DOCS_MCP_BASELINE: 'offf' }), true)
    assert.equal(baselineEnabled({ GOOGLE_DOCS_MCP_BASELINE: 'disabled' }), true)
  })
})
