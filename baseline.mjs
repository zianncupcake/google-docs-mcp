// revisionId only guards the gap between one read and the write that immediately follows
// it. It cannot see a change the human made between my LAST write and my NEXT read: by
// then their version IS the current revision, so a regenerated body overwrites it with the
// server's blessing. Deletions are the worst case — protect.mjs can only defend text that
// still exists, and deleted text leaves no marker behind.
//
// So the server keeps its own copy of what it last wrote and compares content rather than
// revisions. The pure half below (flatten, split, diff, describe) is what the tests
// exercise; the I/O half is deliberately thin.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const CONFIG_DIR = join(homedir(), '.config', 'google-docs-mcp')
const SNAPSHOT_DIR = process.env.GOOGLE_DOCS_MCP_SNAPSHOTS || join(CONFIG_DIR, 'snapshots')

// ---------- pure ----------

// The runs of a fetched document, with the character indices the edit tools need. index.mjs
// reads the same function so the text the baseline diffs is exactly the text read_doc
// reports; two flatteners would drift apart, and that drift would look like the user's edit.
export function docRuns(doc) {
  const runs = []
  for (const el of doc?.body?.content ?? []) {
    for (const pe of el.paragraph?.elements ?? []) {
      const t = pe.textRun?.content
      if (t) runs.push({ start: pe.startIndex, end: pe.endIndex, text: t })
    }
  }
  return runs
}

export function docText(doc) {
  return docRuns(doc).map(r => r.text).join('')
}

// Paragraphs, not characters, are the unit a human recognises in a diff. Blank lines and
// trailing whitespace shift constantly as Docs reflows, and reporting those as drift would
// train the assistant to ignore the warning.
export function paragraphs(text) {
  return String(text ?? '').split('\n').map(p => p.trim()).filter(Boolean)
}

// LCS alone still reports a paragraph that merely moved as removed AND added. A move is not
// a content change, so cancel identical text off both sides and count it as unchanged.
function cancelMoves(added, removed, unchanged) {
  const spare = new Map()
  for (const p of removed) spare.set(p, (spare.get(p) ?? 0) + 1)

  const keptAdded = []
  let moved = 0
  for (const p of added) {
    const n = spare.get(p) ?? 0
    if (n > 0) { spare.set(p, n - 1); moved++ }
    else keptAdded.push(p)
  }
  // spare now holds the removals that found no partner; take them in their original order.
  const keptRemoved = []
  for (const p of removed) {
    const n = spare.get(p) ?? 0
    if (n > 0) { spare.set(p, n - 1); keptRemoved.push(p) }
  }
  return { added: keptAdded, removed: keptRemoved, unchanged: unchanged + moved }
}

// A plain O(n*m) LCS table. These documents run to a few hundred paragraphs, so the table
// costs microseconds and buys the diff no dependency at all.
export function diffParagraphs(before, after) {
  const n = before.length
  const m = after.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const added = []
  const removed = []
  let i = 0
  let j = 0
  let unchanged = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) { unchanged++; i++; j++ }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) removed.push(before[i++])
    else added.push(after[j++])
  }
  while (i < n) removed.push(before[i++])
  while (j < m) added.push(after[j++])

  return cancelMoves(added, removed, unchanged)
}

export function hasDrift(diff) {
  return diff.added.length > 0 || diff.removed.length > 0
}

const MAX_LISTED = 5
const MAX_QUOTED = 80

function quote(p) {
  const flat = p.replace(/\s+/g, ' ')
  return JSON.stringify(flat.length > MAX_QUOTED ? `${flat.slice(0, MAX_QUOTED)}…` : flat)
}

function plural(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

// Short enough to read at a glance, specific enough that the user's own sentence is
// recognisable in it — a bare count would not be worth refusing a write over.
export function describeDrift(diff) {
  if (!hasDrift(diff)) return ''
  const parts = []
  if (diff.removed.length) parts.push(`${plural(diff.removed.length, 'paragraph')} removed`)
  if (diff.added.length) {
    parts.push(diff.removed.length ? `${diff.added.length} added` : `${plural(diff.added.length, 'paragraph')} added`)
  }
  const lines = [`${parts.join(', ')} since my last write`]
  for (const [label, list] of [['removed', diff.removed], ['added', diff.added]]) {
    if (!list.length) continue
    lines.push(`${label}:`)
    for (const p of list.slice(0, MAX_LISTED)) lines.push(`  - ${quote(p)}`)
    if (list.length > MAX_LISTED) lines.push(`  … and ${list.length - MAX_LISTED} more ${label}`)
  }
  return lines.join('\n')
}

// Read at call time, like protectMode, so the switch can be flipped without a rebuild.
export function baselineEnabled(env = process.env) {
  return String(env.GOOGLE_DOCS_MCP_BASELINE ?? '').trim().toLowerCase() !== 'off'
}

// ---------- I/O ----------

// Doc ids arrive from the caller, so nothing but id characters may reach the path.
export function snapshotPath(documentId) {
  return join(SNAPSHOT_DIR, `${String(documentId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
}

// A missing or corrupt snapshot degrades to "no baseline". Losing the safety net for one
// write is bad; failing every write because a file was deleted by hand is worse.
export async function loadSnapshot(documentId) {
  try {
    const snap = JSON.parse(await readFile(snapshotPath(documentId), 'utf8'))
    return typeof snap?.text === 'string' ? snap : null
  } catch {
    return null
  }
}

export async function saveSnapshot(documentId, { revisionId, text }) {
  const path = snapshotPath(documentId)
  await mkdir(dirname(path), { recursive: true })
  const snap = { revisionId, text, savedAt: new Date().toISOString() }
  // Mode 600 like token.json: these files hold whole document bodies.
  await writeFile(path, JSON.stringify(snap, null, 2), { mode: 0o600 })
  return snap
}

export { SNAPSHOT_DIR }
