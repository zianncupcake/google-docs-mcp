// The Worker's baseline store. Every key starts with the signed-in user's id, encoded so it holds
// no separator, so no document key one user can pass can name another user's snapshot.
// A snapshot holds a whole document's text, so it is kept only 30 days from its last save.
const TTL_SECONDS = 30 * 24 * 60 * 60

export function kvBaseline(kv, userId) {
  const prefix = `${encodeURIComponent(userId)}:`
  return {
    load: (key) => kv.get(prefix + key, 'json'),
    save: (key, { revisionId, text }) =>
      kv.put(prefix + key, JSON.stringify({ revisionId, text, savedAt: new Date().toISOString() }), { expirationTtl: TTL_SECONDS }),
  }
}
