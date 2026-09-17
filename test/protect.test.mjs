// The rules in protect.mjs are pure, so they can be pinned down with hand-built document
// objects — no credentials, no network, nothing to clean up afterwards.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  protectMode, protectedRanges, overlapping, strictlyInside, textAt, findOccurrences,
} from '../protect.mjs'

// Builds a one-paragraph doc from runs, numbering indices the way Docs does (body starts at 1).
function docOf(...runs) {
  let i = 1
  const elements = runs.map(({ text, ...style }) => {
    const el = { startIndex: i, endIndex: i + text.length, textRun: { content: text, textStyle: style } }
    i += text.length
    return el
  })
  return { body: { content: [{ paragraph: { elements } }] } }
}
const hl = (r, g, b) => ({ backgroundColor: { color: { rgbColor: { red: r, green: g, blue: b } } } })

describe('protectMode', () => {
  test('defaults to italic when the env var is unset', () => {
    assert.equal(protectMode({}), 'italic')
  })

  test('accepts each supported mode', () => {
    assert.equal(protectMode({ GOOGLE_DOCS_MCP_PROTECT: 'highlight' }), 'highlight')
    assert.equal(protectMode({ GOOGLE_DOCS_MCP_PROTECT: 'italic' }), 'italic')
    assert.equal(protectMode({ GOOGLE_DOCS_MCP_PROTECT: 'off' }), 'off')
  })

  test('ignores surrounding whitespace and case', () => {
    assert.equal(protectMode({ GOOGLE_DOCS_MCP_PROTECT: ' BOTH ' }), 'both')
  })

  test('falls back to italic on an unrecognised value rather than dropping protection', () => {
    assert.equal(protectMode({ GOOGLE_DOCS_MCP_PROTECT: 'nonsense' }), 'italic')
  })
})

describe('protectedRanges', () => {
  test('reports nothing for unmarked text', () => {
    assert.deepEqual(protectedRanges(docOf({ text: 'hello world' }), 'italic'), [])
  })

  test('merges runs Docs split at a style boundary', () => {
    // Docs splits at every style boundary, so one italic phrase arrives as several runs.
    const doc = docOf({ text: 'plain ' }, { text: 'ita', italic: true }, { text: 'lic', italic: true, bold: true }, { text: ' tail' })
    assert.deepEqual(protectedRanges(doc, 'italic'), [[7, 13]])
  })

  test('keeps separated runs apart and returns them sorted', () => {
    const doc = docOf({ text: 'a', italic: true }, { text: 'bb' }, { text: 'c', italic: true })
    assert.deepEqual(protectedRanges(doc, 'italic'), [[1, 2], [4, 5]])
  })

  test('collapses overlapping runs to their union', () => {
    // Same paragraph offsets appearing twice (tables/nested content) must not double-report.
    const doc = { body: { content: [
      { paragraph: { elements: [{ startIndex: 10, endIndex: 30, textRun: { content: 'x'.repeat(20), textStyle: { italic: true } } }] } },
      { paragraph: { elements: [{ startIndex: 20, endIndex: 40, textRun: { content: 'y'.repeat(20), textStyle: { italic: true } } }] } },
    ] } }
    assert.deepEqual(protectedRanges(doc, 'italic'), [[10, 40]])
  })

  test('treats a coloured background as a marker but white and unset as none', () => {
    const doc = docOf({ text: 'aa', ...hl(1, 1, 0) }, { text: 'bb', ...hl(1, 1, 1) }, { text: 'cc' })
    assert.deepEqual(protectedRanges(doc, 'highlight'), [[1, 3]])
  })

  test('treats a black highlight as a marker even though Docs omits its zero components', () => {
    // An empty rgbColor is how solid black arrives; only solid white means "no highlight".
    const doc = { body: { content: [{ paragraph: { elements: [
      { startIndex: 1, endIndex: 3, textRun: { content: 'aa', textStyle: { backgroundColor: { color: { rgbColor: {} } } } } },
    ] } }] } }
    assert.deepEqual(protectedRanges(doc, 'highlight'), [[1, 3]])
  })

  test('each mode sees only its own marker, and off sees none', () => {
    const doc = docOf({ text: 'aa', italic: true }, { text: 'bb', ...hl(0, 1, 1) })
    assert.deepEqual(protectedRanges(doc, 'italic'), [[1, 3]])
    assert.deepEqual(protectedRanges(doc, 'highlight'), [[3, 5]])
    assert.deepEqual(protectedRanges(doc, 'both'), [[1, 5]])  // adjacent, so merged
    assert.deepEqual(protectedRanges(doc, 'off'), [])
  })

  test('does not treat an explicit italic: false as a marker', () => {
    assert.deepEqual(protectedRanges(docOf({ text: 'aa', italic: false }), 'italic'), [])
  })

  test('survives a document with no body content', () => {
    assert.deepEqual(protectedRanges({}, 'italic'), [])
    assert.deepEqual(protectedRanges({ body: { content: [] } }, 'both'), [])
  })

  test('reads the env var through its default argument, at call time', () => {
    const doc = docOf({ text: 'aa', italic: true })
    const saved = process.env.GOOGLE_DOCS_MCP_PROTECT
    try {
      process.env.GOOGLE_DOCS_MCP_PROTECT = 'off'
      assert.deepEqual(protectedRanges(doc), [])
      process.env.GOOGLE_DOCS_MCP_PROTECT = 'italic'
      assert.deepEqual(protectedRanges(doc), [[1, 3]])
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_DOCS_MCP_PROTECT
      else process.env.GOOGLE_DOCS_MCP_PROTECT = saved
    }
  })
})

