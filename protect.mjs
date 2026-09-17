// The human marks text they do not want automated edits to touch, using formatting that
// already exists in the document (italic by default, or a highlight colour). Nothing has
// to be kept in sync: the marker travels with the doc and survives being edited by hand.
//
// Everything here is pure — it takes a fetched document object and does no I/O — so the
// rules can be tested without credentials.

const MODES = ['italic', 'highlight', 'both', 'off']

// Read at call time, not at import time, so the mode can be flipped in tests.
export function protectMode(env = process.env) {
  const m = String(env.GOOGLE_DOCS_MCP_PROTECT ?? 'italic').trim().toLowerCase()
  return MODES.includes(m) ? m : 'italic'
}

// Docs omits zero components, and "no highlight" arrives either as an absent color or as
// solid white — neither is a deliberate marker.
function highlighted(style) {
  const rgb = style?.backgroundColor?.color?.rgbColor
  if (!rgb) return false
  const { red = 0, green = 0, blue = 0 } = rgb
  return !(red === 1 && green === 1 && blue === 1)
}

function marked(style, mode) {
  if (mode === 'italic') return style?.italic === true
  if (mode === 'highlight') return highlighted(style)
  if (mode === 'both') return style?.italic === true || highlighted(style)
  return false
}

function* textRuns(doc) {
  for (const el of doc?.body?.content ?? []) {
    for (const pe of el.paragraph?.elements ?? []) {
      if (pe.textRun?.content) yield pe
    }
  }
}

// Docs splits a run at every style boundary, so one italic sentence can come back as
// several adjacent runs; merging keeps ranges — and the error messages quoting them —
// whole rather than reporting the same phrase three times.
function merge(ranges) {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out = []
  for (const [s, e] of sorted) {
    const last = out.at(-1)
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

// Merged, sorted [startIndex, endIndex) ranges of text the human marked as off limits.
export function protectedRanges(doc, mode = protectMode()) {
  if (mode === 'off') return []
  const ranges = []
  for (const pe of textRuns(doc)) {
    if (marked(pe.textRun.textStyle, mode)) ranges.push([pe.startIndex, pe.endIndex])
  }
  return merge(ranges)
}

// The first protected range a write would touch, or null. Half-open on both sides, so
// writing up to the start or from the end of a protected range is fine.
export function overlapping(ranges, startIndex, endIndex) {
  return ranges.find(([s, e]) => s < endIndex && e > startIndex) ?? null
}

// Strictly inside only: an insert exactly at a boundary sits before or after the
// protected text without splitting it, which is a legitimate edit.
export function strictlyInside(ranges, index) {
  return ranges.find(([s, e]) => index > s && index < e) ?? null
}

// The document's own text for an index range, for quoting back in refusals.
export function textAt(doc, startIndex, endIndex) {
  let out = ''
  for (const pe of textRuns(doc)) {
    if (pe.endIndex <= startIndex || pe.startIndex >= endIndex) continue
    const t = pe.textRun.content
    out += t.slice(Math.max(0, startIndex - pe.startIndex), Math.min(t.length, endIndex - pe.startIndex))
  }
  return out
}

// Where replaceAllText would strike, as document indices, so the protection check can run
// before handing the call to an API that replaces every occurrence atomically.
export function findOccurrences(doc, find, matchCase = true) {
  if (!find) return []
  let text = ''
  const at = [] // at[i] is the document index of text[i]; runs are not always contiguous
  for (const pe of textRuns(doc)) {
    const t = pe.textRun.content
    for (let i = 0; i < t.length; i++) at.push(pe.startIndex + i)
    text += t
  }
  const hay = matchCase ? text : text.toLowerCase()
  const needle = matchCase ? find : find.toLowerCase()
  const out = []
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
    out.push([at[i], at[i + needle.length - 1] + 1])
  }
  return out
}
