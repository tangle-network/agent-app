import { test, expect } from 'vitest'
import { groupConversationMessages } from '../../src/web/message-groups.js'
const assistant = (id: string, extra = {}) => ({ id, kind: 'message', role: 'assistant', content: id, ...extra })
function at<T>(rows: readonly T[], index: number): T {
  const value = rows[index]
  if (value === undefined) throw new Error(`Expected row ${index}`)
  return value
}

test('Successive updates retain one attribution until a real user message', () => {
  const r = groupConversationMessages([assistant('a'), assistant('b'), { id: 'u', role: 'user' }, assistant('c')])
  expect(r.map(x => x.isContinuation)).toEqual([false, true, false, false])
  expect(at(r, 0).groupId).toBe(at(r, 1).groupId)
  expect(at(r, 1).groupId).not.toBe(at(r, 3).groupId)
})
test('Tool and notice rows do not restart assistant attribution', () => {
  const r = groupConversationMessages([assistant('a'), { id: 't', kind: 'tool' }, { id: 'n', role: 'notice' }, assistant('b')])
  expect(at(r, 3).isContinuation).toBe(true)
  expect(Object.hasOwn(at(r, 1), 'isContinuation')).toBe(false)
})
test('A working/streaming continuation shares the preceding assistant group', () => {
  const r = groupConversationMessages([assistant('a'), { id: 'w', kind: 'thinking' }, assistant('stream', { isStreaming: true })])
  expect(r.slice(1).every(x => x.isContinuation)).toBe(true)
  expect(at(r, 2).groupId).toBe('a')
})
test('The first visible message is labeled after history pagination', () => {
  const r = groupConversationMessages([assistant('later'), assistant('latest')])
  expect(at(r, 0).isContinuation).toBe(false)
})
test('Distinct agents cannot inherit each other’s attribution', () => {
  const r = groupConversationMessages([assistant('a', { speakerId: 'researcher' }), assistant('b', { speakerId: 'buyer' }), assistant('c', { speakerId: 'buyer' })])
  expect(r.map(x => x.isContinuation)).toEqual([false, false, true])
})
test('Distinct conversations reset grouping even without a user row', () => {
  const r = groupConversationMessages([assistant('a', { conversationId: 'one' }), assistant('b', { conversationId: 'two' })])
  expect(at(r, 1).isContinuation).toBe(false)
})
test('A non-message tool role cannot impersonate a user and reset the group', () => {
  const r = groupConversationMessages([assistant('a'), { id: 't', kind: 'tool', role: 'user' }, assistant('b')])
  expect(at(r, 2).isContinuation).toBe(true)
})
test('Stored objects, text, timestamps and identities are not merged or mutated', () => {
  const input = Object.freeze([Object.freeze(assistant('a', { createdAt: 'yesterday' })), Object.freeze(assistant('b'))])
  const before = JSON.stringify(input), r = groupConversationMessages(input)
  expect(JSON.stringify(input)).toBe(before)
  expect(r).toHaveLength(2)
  expect(at(r, 0)).toMatchObject({ id: 'a', content: 'a', createdAt: 'yesterday' })
  expect(at(r, 1).id).toBe('b')
})
test('Empty input and missing IDs are supported without persistent global state', () => {
  expect(groupConversationMessages()).toEqual([])
  expect(at(groupConversationMessages([{ role: 'assistant' }]), 0).groupId).toBe('assistant-0')
  expect(at(groupConversationMessages([assistant('again')]), 0).isContinuation).toBe(false)
})