const ranges = [[10, 20], [30, 40]]

describe('overlapping', () => {
  test('does not count a write that merely touches a boundary', () => {
    assert.equal(overlapping(ranges, 0, 10), null)    // ends exactly where protection starts
    assert.equal(overlapping(ranges, 20, 30), null)   // sits between two protected ranges
  })

  test('catches a write that shares even one character', () => {
    assert.deepEqual(overlapping(ranges, 0, 11), [10, 20])
    assert.deepEqual(overlapping(ranges, 19, 25), [10, 20])
    assert.deepEqual(overlapping(ranges, 35, 36), [30, 40])
  })

  test('reports the first range hit when a write spans several', () => {
    assert.deepEqual(overlapping(ranges, 5, 100), [10, 20])
  })

  test('finds nothing when the document has no protected text', () => {
    assert.equal(overlapping([], 0, 999), null)
  })
})

describe('strictlyInside', () => {
  test('allows an insert at either boundary, or outside entirely', () => {
    assert.equal(strictlyInside(ranges, 10), null)
    assert.equal(strictlyInside(ranges, 20), null)
    assert.equal(strictlyInside(ranges, 25), null)
  })

  test('refuses an insert that would split protected text', () => {
    assert.deepEqual(strictlyInside(ranges, 11), [10, 20])
    assert.deepEqual(strictlyInside(ranges, 19), [10, 20])
  })
})

describe('textAt', () => {
  test('slices across run boundaries', () => {
    const doc = docOf({ text: 'hello ' }, { text: 'brave', italic: true }, { text: ' world' })
    assert.equal(textAt(doc, 7, 12), 'brave')
    assert.equal(textAt(doc, 1, 18), 'hello brave world')
    assert.equal(textAt(doc, 4, 9), 'lo br')
  })

  test('returns empty for a range past the end of the document', () => {
    const doc = docOf({ text: 'hello ' }, { text: 'brave', italic: true }, { text: ' world' })
    assert.equal(textAt(doc, 50, 60), '')
  })
})

describe('findOccurrences', () => {
  test('returns document indices, not offsets into the flattened text', () => {
    const doc = docOf({ text: 'cat dog ' }, { text: 'cat', italic: true }, { text: ' CAT' })
    assert.deepEqual(findOccurrences(doc, 'cat'), [[1, 4], [9, 12]])
  })

  test('matches case by default and ignores it on request', () => {
    const doc = docOf({ text: 'cat dog ' }, { text: 'cat', italic: true }, { text: ' CAT' })
    assert.deepEqual(findOccurrences(doc, 'cat', false), [[1, 4], [9, 12], [13, 16]])
  })

  test('scans past each hit rather than re-matching inside it', () => {
    // Docs replaces non-overlapping occurrences, so 'aa' in 'aaaa' is two hits, not three.
    assert.deepEqual(findOccurrences(docOf({ text: 'aaaa' }), 'aa'), [[1, 3], [3, 5]])
  })

  test('returns nothing for an absent or empty needle', () => {
    const doc = docOf({ text: 'cat dog ' }, { text: 'cat', italic: true }, { text: ' CAT' })
    assert.deepEqual(findOccurrences(doc, 'missing'), [])
    assert.deepEqual(findOccurrences(doc, ''), [])
  })
})

describe('replace_all_text gate', () => {
  test('separates the occurrences that are safe from the ones that are protected', () => {
    const doc = docOf({ text: 'cat dog ' }, { text: 'cat', italic: true }, { text: ' cat' })
    const prot = protectedRanges(doc, 'italic')
    const hits = findOccurrences(doc, 'cat')
    const blocked = hits.filter(([s, e]) => overlapping(prot, s, e))
    assert.equal(hits.length, 3)
    assert.equal(blocked.length, 1)
    assert.deepEqual(blocked[0], [9, 12])
  })
})
