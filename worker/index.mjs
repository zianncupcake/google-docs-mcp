import { DurableObject } from 'cloudflare:workers'
import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import { createMcpHandler } from 'agents/mcp/server'
import { Server } from '@modelcontextprotocol/server'
import { TOOLS, createCallTool } from '../tools.mjs'
import googleSignIn, { tokenExchangeCallback } from './google-auth.mjs'
import { googleDocs } from './google-api.mjs'
import { BaselineStore, userBaseline } from './baselines.mjs'

// props are what google-auth.mjs stored for the user this request's token belongs to.
function mcpServer(env, props) {
  const callTool = createCallTool({ google: googleDocs(props.accessToken), baseline: userBaseline(env.BASELINES, props.userId) })
  const server = new Server({ name: 'google-docs-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', () => ({ tools: TOOLS }))
  server.setRequestHandler('tools/call', (request) => callTool(request.params.name, request.params.arguments))
  return server
}

// One per signed-in user. It extends DurableObject so the Worker can call its methods.
export class Baselines extends DurableObject {
  #store = new BaselineStore(this.ctx.storage)
  load(key) { return this.#store.load(key) }
  save(key, snapshot) { return this.#store.save(key, snapshot) }
  alarm() { return this.#store.alarm() }
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
