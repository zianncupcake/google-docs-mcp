import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kvBaseline } from '../baseline-kv.mjs'
import { MemoryKV } from './memory-kv.mjs'

test('one user cannot load another user\'s snapshot', async () => {
  const kv = new MemoryKV()
  await kvBaseline(kv, 'alice').save('doc1', { revisionId: 'r1', text: 'alice text' })

  assert.equal((await kvBaseline(kv, 'alice').load('doc1')).text, 'alice text')
  assert.equal(await kvBaseline(kv, 'bob').load('doc1'), null)

  // A document key carrying the separator cannot reach into a user id that contains it.
  await kvBaseline(kv, 'a').save('b:doc1', { revisionId: 'r1', text: 'a text' })
  assert.equal(await kvBaseline(kv, 'a:b').load('doc1'), null)
})
