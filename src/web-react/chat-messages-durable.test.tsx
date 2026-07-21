// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChatMessages } from './index'

afterEach(cleanup)

describe('ChatMessages durable cards', () => {
  it('renders persisted plan and question parts without a product transcript switch', () => {
    render(
      <ChatMessages
        messages={[{
          id: 'assistant-1',
          role: 'assistant',
          content: 'I need two decisions.',
          parts: [
            {
              type: 'plan', planId: 'plan-1', revision: 1, body: 'Research first',
              submittedAt: '2026-07-21T00:00:00.000Z', status: 'pending',
            },
            {
              type: 'interaction', id: 'ask-1', kind: 'question', title: 'Which tone?',
              answerSpec: { fields: [{ type: 'text', name: 'tone', label: 'Tone', required: true }] },
              status: 'pending',
            },
          ],
        }]}
        durableCards={{
          canWrite: true,
          submitInteraction: vi.fn(async () => ({ ok: true as const })),
          decidePlan: vi.fn(async () => null),
        }}
      />,
    )
    expect(screen.getByText('Plan decision')).toBeTruthy()
    expect(screen.getByText('Which tone?')).toBeTruthy()
  })
})
