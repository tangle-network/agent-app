import { test } from 'vitest'
import assert from 'node:assert/strict'
import { groupConversationMessages } from '../../src/web/message-groups.js'
const assistant = (id: string, extra = {}) => ({ id, kind: 'message', role: 'assistant', content: id, ...extra })
function at<T>(rows: readonly T[], index: number) {
  const value = rows[index]
  assert(value !== undefined, `Expected row ${index}`)
  return value
}

test('Successive updates retain one attribution until a real user message', () => {
  const r = groupConversationMessages([assistant('a'), assistant('b'), { id: 'u', role: 'user' }, assistant('c')])
  assert.deepEqual(r.map(x => x.isContinuation), [false, true, false, false]); assert.equal(at(r, 0).groupId, at(r, 1).groupId); assert.notEqual(at(r, 1).groupId, at(r, 3).groupId)
})
test('Tool and notice rows do not restart assistant attribution', () => {
  const r = groupConversationMessages([assistant('a'), { id: 't', kind: 'tool' }, { id: 'n', role: 'notice' }, assistant('b')])
  assert.equal(at(r, 3).isContinuation, true); assert(!Object.hasOwn(at(r, 1), 'isContinuation'))
})
test('A working/streaming continuation shares the preceding assistant group', () => {
  const r = groupConversationMessages([assistant('a'), { id: 'w', kind: 'thinking' }, assistant('stream', { isStreaming: true })])
  assert(r.slice(1).every(x => x.isContinuation)); assert.equal(at(r, 2).groupId, 'a')
})
test('The first visible message is labeled after history pagination', () => {
  const r = groupConversationMessages([assistant('later'), assistant('latest')]); assert.equal(at(r, 0).isContinuation, false)
})
test('Distinct agents cannot inherit each other’s attribution', () => {
  const r = groupConversationMessages([assistant('a', { speakerId: 'researcher' }), assistant('b', { speakerId: 'buyer' }), assistant('c', { speakerId: 'buyer' })])
  assert.deepEqual(r.map(x => x.isContinuation), [false, false, true])
})
test('Distinct conversations reset grouping even without a user row', () => {
  const r = groupConversationMessages([assistant('a', { conversationId: 'one' }), assistant('b', { conversationId: 'two' })])
  assert.equal(at(r, 1).isContinuation, false)
})
test('A non-message tool role cannot impersonate a user and reset the group', () => {
  const r = groupConversationMessages([assistant('a'), { id: 't', kind: 'tool', role: 'user' }, assistant('b')]); assert.equal(at(r, 2).isContinuation, true)
})
test('Stored objects, text, timestamps and identities are not merged or mutated', () => {
  const input = Object.freeze([Object.freeze(assistant('a', { createdAt: 'yesterday' })), Object.freeze(assistant('b'))])
  const before = JSON.stringify(input), r = groupConversationMessages(input), first = at(r, 0)
  assert.equal(JSON.stringify(input), before); assert.equal(r.length, 2); assert.equal(first.content, 'a'); assert.equal(at(r, 1).id, 'b'); assert('createdAt' in first); assert.equal(first.createdAt, 'yesterday')
})
test('Empty input and missing IDs are supported without persistent global state', () => {
  assert.deepEqual(groupConversationMessages(), [])
  assert.equal(at(groupConversationMessages([{ role: 'assistant' }]), 0).groupId, 'assistant-0')
  assert.equal(at(groupConversationMessages([assistant('again')]), 0).isContinuation, false)
})
