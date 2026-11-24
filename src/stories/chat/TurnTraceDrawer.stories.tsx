import type { Meta, StoryObj } from '@storybook/react'
import { ChatMessages, TurnTraceButton, TurnTraceDrawer } from '../../web-react'
import type { ChatUiMessage } from '../../web-react'
import { TAX_ROUTER_TURN_TRACE } from '../fixtures/turn-trace'

/**
 * The member's own view of a turn: the waterfall `routes.trace` serves for the receipt's `traceUrl`, from a real Tax
 * Router-lane turn (ids synthetic). The fetch seam stands in for the route so each state can be opened on its own.
 */
const answering = (status: number, body: unknown = {}): typeof fetch => async () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const TRACE_URL = '/api/sessions/00000000-0000-4000-8000-00000000c0de/chat/turns/tax-agent%3A00000000-0000-4000-8000-00000000c0de%3A0/trace'

const meta: Meta<typeof TurnTraceDrawer> = {
  title: 'Chat/Turn trace',
  component: TurnTraceDrawer,
  parameters: { layout: 'fullscreen' },
  args: { traceUrl: TRACE_URL, open: true, onOpenChange: () => {}, fetchImpl: answering(200, TAX_ROUTER_TURN_TRACE) },
}
export default meta

type Story = StoryObj<typeof TurnTraceDrawer>
/** 12.6 s in all: admission, two model calls with their network and Router time, one tool call, persistence. */
export const Ready: Story = {}
/** The turn just finished and its spans have not reached the store: the member can read again. */
export const NotStoredYet: Story = { args: { fetchImpl: answering(404, { code: 'turn_trace_not_found' }) } }
/** The trace store did not answer. */
export const Failed: Story = { args: { fetchImpl: answering(502, { code: 'turn_trace_unavailable' }) } }

const answered: ChatUiMessage[] = [
  { id: 'user-1', role: 'user', content: 'What is the 2025 standard deduction for a single filer?' },
  {
    id: 'assistant:tax-agent:00000000-0000-4000-8000-00000000c0de:0',
    role: 'assistant',
    content: 'For 2025, a single filer\'s standard deduction is **$15,750**.',
    modelUsed: 'google/gemini-3.7-flash',
  },
]

/** The action in a transcript: `renderExtras` puts a Trace button under each answer, which opens the drawer. */
export const InTranscript: StoryObj<typeof ChatMessages> = {
  render: () => (
    <ChatMessages
      messages={answered}
      renderExtras={(message) => message.role === 'assistant'
        ? <TurnTraceButton traceUrl={TRACE_URL} fetchImpl={answering(200, TAX_ROUTER_TURN_TRACE)} />
        : null}
    />
  ),
}
