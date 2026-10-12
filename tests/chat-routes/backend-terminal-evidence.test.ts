import { describe, expect, it } from 'vitest'
import { createSandboxChatProducer } from '../../src/chat-routes/sandbox-producer'

describe('backend terminal evidence', () => {
  it.each(['result', 'done'])('recognizes an actual %s event', async type => {
    const producer = createSandboxChatProducer({ events: (async function* () { yield { type, data: { finalText: 'Complete' } } })() })
    expect(producer.terminalObserved?.()).toBe(false)
    for await (const _ of producer.stream) { /* drain */ }
    expect(producer.terminalObserved?.()).toBe(true)
  })
  it.each([false, true])('does not promote observation failure to backend completion (partial=%s)', async partial => {
    const producer = createSandboxChatProducer({ errorNotice: true, events: (async function* () {
      if (partial) yield { type: 'message.part.updated', data: { part: { type: 'text', id: 'partial', text: 'Still working' }, delta: 'Still working' } }
      throw new Error('Detached replay transport vanished; backend still running')
    })() })
    for await (const _ of producer.stream) { /* drain the explicit observation error */ }
    expect(producer.terminalObserved?.()).toBe(false)
  })
  it('retains actual backend completion when later observation fails', async () => {
    const producer = createSandboxChatProducer({ errorNotice: true, events: (async function* () { yield { type: 'result', data: { finalText: 'Complete' } }; throw new Error('Transport closed after result') })() })
    for await (const _ of producer.stream) { /* drain */ }
    expect(producer.terminalObserved?.()).toBe(true)
  })
  it('does not treat a clean observation EOF as a backend terminal event', async () => {
    const producer = createSandboxChatProducer({ events: (async function* () {})() })
    for await (const _ of producer.stream) { /* drain */ }
    expect(producer.terminalObserved?.()).toBe(false)
  })
})
