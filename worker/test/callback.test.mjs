import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { MemoryKV } from './memory-kv.mjs'

// The Worker and its OAuth provider import a Workers-only module for classes these tests never
// reach, so Node is handed an empty stand-in before the Worker is loaded.
register('data:text/javascript,' + encodeURIComponent(`export const resolve = (specifier, context, next) =>
  specifier === 'cloudflare:workers'
    ? { url: 'data:text/javascript,export class WorkerEntrypoint {}; export class DurableObject {}', shortCircuit: true }
    : next(specifier, context)`))
const { default: worker } = await import('../index.mjs')

const ORIGIN = 'https://docs-mcp.example.workers.dev'
const CLIENT_REDIRECT = 'https://client.example/callback'

test('the Google callback refuses a missing or mismatched state before asking Google', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Google must not be called') })
  const env = { OAUTH_KV: new MemoryKV(), GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }
  const send = (path, init) => worker.fetch(new Request(ORIGIN + path, init), env, { waitUntil() {}, passThroughOnException() {} })
  const cookie = (res, kind) => res.headers.getSetCookie().find(c => c.startsWith(`__Host-oauth-${kind}-`)).split(';')[0]

  // A genuine sign-in up to the redirect to Google, so the forged callbacks below have a real state to differ from.
  const registered = await send('/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: 'none' }),
  })
  const { client_id } = await registered.json()
  const page = await send('/authorize?' + new URLSearchParams({
    response_type: 'code', client_id, redirect_uri: CLIENT_REDIRECT, state: 'client-state',
    code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: `${ORIGIN}/mcp`,
  }))
  const handle = /name="handle" value="([^"]+)"/.exec(await page.text())[1]
  const approved = await send('/authorize', {
    method: 'POST', headers: { Cookie: cookie(page, 'consent') }, body: new URLSearchParams({ handle, decision: 'allow' }),
  })
  const state = new URL(approved.headers.get('Location')).searchParams.get('state')
  const browser = cookie(approved, 'upstream')

  for (const [label, query, headers] of [
    ['no state', '?code=c', { Cookie: browser }],
    ['a state this server never issued', '?code=c&state=forged', { Cookie: browser }],
    ['the real state, from a browser without its cookie', `?code=c&state=${state}`, {}],
  ]) {
    const res = await send(`/callback${query}`, { headers })
    assert.equal(res.status, 400, label)
  }
})
