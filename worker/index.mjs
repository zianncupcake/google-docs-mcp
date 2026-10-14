import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import { createMcpHandler } from 'agents/mcp/server'
import { Server } from '@modelcontextprotocol/server'
import { TOOLS, createCallTool } from '../tools.mjs'
import googleSignIn, { tokenExchangeCallback } from './google-auth.mjs'
import { googleDocs } from './google-api.mjs'
import { kvBaseline } from './baseline-kv.mjs'

// props are what google-auth.mjs stored for the user this request's token belongs to.
function mcpServer(env, props) {
  const callTool = createCallTool({ google: googleDocs(props.accessToken), baseline: kvBaseline(env.BASELINE_KV, props.userId) })
  const server = new Server({ name: 'google-docs-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', () => ({ tools: TOOLS }))
  server.setRequestHandler('tools/call', (request) => callTool(request.params.name, request.params.arguments))
  return server
}

const mcp = {
  fetch: (request, env, ctx) => createMcpHandler(() => mcpServer(env, ctx.props))(request, env, ctx),
}

export default {
  // The resource is taken from the request, so the Worker needs no setting for the name it is deployed under.
  fetch: (request, env, ctx) => new OAuthProvider({
    resourceMetadata: { resource: new URL('/mcp', request.url).href },
    apiRoute: '/mcp',
    apiHandler: mcp,
    defaultHandler: googleSignIn,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    tokenExchangeCallback,
  }).fetch(request, env, ctx),
}
