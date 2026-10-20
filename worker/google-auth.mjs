// Signing in with Google, plus the public pages. The OAuth provider sends every request outside
// /mcp here and gives its helpers as env.OAUTH_PROVIDER; they bind the consent page and Google's
// `state` to the browser, so a forged or replayed callback is refused before Google is asked for anything.
import { AuthorizationError, OAuthError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider'
import { consentPage, homepage, privacyPolicy } from './pages.mjs'

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
// openid adds only an id_token, whose subject is the user id that grants and baselines are keyed by.
const SCOPES = 'openid https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly'

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url)
    try {
      if (pathname === '/' && request.method === 'GET') return homepage(request)
      if (pathname === '/privacy' && request.method === 'GET') return privacyPolicy()
      if (pathname === '/authorize' && request.method === 'GET') return await showConsent(request, env.OAUTH_PROVIDER)
      if (pathname === '/authorize' && request.method === 'POST') return await redirectToGoogle(request, env)
      if (pathname === '/callback') return await finishSignIn(request, env)
      return new Response('Not found', { status: 404 })
    } catch (error) {
      if (!(error instanceof AuthorizationError)) throw error
      if (error.redirectTo) return Response.redirect(error.redirectTo, 302)
      return new Response(error.description, { status: 400 })
    }
  },
}

// Every MCP client reaches Google through this one OAuth app, so each one is shown to the user
// before Google is: otherwise any site could register a client and collect the user's Docs access.
async function showConsent(request, oauth) {
  const authRequest = await oauth.parseAuthRequest(request)
  const client = await oauth.describeConsent(authRequest)
  const { handle, headers } = await oauth.beginConsent(authRequest)
  headers.set('Content-Type', 'text/html; charset=utf-8')
  return new Response(consentPage(client, handle), { headers })
}

async function redirectToGoogle(request, env) {
  const oauth = env.OAUTH_PROVIDER
  const form = await request.formData()
  const handle = String(form.get('handle'))
  if (form.get('decision') !== 'allow') {
    const { headers } = await oauth.denyConsent(request, handle)
    return new Response(null, { status: 302, headers })
  }
  const approved = await oauth.approveConsent(request, handle)
  const { state, headers } = await oauth.beginUpstream(approved.request, { headers: approved.headers })
  const url = new URL(GOOGLE_AUTHORIZE)
  // prompt=consent makes Google return a refresh token on every sign-in, not only the first.
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: callbackUrl(request), response_type: 'code',
    scope: SCOPES, state, access_type: 'offline', prompt: 'consent',
  })
  headers.set('Location', url.href)
  return new Response(null, { status: 302, headers })
}

async function finishSignIn(request, env) {
  const oauth = env.OAUTH_PROVIDER
  const { request: authRequest, headers } = await oauth.finishUpstream(request)
  const params = new URL(request.url).searchParams
  if (params.get('error')) {
    headers.set('Location', authorizationErrorRedirect(authRequest, 'access_denied'))
    return new Response(null, { status: 302, headers })
  }
  const tokens = await googleToken(env, { grant_type: 'authorization_code', code: params.get('code'), redirect_uri: callbackUrl(request) })
  if (!tokens.access_token) return new Response(`Google sign-in failed: ${tokens.error_description ?? tokens.error}`, { status: 502 })
  const userId = subject(tokens.id_token)
  const { redirectTo } = await oauth.completeAuthorization({
    request: authRequest, userId, metadata: {}, scope: authRequest.scope,
    props: { userId, ...googleSession(tokens) },
  })
  headers.set('Location', redirectTo)
  return new Response(null, { status: 302, headers })
}

// Google's token in props must outlive the MCP access token issued with it, so ours ends a
// minute sooner, and the client's refresh of ours is when Google's is refreshed.
const accessTokenTTL = (props) => Math.floor((props.expiresAt - Date.now()) / 1000) - 60

export async function tokenExchangeCallback({ grantType, props, env }) {
  if (grantType === 'authorization_code') return { accessTokenTTL: accessTokenTTL(props) }
  if (grantType !== 'refresh_token') return
  // invalid_grant makes the provider revoke this grant, so the client signs in again rather
  // than retrying a refresh that can never work.
  if (!props.refreshToken) throw new OAuthError('invalid_grant', { description: 'No Google refresh token. Connect again.' })
  const tokens = await googleToken(env, { grant_type: 'refresh_token', refresh_token: props.refreshToken })
  if (tokens.error === 'invalid_grant') throw new OAuthError('invalid_grant', { description: 'Google access was revoked or has expired. Connect again.' })
  if (!tokens.access_token) throw new OAuthError('temporarily_unavailable', { description: 'Google did not refresh the token.', statusCode: 503 })
  const newProps = { ...props, ...googleSession(tokens) }
  return { newProps, accessTokenTTL: accessTokenTTL(newProps) }
}

async function googleToken(env, params) {
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }),
  })
  return res.json()
}

// A refresh does not always return a new refresh token; the spread keeps the old one then.
const googleSession = (tokens) => ({
  accessToken: tokens.access_token,
  expiresAt: Date.now() + tokens.expires_in * 1000,
  ...(tokens.refresh_token && { refreshToken: tokens.refresh_token }),
})

// The id_token came straight from Google's token endpoint over TLS, which OpenID Connect
// accepts in place of checking its signature.
function subject(idToken) {
  const payload = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(atob(payload)).sub
}

const callbackUrl = (request) => new URL('/callback', request.url).href
