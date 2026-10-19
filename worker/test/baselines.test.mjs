import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BaselineStore, userBaseline } from '../baselines.mjs'
import { MemoryStorage } from './memory-storage.mjs'

const DAY = 24 * 60 * 60 * 1000

// Like a Durable Object namespace: one object, with its own storage, per name.
function memoryNamespace() {
  const objects = new Map()
  return {
    idFromName: (name) => name,
    get: (id) => objects.get(id) ?? objects.set(id, new BaselineStore(new MemoryStorage())).get(id),
  }
}

test('one user cannot load another user\'s snapshot', async () => {
  const ns = memoryNamespace()
  await userBaseline(ns, 'alice').save('doc1', { revisionId: 'r1', text: 'alice text' })

  assert.equal((await userBaseline(ns, 'alice').load('doc1')).text, 'alice text')
  assert.equal(await userBaseline(ns, 'bob').load('doc1'), null)

  // A document key carrying a separator cannot reach into a user id that contains it.
  await userBaseline(ns, 'a').save('b:doc1', { revisionId: 'r1', text: 'a text' })
  assert.equal(await userBaseline(ns, 'a:b').load('doc1'), null)
})

test('a load returns the latest save', async () => {
  const store = new BaselineStore(new MemoryStorage())
  await store.save('doc1', { revisionId: 'r1', text: 'old' })
  await store.save('doc1', { revisionId: 'r2', text: 'new' })
  assert.equal((await store.load('doc1')).revisionId, 'r2')
})

test('the alarm deletes a snapshot 30 days after its last save and keeps the newer ones', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 })
  const storage = new MemoryStorage()
  const store = new BaselineStore(storage)
  await store.save('old', { revisionId: 'r1', text: 'old text' })
  t.mock.timers.tick(20 * DAY)
  await store.save('new', { revisionId: 'r1', text: 'new text' })
  t.mock.timers.tick(11 * DAY)

  await store.alarm()

  assert.equal(await store.load('old'), null)
  assert.equal((await store.load('new')).text, 'new text')
  assert.equal(await storage.getAlarm(), 50 * DAY)
})
