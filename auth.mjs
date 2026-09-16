import { google } from 'googleapis'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const CONFIG_DIR = join(homedir(), '.config', 'google-docs-mcp')
const TOKEN_PATH = process.env.GOOGLE_DOCS_MCP_TOKEN || join(CONFIG_DIR, 'token.json')
const CREDS_PATH = process.env.GOOGLE_OAUTH_CREDENTIALS || join(CONFIG_DIR, 'credentials.json')

// 'documents' covers every doc the user can already open; drive.file is limited to
// files this app created, which is why wholesale-replace only works on those.
const SCOPES = (process.env.GOOGLE_DOCS_MCP_SCOPES ||
  'https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file').split(/\s+/)

async function loadClient() {
  const raw = JSON.parse(await readFile(CREDS_PATH, 'utf8'))
  const conf = raw.installed || raw.web
  if (!conf) throw new Error(`${CREDS_PATH} has neither an "installed" nor "web" client`)
  return conf
}

// Google's desktop-client loopback flow: any localhost port is accepted, but the
// SAME port must be used for consent and for the token exchange.
async function interactiveConsent(conf) {
  return new Promise((resolve, reject) => {
    let oauth2, redirectUri

    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const code = url.searchParams.get('code')
      const err = url.searchParams.get('error')
      if (!code && !err) { res.writeHead(204); res.end(); return }

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<html><body style="font:16px system-ui;padding:3rem">
        <h2>${code ? 'Authorised.' : 'Authorisation failed.'}</h2>
        <p>${code ? 'Close this tab and return to your terminal.' : String(err)}</p>
      </body></html>`)
      server.close()

      if (err) return reject(new Error(`OAuth denied: ${err}`))
      try {
        const { tokens } = await oauth2.getToken({ code, redirect_uri: redirectUri })
        resolve(tokens)
      } catch (e) {
        reject(new Error(e?.response?.data?.error_description || e?.response?.data?.error || e.message))
      }
    })

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      redirectUri = `http://localhost:${port}`
      oauth2 = new google.auth.OAuth2(conf.client_id, conf.client_secret, redirectUri)
      const url = oauth2.generateAuthUrl({
        access_type: 'offline', prompt: 'consent', scope: SCOPES, redirect_uri: redirectUri,
      })
      process.stderr.write(`\nAuthorise this app:\n\n${url}\n\n`)
    })
    server.on('error', reject)
  })
}

export async function getAuth() {
  const conf = await loadClient()
  const oauth2 = new google.auth.OAuth2(conf.client_id, conf.client_secret, 'http://localhost')

  try {
    const tokens = JSON.parse(await readFile(TOKEN_PATH, 'utf8'))
    oauth2.setCredentials(tokens)
    // Refresh eagerly so a stale access token surfaces here, not mid-tool-call.
    if (tokens.refresh_token) await oauth2.getAccessToken()
    return oauth2
  } catch {
    const tokens = await interactiveConsent(conf)
    await mkdir(dirname(TOKEN_PATH), { recursive: true })
    await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 })
    oauth2.setCredentials(tokens)
    return oauth2
  }
}

export { SCOPES, TOKEN_PATH, CREDS_PATH }
