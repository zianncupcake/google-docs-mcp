// The Worker's baseline store. Each signed-in user has a Durable Object of their own, so no document
// key one user can pass can name another user's snapshot, and a load always sees the last save.
// A snapshot holds a whole document's text, so it is deleted 30 days after its last save.
const TTL_MS = 30 * 24 * 60 * 60 * 1000

export function userBaseline(namespace, userId) {
  return namespace.get(namespace.idFromName(userId))
}

// The storage side of the Baselines Durable Object in index.mjs.
export class BaselineStore {
  constructor(storage) {
    this.storage = storage
  }

  async load(key) {
    return (await this.storage.get(key)) ?? null
  }

  // The alarm is always due no later than the oldest snapshot's expiry, and a save only makes a
  // snapshot newer, so a save need only set the alarm when there is none.
  async save(key, { revisionId, text }) {
    await this.storage.put(key, { revisionId, text, savedAt: new Date().toISOString() })
    if (await this.storage.getAlarm() === null) await this.storage.setAlarm(Date.now() + TTL_MS)
  }

  async alarm() {
    let next = Infinity
    for (const [key, { savedAt }] of await this.storage.list()) {
      const expires = Date.parse(savedAt) + TTL_MS
      if (expires <= Date.now()) await this.storage.delete(key)
      else next = Math.min(next, expires)
    }
    if (next !== Infinity) await this.storage.setAlarm(next)
  }
}
