// The stdio server's baseline store: one JSON file per document under ~/.config.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const SNAPSHOT_DIR = process.env.GOOGLE_DOCS_MCP_SNAPSHOTS || join(homedir(), '.config', 'google-docs-mcp', 'snapshots')

// Doc ids arrive from the caller, so nothing but id characters may reach the path.
function snapshotPath(key) {
  return join(SNAPSHOT_DIR, `${String(key).replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
}

// A missing or corrupt snapshot degrades to "no baseline". Losing the safety net for one
// write is bad; failing every write because a file was deleted by hand is worse.
export async function load(key) {
  try {
    const snap = JSON.parse(await readFile(snapshotPath(key), 'utf8'))
    return typeof snap?.text === 'string' ? snap : null
  } catch {
    return null
  }
}

export async function save(key, { revisionId, text }) {
  const path = snapshotPath(key)
  await mkdir(dirname(path), { recursive: true })
  const snap = { revisionId, text, savedAt: new Date().toISOString() }
  // Mode 600 like token.json: these files hold whole document bodies.
  await writeFile(path, JSON.stringify(snap, null, 2), { mode: 0o600 })
  return snap
}
