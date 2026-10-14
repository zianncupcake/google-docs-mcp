// The Google client tools.mjs needs, over plain fetch: googleapis is too heavy for a Worker.
const DOCS = 'https://docs.googleapis.com/v1/documents'
const DRIVE = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'
const GOOGLE_DOC = 'application/vnd.google-apps.document'

export function googleDocs(accessToken) {
  async function call(url, init = {}) {
    const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${accessToken}`, ...init.headers } })
    const body = await res.json().catch(() => null)
    if (!res.ok) throw new Error(body?.error?.message ?? `Google answered ${res.status}`)
    return body
  }
  const json = (method, value) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
  // Ids come from the caller, so they are encoded rather than trusted to stay inside the path.
  const doc = (id) => `${DOCS}/${encodeURIComponent(id)}`

  return {
    getDoc: (id) => call(`${doc(id)}?includeTabsContent=true`),
    batchUpdate: (id, requestBody) => call(`${doc(id)}:batchUpdate`, json('POST', requestBody)),
    createDoc({ title, html, folderId }) {
      const metadata = { name: title, mimeType: GOOGLE_DOC, ...(folderId ? { parents: [folderId] } : {}) }
      if (!html) return call(`${DRIVE}?fields=id,name`, json('POST', metadata))
      const boundary = crypto.randomUUID()
      const body = [
        `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata),
        `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', '', html,
        `--${boundary}--`,
      ].join('\r\n')
      return call(`${UPLOAD}?uploadType=multipart&fields=id,name`, {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
      })
    },
    async replaceDocHtml(id, html) {
      await call(`${UPLOAD}/${encodeURIComponent(id)}?uploadType=media`, {
        method: 'PATCH', headers: { 'Content-Type': 'text/html; charset=UTF-8' }, body: html,
      })
    },
  }
}
