// The Worker's baseline store. Every key starts with the signed-in user's id, encoded so it holds
// no separator, so no document key one user can pass can name another user's snapshot.
export function kvBaseline(kv, userId) {
  const prefix = `${encodeURIComponent(userId)}:`
  return {
    load: (key) => kv.get(prefix + key, 'json'),
    save: (key, { revisionId, text }) =>
      kv.put(prefix + key, JSON.stringify({ revisionId, text, savedAt: new Date().toISOString() })),
  }
}
