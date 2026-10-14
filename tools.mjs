// Every tool, whichever server runs it. The caller supplies what differs between the stdio
// server and the Worker:
//   google    getDoc(id), batchUpdate(id, requestBody), createDoc({ title, html, folderId }) -> { id, name },
//             replaceDocHtml(id, html); a failure throws an Error carrying Google's message
//   baseline  load(key) -> { revisionId, text } or null, save(key, { revisionId, text })
import { protectMode, protectedRanges, overlapping, strictlyInside, textAt, findOccurrences } from './protect.mjs'
import {
  docRuns, docText, paragraphs, diffParagraphs, describeDrift, hasDrift,
  baselineEnabled,
} from './baseline.mjs'
import { paragraphElements } from './walk.mjs'

// Accepts a bare id or any /document/d/<id>/ URL.
function docId(input) {
  const m = String(input).match(/\/d\/([a-zA-Z0-9_-]{20,})/)
  return m ? m[1] : String(input).trim()
}

// An explicit tabId wins; otherwise a Docs URL names its tab as ?tab=t.<id>.
function tabOf({ documentId, tabId }) {
  if (tabId) return tabId
  return String(documentId).match(/[?&#]tab=(t\.[a-zA-Z0-9_-]+)/)?.[1]
}

const tabLabel = (tab) => `${tab.tabProperties.tabId} ${JSON.stringify(tab.tabProperties.title)}`

// The first tab keeps the bare document id, so snapshots written before tabs were supported still match.
const baselineKey = (id, doc) => doc.tabId === doc.tabs[0].tabProperties.tabId ? id : `${id}.${doc.tabId}`

const plainText = (content) => [...paragraphElements(content)].map(pe => pe.textRun?.content ?? '').join('')
const bodyTables = (doc) => (doc.body?.content ?? []).filter(el => el.table)

function styleTags(style = {}) {
  const tags = ['bold', 'italic', 'underline', 'strikethrough'].filter(key => style[key])
  if (style.fontSize?.magnitude) tags.push(`${style.fontSize.magnitude}pt`)
  if (style.link?.url) tags.push(`link:${style.link.url}`)
  return tags.length ? ` {${tags.join(',')}}` : ''
}

const pt = (magnitude) => ({ magnitude, unit: 'PT' })
const rounded = (value) => Math.round((value ?? 0) * 100) / 100
const at = (index, tabId, segmentId) => ({ index, ...(tabId && { tabId }), ...(segmentId && { segmentId }) })
const span = (range, tabId, segmentId) => ({ ...range, ...(tabId && { tabId }), ...(segmentId && { segmentId }) })
const place = (index, tabId) => index == null
  ? { endOfSegmentLocation: { ...(tabId && { tabId }) } }
  : { location: at(index, tabId) }

function hexColor(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim())
  if (!match) throw new Error(`Colour must be a 6-digit hex like #1a73e8, got ${JSON.stringify(hex)}.`)
  const value = parseInt(match[1], 16)
  return { color: { rgbColor: { red: (value >> 16) / 255, green: ((value >> 8) & 255) / 255, blue: (value & 255) / 255 } } }
}

// An empty string clears a colour or link: the field stays in the mask with no value.
function textStyleFrom({ bold, italic, underline, strikethrough, fontSize, fontFamily, foregroundColor, backgroundColor, link }) {
  const textStyle = {}
  const fields = []
  for (const [key, value] of Object.entries({ bold, italic, underline, strikethrough })) {
    if (value != null) { textStyle[key] = value; fields.push(key) }
  }
  if (fontSize != null) { textStyle.fontSize = pt(fontSize); fields.push('fontSize') }
  if (fontFamily != null) { textStyle.weightedFontFamily = { fontFamily }; fields.push('weightedFontFamily') }
  for (const [key, value] of Object.entries({ foregroundColor, backgroundColor })) {
    if (value == null) continue
    if (value !== '') textStyle[key] = hexColor(value)
    fields.push(key)
  }
  if (link != null) {
    if (link !== '') textStyle.link = { url: link }
    fields.push('link')
  }
  if (!fields.length) throw new Error('No style given. Pass at least one of bold, italic, underline, strikethrough, fontSize, fontFamily, foregroundColor, backgroundColor, link.')
  return { textStyle, fields: fields.join(',') }
}

const NAMED_STYLES = ['NORMAL_TEXT', 'TITLE', 'SUBTITLE', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6']
const ALIGNMENTS = ['START', 'CENTER', 'END', 'JUSTIFIED']
const BULLET_PRESETS = { disc: 'BULLET_DISC_CIRCLE_SQUARE', numbered: 'NUMBERED_DECIMAL_ALPHA_ROMAN' }
const PAGE_SIZES = { A4: [595.276, 841.89], LETTER: [612, 792], LEGAL: [612, 1008] }
const MARGINS = ['marginTop', 'marginBottom', 'marginLeft', 'marginRight']
const TABLE_ACTIONS = ['insert_row', 'insert_column', 'delete_row', 'delete_column', 'merge_cells', 'unmerge_cells', 'set_column_width', 'delete_table']
const BREAKS = { page: null, section_next_page: 'NEXT_PAGE', section_continuous: 'CONTINUOUS' }

function paragraphStyleFrom({ alignment, namedStyleType, lineSpacing, spaceAbove, spaceBelow, indentStart, indentFirstLine }) {
  const paragraphStyle = {}
  const fields = []
  if (alignment != null) {
    if (!ALIGNMENTS.includes(alignment)) throw new Error(`alignment must be one of ${ALIGNMENTS.join(', ')}.`)
    paragraphStyle.alignment = alignment; fields.push('alignment')
  }
  if (namedStyleType != null) {
    if (!NAMED_STYLES.includes(namedStyleType)) throw new Error(`namedStyleType must be one of ${NAMED_STYLES.join(', ')}.`)
    paragraphStyle.namedStyleType = namedStyleType; fields.push('namedStyleType')
  }
  if (lineSpacing != null) { paragraphStyle.lineSpacing = lineSpacing; fields.push('lineSpacing') }
  for (const [key, value] of Object.entries({ spaceAbove, spaceBelow, indentStart, indentFirstLine })) {
    if (value != null) { paragraphStyle[key] = pt(value); fields.push(key) }
  }
  return { paragraphStyle, fields: fields.join(',') }
}

const REV = 'From read_doc. Required: the edit is refused if the document changed since.'
const ALLOW = 'Skip the protected-text check. Only pass true when the user has explicitly asked to overwrite their own marked text. The revisionId check still applies.'

const DOC = { type: 'string', description: 'Doc id or full Docs URL' }
const TAB = { type: 'string', description: 'Tab id from read_doc (e.g. t.0). Defaults to the tab in the URL, else the first tab.' }
const REVISION = { type: 'string', description: REV }
const ALLOWED = { type: 'boolean', description: ALLOW }
const INDEX = { type: 'number', description: 'Character index from read_doc. Omit to place it at the end of the document.' }
const ADDRESS = {
  find: { type: 'string', description: 'Exact text. If it matches more than once, `occurrence` is required.' },
  occurrence: { description: '1-based match number, or "all". Only with `find`.' },
  matchCase: { type: 'boolean', description: 'Default true. Only with `find`.' },
  startIndex: { type: 'number' }, endIndex: { type: 'number', description: 'Exclusive.' },
}
const TABLE = { type: 'number', description: '1-based table number from read_doc' }
const CELL = { row: { type: 'number', description: '1-based' }, column: { type: 'number', description: '1-based' } }
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }

export const TOOLS = [
  { name: 'read_doc',
    description: 'Read a Google Doc: text, the character index and styles of each run, page setup, tabs, tables, images, named ranges, header, footer and footnotes. The edit tools need these indices. Also lists the ranges the user marked as protected — the edit tools refuse to touch those.',
    inputSchema: { type: 'object', required: ['documentId'],
      properties: { documentId: DOC, tabId: TAB,
                    withIndices: { type: 'boolean', description: 'Also return the per-run index map, tables, images and named ranges (default true)' },
                    withProtected: { type: 'boolean', description: 'Also return the protected ranges (default true)' },
                    withBaseline: { type: 'boolean', description: 'Also report whether the document has changed since this server last wrote it (default true)' } } } },
  { name: 'replace_all_text',
    description: 'Replace every occurrence of a string throughout the document. The safest edit — no index arithmetic. Refused if any occurrence sits in protected text, because the API replaces all of them at once. With a tabId it only touches that tab.',
    inputSchema: { type: 'object', required: ['documentId', 'find', 'replace', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB, find: { type: 'string' }, replace: { type: 'string' },
                    matchCase: { type: 'boolean', description: 'Default true' },
                    revisionId: REVISION, allowProtected: ALLOWED } } },
  { name: 'insert_text',
    description: 'Insert text at a character index. Get indices from read_doc first — they shift after every edit. Refused if the index falls inside protected text; inserting at either edge of it is fine.',
    inputSchema: { type: 'object', required: ['documentId', 'index', 'text', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB, index: { type: 'number' }, text: { type: 'string' },
                    revisionId: REVISION, allowProtected: ALLOWED } } },
  { name: 'append_text',
    description: 'Append text to the end of the document body. Always allowed — it adds, never overwrites — and the appended text is stripped of the protection marker so it does not inherit one from the text above it.',
    inputSchema: { type: 'object', required: ['documentId', 'text'],
      properties: { documentId: DOC, tabId: TAB, text: { type: 'string' },
                    allowProtected: { type: 'boolean', description: 'Keep whatever styling the appended text inherits, marker included. Only pass true when the user has explicitly asked for that.' } } } },
  { name: 'delete_range',
    description: 'Delete the content between two character indices. Refused if the range overlaps protected text.',
    inputSchema: { type: 'object', required: ['documentId', 'startIndex', 'endIndex', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB, startIndex: { type: 'number' }, endIndex: { type: 'number' },
                    revisionId: REVISION, allowProtected: ALLOWED } },
    annotations: DESTRUCTIVE },
  { name: 'replace_range',
    description: 'Replace the text between two character indices with new text, in one atomic call. Use this instead of delete_range + insert_text, whose indices shift in between. Refused if the range overlaps protected text.',
    inputSchema: { type: 'object', required: ['documentId', 'startIndex', 'endIndex', 'text', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB, startIndex: { type: 'number' }, endIndex: { type: 'number' },
                    text: { type: 'string' }, revisionId: REVISION, allowProtected: ALLOWED } },
    annotations: DESTRUCTIVE },
  { name: 'format_text',
    description: 'Style text: bold, italic, underline, strikethrough, font size, font family, colours, link. Address it with `find` (exact text) or with startIndex/endIndex from read_doc. Pass false to switch a style off. Refused if the range overlaps protected text.',
    inputSchema: { type: 'object', required: ['documentId', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB, ...ADDRESS,
                    bold: { type: 'boolean' }, italic: { type: 'boolean' }, underline: { type: 'boolean' }, strikethrough: { type: 'boolean' },
                    fontSize: { type: 'number', description: 'Points' }, fontFamily: { type: 'string' },
                    foregroundColor: { type: 'string', description: 'Hex like #1a73e8; "" clears it' },
                    backgroundColor: { type: 'string', description: 'Highlight, hex; "" clears it' },
                    link: { type: 'string', description: 'URL; "" removes the link' },
                    revisionId: REVISION, allowProtected: ALLOWED } } },
  { name: 'format_paragraph',
    description: 'Style whole paragraphs touching the addressed text: alignment, named style (heading levels), line spacing, spacing, indents, bullets. Setting namedStyleType wipes run-level font, size, bold and italic — set it before format_text, never after — so it is refused on a paragraph holding protected text.',
    inputSchema: { type: 'object', required: ['documentId', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB, ...ADDRESS,
                    alignment: { type: 'string', enum: ALIGNMENTS },
                    namedStyleType: { type: 'string', enum: NAMED_STYLES },
                    lineSpacing: { type: 'number', description: 'Percent: 100 is single, 115 is the Docs default' },
                    spaceAbove: { type: 'number', description: 'Points' }, spaceBelow: { type: 'number', description: 'Points' },
                    indentStart: { type: 'number', description: 'Points' }, indentFirstLine: { type: 'number', description: 'Points' },
                    bullets: { type: 'string', enum: ['disc', 'numbered', 'none'] },
                    revisionId: REVISION, allowProtected: ALLOWED } } },
  { name: 'set_page_setup',
    description: 'Set page margins, page size and orientation. All lengths are points (72 per inch). read_doc shows the current values.',
    inputSchema: { type: 'object', required: ['documentId', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB,
                    marginTop: { type: 'number' }, marginBottom: { type: 'number' }, marginLeft: { type: 'number' }, marginRight: { type: 'number' },
                    pageSize: { type: 'string', enum: Object.keys(PAGE_SIZES) },
                    pageWidth: { type: 'number', description: 'Custom width; needs pageHeight' }, pageHeight: { type: 'number' },
                    orientation: { type: 'string', enum: ['portrait', 'landscape'] }, revisionId: REVISION } } },
  { name: 'insert_table',
    description: 'Insert a table, optionally filled from `cells` (an array of rows, each an array of strings). Refused if the index falls inside protected text.',
    inputSchema: { type: 'object', required: ['documentId', 'rows', 'columns', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB, rows: { type: 'number' }, columns: { type: 'number' }, index: INDEX,
                    cells: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
                    revisionId: REVISION, allowProtected: ALLOWED } } },
  { name: 'edit_table',
    description: 'Change a table\'s structure: insert or delete a row or column next to a cell, merge or unmerge a block of cells, set a column width, or delete the table. Merging moves the merged cells\' text into the first cell, and unmerging leaves it there. A delete is refused if it would remove protected text.',
    inputSchema: { type: 'object', required: ['documentId', 'table', 'action', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB, table: TABLE, action: { type: 'string', enum: TABLE_ACTIONS }, ...CELL,
                    position: { type: 'string', enum: ['after', 'before'], description: 'For inserts. Default after (below / to the right).' },
                    rowSpan: { type: 'number', description: 'For merge/unmerge. Default 1.' }, columnSpan: { type: 'number', description: 'For merge/unmerge. Default 1.' },
                    width: { type: 'number', description: 'Points, for set_column_width' },
                    revisionId: REVISION, allowProtected: ALLOWED } },
    annotations: DESTRUCTIVE },
  { name: 'set_table_cell_text',
    description: 'Replace the text of one table cell. Refused if the cell holds protected text.',
    inputSchema: { type: 'object', required: ['documentId', 'table', 'row', 'column', 'text', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB, table: TABLE, ...CELL, text: { type: 'string' },
                    revisionId: REVISION, allowProtected: ALLOWED } },
    annotations: DESTRUCTIVE },
  { name: 'style_table_cells',
    description: 'Style a block of table cells, or the whole table when row and column are omitted: fill colour, borders (borderWidth 0 hides them), padding, vertical alignment.',
    inputSchema: { type: 'object', required: ['documentId', 'table', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB, table: TABLE, ...CELL,
                    rowSpan: { type: 'number', description: 'Default 1' }, columnSpan: { type: 'number', description: 'Default 1' },
                    backgroundColor: { type: 'string', description: 'Hex; "" clears it' },
                    borderWidth: { type: 'number', description: 'Points, all four sides' }, borderColor: { type: 'string', description: 'Hex' },
                    padding: { type: 'number', description: 'Points, all four sides' },
                    verticalAlignment: { type: 'string', enum: ['TOP', 'MIDDLE', 'BOTTOM'] }, revisionId: REVISION } } },
  { name: 'insert_image',
    description: 'Insert an inline image from a publicly reachable URL (PNG, JPEG or GIF, under 50 MB). Docs keeps the image\'s proportions, scaling it to fit inside width x height. Refused if the index falls inside protected text.',
    inputSchema: { type: 'object', required: ['documentId', 'uri', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB, uri: { type: 'string' }, index: INDEX,
                    width: { type: 'number', description: 'Points' }, height: { type: 'number', description: 'Points' },
                    revisionId: REVISION, allowProtected: ALLOWED } } },
  { name: 'replace_image',
    description: 'Swap an existing image for one at a new URL, keeping its position and size.',
    inputSchema: { type: 'object', required: ['documentId', 'imageId', 'uri', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB, imageId: { type: 'string', description: 'Image id from read_doc' }, uri: { type: 'string' }, revisionId: REVISION } } },
  { name: 'insert_break',
    description: 'Insert a page break, or a section break that starts a new page or continues on the same one. Refused if the index falls inside protected text.',
    inputSchema: { type: 'object', required: ['documentId', 'type', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB, type: { type: 'string', enum: Object.keys(BREAKS) }, index: INDEX,
                    revisionId: REVISION, allowProtected: ALLOWED } } },
  { name: 'set_section_columns',
    description: 'Lay the section(s) touching the addressed text out in newspaper-style columns. Use insert_break with a section break first to limit which part of the document is affected.',
    inputSchema: { type: 'object', required: ['documentId', 'columns', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB, ...ADDRESS, columns: { type: 'number', description: '1 to 3' },
                    gap: { type: 'number', description: 'Points between columns. Default 36.' }, revisionId: REVISION } } },
  { name: 'set_header_footer',
    description: 'Set the text of the page header or footer, creating it if needed, or remove it. Header and footer text sits outside the body, so protection markers and the baseline do not cover it.',
    inputSchema: { type: 'object', required: ['documentId', 'kind', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB, kind: { type: 'string', enum: ['header', 'footer'] },
                    text: { type: 'string' }, remove: { type: 'boolean' }, revisionId: REVISION } },
    annotations: DESTRUCTIVE },
  { name: 'insert_footnote',
    description: 'Add a footnote. The reference mark goes at `index`, or right after the text matched by `find`. Refused if that point falls inside protected text.',
    inputSchema: { type: 'object', required: ['documentId', 'text', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB, text: { type: 'string' }, index: INDEX,
                    find: ADDRESS.find, occurrence: ADDRESS.occurrence, matchCase: ADDRESS.matchCase,
                    revisionId: REVISION, allowProtected: ALLOWED } } },
  { name: 'create_named_range',
    description: 'Bookmark a span of text under a name, so replace_named_range can rewrite it later without indices.',
    inputSchema: { type: 'object', required: ['documentId', 'name', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB, name: { type: 'string' }, ...ADDRESS, revisionId: REVISION } } },
  { name: 'replace_named_range',
    description: 'Replace the text held by every named range with this name. Refused if any of them overlaps protected text.',
    inputSchema: { type: 'object', required: ['documentId', 'name', 'text', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB, name: { type: 'string' }, text: { type: 'string' },
                    revisionId: REVISION, allowProtected: ALLOWED } },
    annotations: DESTRUCTIVE },
  { name: 'delete_named_range',
    description: 'Remove a named range. The text it covered stays.',
    inputSchema: { type: 'object', required: ['documentId', 'name', 'revisionId'],
      properties: { documentId: DOC, tabId: TAB, name: { type: 'string' }, revisionId: REVISION } } },
  { name: 'replace_body',
    description: 'DESTRUCTIVE: replaces the ENTIRE document body, discarding any edits made in the doc. Prefer replace_all_text or the index-based tools. Requires a revisionId from read_doc and refuses if the document changed since, or if the document contains any protected text at all. Only works on docs this app created (drive.file scope).',
    inputSchema: { type: 'object', required: ['documentId', 'html', 'revisionId'],
      properties: { documentId: { type: 'string' }, html: { type: 'string', description: 'Full HTML document body' },
                    revisionId: REVISION, allowProtected: ALLOWED } },
    annotations: DESTRUCTIVE },
  { name: 'create_doc',
    description: 'Create a new Google Doc, optionally from HTML. Returns its id and URL.',
    inputSchema: { type: 'object', required: ['title'],
      properties: { title: { type: 'string' }, html: { type: 'string' }, folderId: { type: 'string' } } } },
  { name: 'sync_baseline',
    description: 'Adopt the document\'s current text as the baseline this server compares future writes against, and report what changed since the last baseline. Writes NOTHING to the document. This is the ONLY way to clear a drift refusal — no edit tool has a flag to bypass one, deliberately: drift means the user changed the doc after this server last wrote it, so it must be read and understood, not overridden. Call read_doc first, then this.',
    inputSchema: { type: 'object', required: ['documentId'],
      properties: { documentId: DOC, tabId: TAB } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
]

const REMEDY = 'The document changed since I last wrote it, so that change was almost certainly yours. '
  + 'Re-sending the same edit would overwrite it. Call read_doc to see the current text and work out what to keep, '
  + 'then sync_baseline to adopt it — do NOT re-send this edit. There is no flag to skip this check.'

function quote(doc, [s, e]) {
  return JSON.stringify(textAt(doc, s, e).replace(/\s+/g, ' ').slice(0, 60))
}

// One shape for every protection refusal: what was attempted, what it would have hit,
// and the two ways out.
function refuse(tool, what, doc, range, mode, extra = '') {
  return new Error(`${tool} refused: ${what} text the user marked as protected (${mode}) at ${range[0]}-${range[1]}: ${quote(doc, range)}.${extra} Re-read the doc and edit around it, or pass allowProtected: true only if the user explicitly asked to replace their own text.`)
}

function guardRange(tool, { doc, mode, ranges }, startIndex, endIndex, what = `the range ${startIndex}-${endIndex} overlaps`) {
  const hit = overlapping(ranges, startIndex, endIndex)
  if (hit) throw refuse(tool, what, doc, hit, mode)
}

function guardInsert(tool, { doc, mode, ranges }, index) {
  if (index == null) return
  const hit = strictlyInside(ranges, index)
  if (hit) throw refuse(tool, `the index ${index} falls inside`, doc, hit, mode,
    ` Inserting at ${hit[0]} or ${hit[1]} instead would leave it intact.`)
}

function resolveRanges(doc, { find, occurrence, matchCase = true, startIndex, endIndex }) {
  if (find == null) {
    if (!(Number.isInteger(startIndex) && Number.isInteger(endIndex) && startIndex < endIndex)) {
      throw new Error('Give either `find`, or integer startIndex and endIndex with startIndex < endIndex.')
    }
    return [{ startIndex, endIndex }]
  }
  if (startIndex != null || endIndex != null) throw new Error('Give `find` or a character range, not both.')
  if (find === '') throw new Error('`find` is empty.')
  // A match whose ends are further apart than its length straddles an image or a cell boundary; skip it.
  const matches = findOccurrences(doc, find, matchCase).filter(([start, end]) => end - start === find.length)
  if (!matches.length) throw new Error(`${JSON.stringify(find)} was not found. Check exact casing and whitespace.`)
  let chosen = matches
  if (occurrence !== 'all') {
    if (occurrence == null && matches.length > 1) {
      throw new Error(`${JSON.stringify(find)} matches ${matches.length} places. Pass occurrence: 1-${matches.length} or "all".\n` +
        matches.map(([start, end], position) => `${position + 1}. [${start}-${end}] …${quote(doc, [Math.max(1, start - 30), end + 30])}…`).join('\n'))
    }
    const wanted = occurrence ?? 1
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > matches.length) {
      throw new Error(`occurrence must be "all" or a whole number from 1 to ${matches.length}.`)
    }
    chosen = [matches[wanted - 1]]
  }
  return chosen.map(([start, end]) => ({ startIndex: start, endIndex: end }))
}

const describeRanges = (ranges) => ranges.map(range => `${range.startIndex}-${range.endIndex}`).join(', ')

// The full extent of every paragraph a range touches, which is what a paragraph-level style rewrites.
function paragraphBounds(doc, { startIndex, endIndex }) {
  let from = startIndex
  let to = endIndex
  const visit = (content) => {
    for (const el of content ?? []) {
      if (el.paragraph && el.startIndex < endIndex && el.endIndex > startIndex) {
        from = Math.min(from, el.startIndex ?? 0)
        to = Math.max(to, el.endIndex)
      }
      for (const row of el.table?.tableRows ?? []) for (const cell of row.tableCells ?? []) visit(cell.content)
    }
  }
  visit(doc.body?.content)
  return [from, to]
}

function tableAt(doc, number) {
  const tables = bodyTables(doc)
  if (!Number.isInteger(number) || number < 1 || number > tables.length) {
    throw new Error(`No table ${number}. This document has ${tables.length} table(s), numbered from 1 in reading order.`)
  }
  return tables[number - 1]
}

function cellAt(tableElement, row, column) {
  const cell = tableElement.table.tableRows[row - 1]?.tableCells[column - 1]
  if (!cell) throw new Error(`No cell at row ${row}, column ${column}. The table is ${tableElement.table.rows} rows by ${tableElement.table.columns} columns, numbered from 1.`)
  return cell
}

function describeExtras(doc) {
  let out = ''
  const tables = bodyTables(doc)
  if (tables.length) {
    out += '\n\n--- TABLES ---\n' + tables.map((el, number) =>
      `table ${number + 1} [${el.startIndex}-${el.endIndex}] ${el.table.rows} rows x ${el.table.columns} columns\n` +
      el.table.tableRows.map((row, rowNumber) => row.tableCells.map((cell, columnNumber) =>
        `  r${rowNumber + 1}c${columnNumber + 1} [${cell.startIndex}-${cell.endIndex}] ${JSON.stringify(plainText(cell.content).slice(0, 80))}`).join('\n')).join('\n')).join('\n')
  }
  const images = [...paragraphElements(doc.body?.content)].filter(pe => pe.inlineObjectElement)
  if (images.length) {
    out += '\n\n--- IMAGES ---\n' + images.map(pe => {
      const imageId = pe.inlineObjectElement.inlineObjectId
      const size = doc.inlineObjects?.[imageId]?.inlineObjectProperties?.embeddedObject?.size
      return `${imageId} at index ${pe.startIndex}` + (size ? ` (${Math.round(size.width?.magnitude)}x${Math.round(size.height?.magnitude)}pt)` : '')
    }).join('\n')
  }
  const named = Object.values(doc.namedRanges ?? {}).flatMap(group => group.namedRanges ?? [])
  if (named.length) {
    out += '\n\n--- NAMED RANGES ---\n' + named.map(entry =>
      `${JSON.stringify(entry.name)} ${(entry.ranges ?? []).map(range => `[${range.startIndex ?? 0}-${range.endIndex}]`).join(' ')}`).join('\n')
  }
  return out
}

function describeSegments(doc) {
  const style = doc.documentStyle ?? {}
  const lines = []
  if (style.defaultHeaderId) lines.push(`header: ${JSON.stringify(plainText(doc.headers?.[style.defaultHeaderId]?.content))}`)
  if (style.defaultFooterId) lines.push(`footer: ${JSON.stringify(plainText(doc.footers?.[style.defaultFooterId]?.content))}`)
  for (const [footnoteId, footnote] of Object.entries(doc.footnotes ?? {})) {
    lines.push(`footnote ${footnoteId}: ${JSON.stringify(plainText(footnote.content))}`)
  }
  return lines.length ? '\n\n--- HEADER, FOOTER, FOOTNOTES ---\n' + lines.join('\n') : ''
}

export function createCallTool({ google, baseline }) {
  // One tab's content lifted to the top level, so the protect and baseline helpers read it like a whole document.
  async function loadDoc(id, tabId) {
    const data = await google.getDoc(id)
    const tabs = []
    const collect = (list) => { for (const tab of list ?? []) { tabs.push(tab); collect(tab.childTabs) } }
    collect(data.tabs)
    const tab = tabId ? tabs.find(entry => entry.tabProperties.tabId === tabId) : tabs[0]
    if (!tab) throw new Error(`No tab ${tabId} in this document. Tabs: ${tabs.map(tabLabel).join(', ')}.`)
    return { title: data.title, revisionId: data.revisionId, tabs, tabId: tab.tabProperties.tabId, ...tab.documentTab }
  }

  // requiredRevisionId makes a stale edit FAIL instead of silently overwriting whatever
  // the document became since the caller last read it.
  async function batch(documentId, requests, revisionId) {
    const requestBody = { requests, ...(revisionId ? { writeControl: { requiredRevisionId: revisionId } } : {}) }
    try {
      return await google.batchUpdate(documentId, requestBody)
    } catch (e) {
      const msg = e?.response?.data?.error?.message || e.message
      if (/revision/i.test(msg)) {
        throw new Error(`The document changed since you read it, so this edit was refused rather than overwriting someone else's work. Call read_doc again and redo the edit against the current text. (${msg})`)
      }
      throw e
    }
  }

  // The drift gate. revisionId proves nothing here: after the user edits, THEIR version is
  // the current revision, so a fresh read hands back a revisionId that validates perfectly
  // while the text underneath it is no longer what this server wrote.
  async function checkDrift(tool, id, doc) {
    if (!baselineEnabled()) return
    const snap = await baseline.load(baselineKey(id, doc))
    // No snapshot is the bootstrap case: nothing to compare against yet, and the write that
    // follows records one.
    if (!snap) return
    const diff = diffParagraphs(paragraphs(snap.text), paragraphs(docText(doc)))
    if (hasDrift(diff)) throw new Error(`${tool} refused: ${describeDrift(diff)}\n\n${REMEDY}`)
  }

  // Read before write, once: the same fetch that proves the caller holds the current
  // revision also supplies the protected ranges and the text the baseline diffs, so neither
  // check can be made against a copy of the document that has since moved on.
  async function preflight(tool, args) {
    const { documentId, revisionId, allowProtected = false } = args
    const id = docId(documentId)
    const tabId = tabOf(args)
    if (!revisionId) {
      throw new Error(`${tool} needs a revisionId so a stale edit cannot silently overwrite newer text. Call read_doc first and pass the revisionId it returns.`)
    }
    const doc = await loadDoc(id, tabId)
    if (doc.revisionId !== revisionId) {
      throw new Error(`${tool} refused: the document changed since you read it (you passed ${revisionId}, it is now ${doc.revisionId}). Call read_doc again and redo the edit against the current text.`)
    }
    await checkDrift(tool, id, doc)
    const mode = protectMode()
    // allowProtected drops the protection check only — the revision and drift checks above
    // both still ran, and nothing can switch those off.
    return { id, tabId, doc, mode, ranges: allowProtected ? [] : protectedRanges(doc, mode) }
  }

  // Every mutating handler returns through here, so none can forget to move the baseline
  // forward — a write this server made itself must not look like the user's edit next time.
  async function recordBaseline(id, result, tabId) {
    if (!baselineEnabled()) return result
    try {
      const doc = await loadDoc(id, tabId)
      await baseline.save(baselineKey(id, doc), { revisionId: doc.revisionId, text: docText(doc) })
      return result
    } catch (e) {
      // The edit already landed. Failing the call now would invite a retry that applies it
      // twice, so the snapshot failure is reported alongside the success instead.
      return `${result}\n\nWarning: the baseline snapshot was not updated (${e.message}). The next edit may be refused for drift; call sync_baseline to recover.`
    }
  }

  async function baselineStatus(id, doc) {
    if (!baselineEnabled()) return 'disabled (GOOGLE_DOCS_MCP_BASELINE=off)'
    const snap = await baseline.load(baselineKey(id, doc))
    if (!snap) return 'no baseline recorded'
    const diff = diffParagraphs(paragraphs(snap.text), paragraphs(docText(doc)))
    return hasDrift(diff) ? describeDrift(diff) : 'in sync'
  }

  const handlers = {
    async read_doc(args) {
      const { withIndices = true, withProtected = true, withBaseline = true } = args
      const id = docId(args.documentId)
      const doc = await loadDoc(id, tabOf(args))
      const runs = docRuns(doc)
      const text = runs.map(r => r.text).join('')
      const style = doc.documentStyle ?? {}
      let out = `title: ${doc.title}\nid: ${id}\nrevisionId: ${doc.revisionId}\nendIndex: ${runs.at(-1)?.end ?? 1}\n`
        + `tab: ${tabLabel(doc.tabs.find(tab => tab.tabProperties.tabId === doc.tabId))}`
        + (doc.tabs.length > 1 ? ` — all tabs: ${doc.tabs.map(tabLabel).join(', ')}; pass tabId to read or edit another` : '') + '\n'
      if (style.pageSize) {
        out += `page: ${rounded(style.pageSize.width?.magnitude)}x${rounded(style.pageSize.height?.magnitude)}pt, margins ` +
          MARGINS.map(key => `${key.slice(6).toLowerCase()} ${rounded(style[key]?.magnitude)}`).join(' ') + '\n'
      }
      out += `\nPass this revisionId to any edit tool; the edit is refused if the document changed since.\n`
      if (withProtected) {
        const mode = protectMode()
        const ranges = protectedRanges(doc, mode)
        // "(none)" would read as "I checked and found nothing marked", which is a different
        // fact from "the marker guard is switched off" — say which, like the baseline does.
        out += `\n--- PROTECTED ---\n` + (mode === 'off'
          ? 'disabled (GOOGLE_DOCS_MCP_PROTECT=off)'
          : ranges.length
            ? ranges.map(r => `[${r[0]}-${r[1]}] ${quote(doc, r)}`).join('\n')
            : '(none)') + '\n'
      }
      if (withBaseline) {
        out += `\n--- BASELINE ---\n${await baselineStatus(id, doc)}\n`
      }
      out += `\n--- TEXT ---\n${text}`
      if (withIndices) {
        const styles = new Map([...paragraphElements(doc.body?.content)].map(pe => [pe.startIndex, pe.textRun?.textStyle]))
        out += `\n\n--- INDEX MAP ---\n` +
          runs.map(r => `[${r.start}-${r.end}] ${JSON.stringify(r.text.slice(0, 80))}${styleTags(styles.get(r.start))}`).join('\n')
        out += describeExtras(doc)
      }
      return out + describeSegments(doc)
    },

    async replace_all_text(args) {
      const { revisionId, find, replace, matchCase = true } = args
      const { id, tabId, doc, mode, ranges } = await preflight('replace_all_text', args)
      const hits = findOccurrences(doc, find, matchCase)
      const blocked = hits.filter(([s, e]) => overlapping(ranges, s, e))
      if (blocked.length) {
        const hit = overlapping(ranges, blocked[0][0], blocked[0][1])
        throw refuse('replace_all_text', `${blocked.length} of ${hits.length} occurrence(s) of ${JSON.stringify(find)} land in`, doc, hit, mode,
          ` The other ${hits.length - blocked.length} are safe, but the Docs API replaces every occurrence in one atomic call and cannot skip any, so the whole call was refused; narrow the find string, or use replace_range on the safe occurrences one at a time.`)
      }
      const d = await batch(id, [
        { replaceAllText: { containsText: { text: find, matchCase }, replaceText: replace, ...(tabId && { tabsCriteria: { tabIds: [tabId] } }) } },
      ], revisionId)
      const n = d.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0
      return recordBaseline(id, `Replaced ${n} occurrence(s) of ${JSON.stringify(find)}.` +
        (n === 0 ? ' Nothing matched — check exact casing and whitespace.' : ''), tabId)
    },

    async insert_text(args) {
      const { revisionId, index, text } = args
      const { id, tabId, doc, mode, ranges } = await preflight('insert_text', args)
      const hit = strictlyInside(ranges, index)
      if (hit) throw refuse('insert_text', `the index ${index} falls inside`, doc, hit, mode,
        ` Inserting at ${hit[0]} or ${hit[1]} instead would leave it intact.`)
      await batch(id, [{ insertText: { location: at(index, tabId), text } }], revisionId)
      return recordBaseline(id, `Inserted ${text.length} chars at index ${index}.`, tabId)
    },

    async append_text(args) {
      const { text, allowProtected = false } = args
      const id = docId(args.documentId)
      const tabId = tabOf(args)
      const doc = await loadDoc(id, tabId)
      // append_text takes no revisionId, but it still must not adopt a drifted document as
      // the new baseline — that would quietly erase the evidence of the user's deletion.
      await checkDrift('append_text', id, doc)
      // The body's final newline is not a valid insert location, hence the -1.
      const end = (doc.body.content.at(-1)?.endIndex ?? 2) - 1
      const mode = protectMode()
      const requests = [{ insertText: { location: at(end, tabId), text } }]
      // Inserted text inherits the style of the run it follows, so appending below protected
      // text would quietly mark the new text protected too. Strip the marker back off.
      const clearHighlight = mode === 'highlight' || mode === 'both'
      if (!allowProtected && mode !== 'off') {
        requests.push({ updateTextStyle: {
          range: span({ startIndex: end, endIndex: end + text.length }, tabId),
          textStyle: { italic: false, ...(clearHighlight ? { backgroundColor: {} } : {}) },
          fields: clearHighlight ? 'italic,backgroundColor' : 'italic',
        } })
      }
      // The revisionId from the fetch above makes the append atomic with the end index it read.
      await batch(id, requests, doc.revisionId)
      return recordBaseline(id, `Appended ${text.length} chars at index ${end}.`, tabId)
    },

    async delete_range(args) {
      const { revisionId, startIndex, endIndex } = args
      const checked = await preflight('delete_range', args)
      guardRange('delete_range', checked, startIndex, endIndex)
      await batch(checked.id, [{ deleteContentRange: { range: span({ startIndex, endIndex }, checked.tabId) } }], revisionId)
      return recordBaseline(checked.id, `Deleted range ${startIndex}-${endIndex}.`, checked.tabId)
    },

    async replace_range(args) {
      const { revisionId, startIndex, endIndex, text } = args
      const checked = await preflight('replace_range', args)
      guardRange('replace_range', checked, startIndex, endIndex)
      // Delete and insert in one batch: separate calls would leave the doc half-edited and
      // every index after the deletion already shifted.
      await batch(checked.id, [
        { deleteContentRange: { range: span({ startIndex, endIndex }, checked.tabId) } },
        { insertText: { location: at(startIndex, checked.tabId), text } },
      ], revisionId)
      return recordBaseline(checked.id, `Replaced ${startIndex}-${endIndex} with ${text.length} chars.`, checked.tabId)
    },

    async format_text(args) {
      const { textStyle, fields } = textStyleFrom(args)
      const checked = await preflight('format_text', args)
      const { id, tabId, doc } = checked
      const found = resolveRanges(doc, args)
      for (const range of found) guardRange('format_text', checked, range.startIndex, range.endIndex)
      await batch(id, found.map(range => ({ updateTextStyle: { range: span(range, tabId), textStyle, fields } })), args.revisionId)
      return recordBaseline(id, `Set ${fields} on ${found.length} range(s): ${describeRanges(found)}.`, tabId)
    },

    async format_paragraph(args) {
      const { paragraphStyle, fields } = paragraphStyleFrom(args)
      const { bullets } = args
      if (bullets != null && bullets !== 'none' && !BULLET_PRESETS[bullets]) throw new Error('bullets must be disc, numbered or none.')
      if (!fields && bullets == null) throw new Error('No style given. Pass at least one of alignment, namedStyleType, lineSpacing, spaceAbove, spaceBelow, indentStart, indentFirstLine, bullets.')
      const checked = await preflight('format_paragraph', args)
      const { id, tabId, doc } = checked
      const found = resolveRanges(doc, args)
      if (args.namedStyleType != null) {
        for (const range of found) {
          const [from, to] = paragraphBounds(doc, range)
          guardRange('format_paragraph', checked, from, to, 'setting namedStyleType would strip the marker from')
        }
      }
      const requests = found.map(range => span(range, tabId)).flatMap(range => [
        ...(fields ? [{ updateParagraphStyle: { range, paragraphStyle, fields } }] : []),
        ...(bullets === 'none' ? [{ deleteParagraphBullets: { range } }] : []),
        ...(BULLET_PRESETS[bullets] ? [{ createParagraphBullets: { range, bulletPreset: BULLET_PRESETS[bullets] } }] : []),
      ])
      await batch(id, requests, args.revisionId)
      return recordBaseline(id, `Set ${[fields, bullets && `bullets=${bullets}`].filter(Boolean).join(',')} on the paragraph(s) at ${describeRanges(found)}.`, tabId)
    },

    async set_page_setup(args) {
      const { pageSize, pageWidth, pageHeight, orientation } = args
      const documentStyle = {}
      const fields = []
      for (const key of MARGINS) {
        if (args[key] != null) { documentStyle[key] = pt(args[key]); fields.push(key) }
      }
      if (pageSize != null && !PAGE_SIZES[pageSize]) throw new Error(`pageSize must be one of ${Object.keys(PAGE_SIZES).join(', ')}.`)
      if ((pageWidth == null) !== (pageHeight == null)) throw new Error('Give pageWidth and pageHeight together.')
      const sized = pageSize != null || pageWidth != null || orientation != null
      if (!fields.length && !sized) throw new Error('Nothing to set. Pass a margin, pageSize, pageWidth and pageHeight, or orientation.')
      const { id, tabId, doc } = await preflight('set_page_setup', args)
      if (sized) {
        const current = doc.documentStyle.pageSize
        let size = pageSize ? PAGE_SIZES[pageSize] : pageWidth != null ? [pageWidth, pageHeight] : [current.width.magnitude, current.height.magnitude]
        if (orientation === 'landscape') size = [Math.max(...size), Math.min(...size)]
        if (orientation === 'portrait') size = [Math.min(...size), Math.max(...size)]
        documentStyle.pageSize = { width: pt(size[0]), height: pt(size[1]) }
        fields.push('pageSize')
      }
      await batch(id, [{ updateDocumentStyle: { documentStyle, fields: fields.join(','), ...(tabId && { tabId }) } }], args.revisionId)
      return recordBaseline(id, `Set ${fields.join(',')}.`, tabId)
    },

    async insert_table(args) {
      const { rows, columns, index, cells } = args
      if (!(Number.isInteger(rows) && Number.isInteger(columns) && rows > 0 && columns > 0)) throw new Error('rows and columns must be whole numbers above 0.')
      const checked = await preflight('insert_table', args)
      const { id, tabId } = checked
      guardInsert('insert_table', checked, index)
      await batch(id, [{ insertTable: { rows, columns, ...place(index, tabId) } }], args.revisionId)
      const doc = await loadDoc(id, tabId)
      const tables = bodyTables(doc)
      const created = index == null ? tables.at(-1) : tables.find(el => el.startIndex >= index)
      if (cells?.length) {
        // Filled last cell first, so each insert leaves the earlier cells' indices untouched.
        const inserts = []
        for (let row = rows - 1; row >= 0; row--) {
          for (let column = columns - 1; column >= 0; column--) {
            const text = cells[row]?.[column]
            if (text) inserts.push({ insertText: { location: at(created.table.tableRows[row].tableCells[column].content[0].startIndex, tabId), text } })
          }
        }
        if (inserts.length) await batch(id, inserts, doc.revisionId)
      }
      return recordBaseline(id, `Inserted table ${tables.indexOf(created) + 1} (${rows} rows x ${columns} columns) at index ${created.startIndex}.`, tabId)
    },

    async edit_table(args) {
      const { action, row, column, position, rowSpan = 1, columnSpan = 1, width } = args
      if (!TABLE_ACTIONS.includes(action)) throw new Error(`action must be one of ${TABLE_ACTIONS.join(', ')}.`)
      const checked = await preflight('edit_table', args)
      const { id, tabId, doc } = checked
      const tableElement = tableAt(doc, args.table)
      const tableStartLocation = at(tableElement.startIndex, tabId)
      let request
      if (action === 'delete_table') {
        guardRange('edit_table', checked, tableElement.startIndex, tableElement.endIndex, 'deleting the table would remove')
        request = { deleteContentRange: { range: span({ startIndex: tableElement.startIndex, endIndex: tableElement.endIndex }, tabId) } }
      } else if (action === 'set_column_width') {
        if (!Number.isInteger(column) || column < 1 || column > tableElement.table.columns) throw new Error(`column must be 1-${tableElement.table.columns}.`)
        if (!(width > 0)) throw new Error('width must be a number of points above 0.')
        request = { updateTableColumnProperties: { tableStartLocation, columnIndices: [column - 1],
          tableColumnProperties: { widthType: 'FIXED_WIDTH', width: pt(width) }, fields: 'widthType,width' } }
      } else {
        cellAt(tableElement, row, column)
        const tableRows = tableElement.table.tableRows
        if (action === 'delete_row') guardRange('edit_table', checked, tableRows[row - 1].startIndex, tableRows[row - 1].endIndex, 'deleting the row would remove')
        if (action === 'delete_column') {
          for (const tableRow of tableRows) {
            const cell = tableRow.tableCells[column - 1]
            if (cell) guardRange('edit_table', checked, cell.startIndex, cell.endIndex, 'deleting the column would remove')
          }
        }
        const tableCellLocation = { tableStartLocation, rowIndex: row - 1, columnIndex: column - 1 }
        const tableRange = { tableCellLocation, rowSpan, columnSpan }
        request = {
          insert_row: { insertTableRow: { tableCellLocation, insertBelow: position !== 'before' } },
          insert_column: { insertTableColumn: { tableCellLocation, insertRight: position !== 'before' } },
          delete_row: { deleteTableRow: { tableCellLocation } },
          delete_column: { deleteTableColumn: { tableCellLocation } },
          merge_cells: { mergeTableCells: { tableRange } },
          unmerge_cells: { unmergeTableCells: { tableRange } },
        }[action]
      }
      await batch(id, [request], args.revisionId)
      return recordBaseline(id, `Did ${action} on table ${args.table}.`, tabId)
    },

    async set_table_cell_text(args) {
      const checked = await preflight('set_table_cell_text', args)
      const { id, tabId, doc } = checked
      const cell = cellAt(tableAt(doc, args.table), args.row, args.column)
      const startIndex = cell.content[0].startIndex
      // The cell's final newline cannot be deleted, hence the -1.
      const endIndex = cell.content.at(-1).endIndex - 1
      guardRange('set_table_cell_text', checked, startIndex, endIndex + 1, 'the cell holds')
      await batch(id, [
        ...(endIndex > startIndex ? [{ deleteContentRange: { range: span({ startIndex, endIndex }, tabId) } }] : []),
        ...(args.text ? [{ insertText: { location: at(startIndex, tabId), text: args.text } }] : []),
      ], args.revisionId)
      return recordBaseline(id, `Set table ${args.table} r${args.row}c${args.column} to ${JSON.stringify(args.text)}.`, tabId)
    },

    async style_table_cells(args) {
      const { row, column, rowSpan = 1, columnSpan = 1, backgroundColor, borderWidth, borderColor, padding, verticalAlignment } = args
      const tableCellStyle = {}
      const fields = []
      if (backgroundColor != null) {
        if (backgroundColor !== '') tableCellStyle.backgroundColor = hexColor(backgroundColor)
        fields.push('backgroundColor')
      }
      if (borderWidth != null || borderColor != null) {
        const border = { width: pt(borderWidth ?? 1), color: hexColor(borderColor ?? '#000000'), dashStyle: 'SOLID' }
        for (const side of ['borderTop', 'borderBottom', 'borderLeft', 'borderRight']) { tableCellStyle[side] = border; fields.push(side) }
      }
      if (padding != null) {
        for (const side of ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight']) { tableCellStyle[side] = pt(padding); fields.push(side) }
      }
      if (verticalAlignment != null) { tableCellStyle.contentAlignment = verticalAlignment; fields.push('contentAlignment') }
      if (!fields.length) throw new Error('No style given. Pass at least one of backgroundColor, borderWidth, borderColor, padding, verticalAlignment.')
      if ((row == null) !== (column == null)) throw new Error('Give row and column together, or neither to style the whole table.')
      const { id, tabId, doc } = await preflight('style_table_cells', args)
      const tableElement = tableAt(doc, args.table)
      const tableStartLocation = at(tableElement.startIndex, tabId)
      if (row != null) cellAt(tableElement, row, column)
      const target = row == null
        ? { tableStartLocation }
        : { tableRange: { tableCellLocation: { tableStartLocation, rowIndex: row - 1, columnIndex: column - 1 }, rowSpan, columnSpan } }
      await batch(id, [{ updateTableCellStyle: { ...target, tableCellStyle, fields: fields.join(',') } }], args.revisionId)
      return recordBaseline(id, `Set ${fields.join(',')} on table ${args.table}${row == null ? '' : ` from r${row}c${column}, ${rowSpan}x${columnSpan} cells`}.`, tabId)
    },

    async insert_image(args) {
      const { uri, index, width, height } = args
      if ((width == null) !== (height == null)) throw new Error('Give width and height together, or neither to keep the image\'s own size.')
      const checked = await preflight('insert_image', args)
      guardInsert('insert_image', checked, index)
      const d = await batch(checked.id, [{ insertInlineImage: { uri, ...place(index, checked.tabId),
        ...(width != null && { objectSize: { width: pt(width), height: pt(height) } }) } }], args.revisionId)
      return recordBaseline(checked.id, `Inserted image ${d.replies?.[0]?.insertInlineImage?.objectId}.`, checked.tabId)
    },

    async replace_image(args) {
      const { id, tabId } = await preflight('replace_image', args)
      await batch(id, [{ replaceImage: { imageObjectId: args.imageId, uri: args.uri, imageReplaceMethod: 'CENTER_CROP', ...(tabId && { tabId }) } }], args.revisionId)
      return recordBaseline(id, `Replaced image ${args.imageId}.`, tabId)
    },

    async insert_break(args) {
      const { type, index } = args
      if (!(type in BREAKS)) throw new Error(`type must be one of ${Object.keys(BREAKS).join(', ')}.`)
      const checked = await preflight('insert_break', args)
      guardInsert('insert_break', checked, index)
      const where = place(index, checked.tabId)
      const request = type === 'page' ? { insertPageBreak: where } : { insertSectionBreak: { sectionType: BREAKS[type], ...where } }
      await batch(checked.id, [request], args.revisionId)
      return recordBaseline(checked.id, `Inserted ${type} break ${index == null ? 'at the end' : `at index ${index}`}.`, checked.tabId)
    },

    async set_section_columns(args) {
      const { columns, gap = 36 } = args
      if (!Number.isInteger(columns) || columns < 1 || columns > 3) throw new Error('columns must be 1, 2 or 3.')
      const { id, tabId, doc } = await preflight('set_section_columns', args)
      const found = resolveRanges(doc, args)
      const sectionStyle = { columnProperties: Array.from({ length: columns }, () => ({ paddingEnd: pt(gap) })), columnSeparatorStyle: 'NONE' }
      await batch(id, found.map(range => ({ updateSectionStyle: { range: span(range, tabId), sectionStyle, fields: 'columnProperties,columnSeparatorStyle' } })), args.revisionId)
      return recordBaseline(id, `Set ${columns} column(s) on the section(s) at ${describeRanges(found)}.`, tabId)
    },

    async set_header_footer(args) {
      const { kind, text, remove } = args
      if (kind !== 'header' && kind !== 'footer') throw new Error('kind must be header or footer.')
      if (!remove && text == null) throw new Error('Give `text`, or remove: true.')
      const [Kind, idKey] = kind === 'header' ? ['Header', 'headerId'] : ['Footer', 'footerId']
      const { id, tabId, doc } = await preflight('set_header_footer', args)
      let segmentId = doc.documentStyle?.[`default${Kind}Id`]
      if (remove) {
        if (!segmentId) return `There is no ${kind} to remove.`
        await batch(id, [{ [`delete${Kind}`]: { [idKey]: segmentId, ...(tabId && { tabId }) } }], args.revisionId)
        return recordBaseline(id, `Removed the ${kind}.`, tabId)
      }
      if (!segmentId) {
        const d = await batch(id, [{ [`create${Kind}`]: { type: 'DEFAULT', ...(tabId && { sectionBreakLocation: at(0, tabId) }) } }], args.revisionId)
        segmentId = d.replies[0][`create${Kind}`][idKey]
        if (text) await batch(id, [{ insertText: { location: at(0, tabId, segmentId), text } }])
        return recordBaseline(id, `Created the ${kind}.`, tabId)
      }
      const endIndex = doc[`${kind}s`][segmentId].content.at(-1).endIndex - 1
      await batch(id, [
        ...(endIndex > 0 ? [{ deleteContentRange: { range: span({ startIndex: 0, endIndex }, tabId, segmentId) } }] : []),
        ...(text ? [{ insertText: { location: at(0, tabId, segmentId), text } }] : []),
      ], args.revisionId)
      return recordBaseline(id, `Updated the ${kind}.`, tabId)
    },

    async insert_footnote(args) {
      let { index } = args
      if (args.find != null && index != null) throw new Error('Give `find` or `index`, not both.')
      const checked = await preflight('insert_footnote', args)
      const { id, tabId, doc } = checked
      if (args.find != null) {
        const found = resolveRanges(doc, { ...args, startIndex: undefined, endIndex: undefined })
        if (found.length > 1) throw new Error('A footnote goes in one place; pass a numbered occurrence, not "all".')
        index = found[0].endIndex
      }
      guardInsert('insert_footnote', checked, index)
      const d = await batch(id, [{ createFootnote: place(index, tabId) }], args.revisionId)
      const footnoteId = d.replies[0].createFootnote.footnoteId
      // A new footnote opens with one space; the text goes after it.
      await batch(id, [{ insertText: { location: at(1, tabId, footnoteId), text: args.text } }])
      return recordBaseline(id, `Added footnote ${footnoteId}.`, tabId)
    },

    async create_named_range(args) {
      const { id, tabId, doc } = await preflight('create_named_range', args)
      const found = resolveRanges(doc, args)
      await batch(id, found.map(range => ({ createNamedRange: { name: args.name, range: span(range, tabId) } })), args.revisionId)
      return recordBaseline(id, `Named ${JSON.stringify(args.name)}: ${describeRanges(found)}.`, tabId)
    },

    async replace_named_range(args) {
      const checked = await preflight('replace_named_range', args)
      const { id, tabId, doc } = checked
      const group = doc.namedRanges?.[args.name]
      if (!group) throw new Error(`No named range ${JSON.stringify(args.name)}. Existing: ${Object.keys(doc.namedRanges ?? {}).map(name => JSON.stringify(name)).join(', ') || 'none'}.`)
      for (const range of group.namedRanges.flatMap(entry => entry.ranges ?? [])) {
        guardRange('replace_named_range', checked, range.startIndex ?? 0, range.endIndex)
      }
      await batch(id, [{ replaceNamedRangeContent: { namedRangeName: args.name, text: args.text, ...(tabId && { tabsCriteria: { tabIds: [tabId] } }) } }], args.revisionId)
      return recordBaseline(id, `Replaced the content of ${JSON.stringify(args.name)}.`, tabId)
    },

    async delete_named_range(args) {
      const { id, tabId, doc } = await preflight('delete_named_range', args)
      if (!doc.namedRanges?.[args.name]) throw new Error(`No named range ${JSON.stringify(args.name)}.`)
      await batch(id, [{ deleteNamedRange: { name: args.name, ...(tabId && { tabsCriteria: { tabIds: [tabId] } }) } }], args.revisionId)
      return recordBaseline(id, `Deleted named range ${JSON.stringify(args.name)}.`, tabId)
    },

    async replace_body(args) {
      // This overwrites the WHOLE document, so it is gated hardest: a missing or stale
      // revisionId is a refusal rather than a silent clobber, and any protected text at all
      // blocks it, since there is no way to rewrite the body and keep that text.
      const { id, doc, mode, ranges } = await preflight('replace_body', args)
      if (ranges.length) {
        throw refuse('replace_body', `the document contains`, doc, ranges[0], mode,
          `${ranges.length > 1 ? ` There are ${ranges.length} protected ranges in all.` : ''} replace_body rewrites the entire body, so all of it would be discarded; use replace_range on the sections you actually mean to change.`)
      }
      await google.replaceDocHtml(id, args.html)
      return recordBaseline(id, `Replaced body of ${id}. URL unchanged: https://docs.google.com/document/d/${id}/edit`)
    },

    async create_doc({ title, html, folderId }) {
      const { id, name } = await google.createDoc({ title, html, folderId })
      return recordBaseline(id, `Created "${name}"\nid: ${id}\nhttps://docs.google.com/document/d/${id}/edit`)
    },

    async sync_baseline(args) {
      const id = docId(args.documentId)
      const doc = await loadDoc(id, tabOf(args))
      const text = docText(doc)
      const key = baselineKey(id, doc)
      const prev = await baseline.load(key)
      await baseline.save(key, { revisionId: doc.revisionId, text })
      if (!prev) return 'No previous baseline; adopted current text.'
      const diff = diffParagraphs(paragraphs(prev.text), paragraphs(text))
      return hasDrift(diff)
        ? `Baseline updated to revision ${doc.revisionId}. Adopted:\n${describeDrift(diff)}`
        : `Baseline updated to revision ${doc.revisionId}. Nothing had changed since the previous baseline.`
    },
  }

  return async function callTool(name, args) {
    const fn = handlers[name]
    if (!fn) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
    try {
      return { content: [{ type: 'text', text: await fn(args ?? {}) }] }
    } catch (e) {
      const detail = e?.response?.data?.error?.message || e.message
      return { isError: true, content: [{ type: 'text', text: `${name} failed: ${detail}` }] }
    }
  }
}
