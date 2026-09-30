import { describe, expect, expectTypeOf, it } from 'vitest'
import { messageHasTurnId, resolveChatTurn, type PersistedChatMessageForTurn, type ResolvedChatTurn } from './turn-identity'

interface TypedTextPart { readonly type: 'text'; readonly text: string; readonly turnId?: string }
interface TypedMessage {
  readonly id: string; readonly role: 'user' | 'assistant'; readonly content: string
  readonly parts: readonly TypedTextPart[] | null
  readonly productField: { campaign: string }
}
const user = (id: string, turnId: string): TypedMessage => Object.freeze({
  id, role: 'user' as const, content: 'Same text',
  parts: Object.freeze([Object.freeze({ type: 'text' as const, text: 'Same text', turnId })]),
  productField: { campaign: 'launch' },
})
const first = user('first', 'turn-1')
const second = user('second', 'turn-2')
const history = Object.freeze([first, second])

describe('turn resolution consumes typed readonly stores without record copies', () => {
  it('accepts typed parts and retains product fields without type assertions', () => {
    expect(messageHasTurnId(first, 'turn-1')).toBe(true)
    const result = resolveChatTurn({ existingMessages: history, userContent: 'Same text', turnId: 'turn-2' })
    expectTypeOf(result).toEqualTypeOf<ResolvedChatTurn<TypedMessage>>()
    const prior = result.priorMessages[0]
    if (!prior) throw new Error('Expected the preceding user message')
    expectTypeOf(prior.productField.campaign).toEqualTypeOf<string>()
    expect(result.turnIndex).toBe(1)
    expect(result.priorMessages).toEqual([first])
    expect(result.priorMessages[0]).toBe(first)
    expect(prior.parts).toBe(first.parts)
  })
  it('never exposes the input array as a mutable output on a new turn', () => {
    const result = resolveChatTurn({ existingMessages: history, userContent: 'Same text', turnId: 'turn-3' })
    expect(result.shouldInsertUserMessage).toBe(true)
    expect(result.turnIndex).toBe(2)
    expect(result.priorMessages).not.toBe(history)
    result.priorMessages.pop()
    expect(history).toHaveLength(2)
    expect(result.priorMessages[0]).toBe(first)
  })
  it('still reuses only the explicitly identified turn for identical content', () => {
    expect(resolveChatTurn({ existingMessages: history, userContent: 'Same text', turnId: 'turn-1' }))
      .toMatchObject({ reusedUserMessageId: 'first', turnIndex: 0, shouldInsertUserMessage: false })
  })
  it('retains the existing completed-versus-running fallback semantics', () => {
    const rows = Object.freeze([first, Object.freeze({ ...first, id: 'assistant', role: 'assistant' as const, content: 'Working' })])
    expect(resolveChatTurn({ existingMessages: rows, userContent: 'Same text' }).shouldInsertUserMessage).toBe(true)
    expect(resolveChatTurn({ existingMessages: rows, userContent: 'Same text', hasRunningTurn: true }).reusedUserMessageId).toBe('first')
  })
  it('handles missing identity metadata without fabricating a match', () => {
    expect(messageHasTurnId({ parts: [{ type: 'text', text: 'No turn ID' }] }, 'turn-1')).toBe(false)
    expect(messageHasTurnId({ parts: null }, 'turn-1')).toBe(false)
  })
  it('preserves the writable public message fields while accepting readonly input', () => {
    const message: PersistedChatMessageForTurn = { id: 'draft', role: 'user', content: '', parts: [] }
    message.id = 'saved'
    message.role = 'assistant'
    message.content = 'The saved reply'
    message.parts = [{ type: 'text', text: message.content }]
    expect(message).toEqual({ id: 'saved', role: 'assistant', content: 'The saved reply', parts: [{ type: 'text', text: 'The saved reply' }] })
    const result = resolveChatTurn({ existingMessages: Object.freeze([message]), userContent: 'Next question' })
    result.priorMessages[0]!.content = 'Updated reply'
    expect(message.content).toBe('Updated reply')
  })
})
