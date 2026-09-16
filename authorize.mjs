#!/usr/bin/env node
import { getAuth, TOKEN_PATH, CREDS_PATH, SCOPES } from './auth.mjs'
console.log(`credentials: ${CREDS_PATH}`)
console.log(`token cache: ${TOKEN_PATH}`)
console.log(`scopes     : ${SCOPES.join('\n             ')}\n`)
const auth = await getAuth()
const { token } = await auth.getAccessToken()
console.log(token ? '\n✅ Authorised. Token cached — restart Claude Code and the gdocs tools will work.'
                  : '\n❌ No access token returned.')
process.exit(token ? 0 : 1)
