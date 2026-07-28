import { describe, expect, it } from 'vitest'
import {
  chatTurnRequestInit,
  type ChatReasoningEffort,
} from '../../src/chat-routes/wire'

const EFFORTS = [
  'auto',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'ultracode',
] as const satisfies readonly ChatReasoningEffort[]

describe('chat turn reasoning effort wire contract', () => {
  it.each(EFFORTS)('serializes the canonical %s level unchanged', (effort) => {
    const request = chatTurnRequestInit({
      threadId: 'thread-1',
      content: 'Analyze this opportunity',
      effort,
    })

    expect(JSON.parse(String(request.body))).toMatchObject({ effort })
  })
})
