// The Google client tools.mjs needs, over plain fetch: googleapis is too heavy for a Worker.
import { driveQuery } from '../tools.mjs'

const DOCS = 'https://docs.googleapis.com/v1/documents'
const DRIVE = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'
const EXPORT = 'https://docs.google.com/document/d'
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
    async findFiles({ query, limit, mimeType }) {
      const params = new URLSearchParams({
        q: driveQuery(query, mimeType),
        pageSize: String(Math.min(Math.max(limit, 1), 100)),
        orderBy: 'modifiedTime desc',
        fields: 'files(id,name,modifiedTime,webViewLink)',
        spaces: 'drive',
      })
      const body = await call(`${DRIVE}?${params}`)
      return body.files ?? []
    },
    // Drive's files.export is refused for docs this app did not create; the Docs download URL is not.
    async exportDoc(id, format) {
      const res = await fetch(`${EXPORT}/${encodeURIComponent(id)}/export?format=${format}`, { headers: { Authorization: `Bearer ${accessToken}` } })
      if (res.status === 429) throw new Error('Google is rate-limiting exports. Try again in a moment.')
      if (!res.ok) throw new Error(`Google answered ${res.status}`)
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        mimeType: res.headers.get('Content-Type').split(';')[0],
        // filename* rather than filename="…", which has the title's spaces and non-ASCII letters stripped.
        filename: decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(res.headers.get('Content-Disposition'))[1]),
      }
    },
  }
}
