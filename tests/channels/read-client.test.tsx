// @vitest-environment jsdom
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { describe, expect, it } from 'vitest'
import { ChannelConversation, ChannelsProvider, useChannelConversations, useChannelsClient } from '../../src/channels'
import type { ChannelsReadClient } from '../../src/channels'
import { channelMessage, createChannelsFixture } from '../../src/stories/fixtures/channels'

function readClient() {
  const fixture = createChannelsFixture()
  const client: ChannelsReadClient = {
    scope: fixture.client.scope,
    lines: {
      list: fixture.client.lines.list,
      get: fixture.client.lines.get,
      threads: fixture.client.lines.threads,
    },
  }
  const wrapper = ({ children }: PropsWithChildren) => <ChannelsProvider client={client} pollInterval={false}>{children}</ChannelsProvider>
  return { ...fixture, client, wrapper }
}

describe('read-only channel capabilities', () => {
  it('renders the existing conversation with only read methods', async () => {
    const fixture = readClient()
    fixture.state.messages = [channelMessage('read-only', { text: 'A recorded reply', direction: 'out' })]
    render(<ChannelConversation lineId="ln_demo" threadId="thread_demo" />, { wrapper: fixture.wrapper })
    expect(await screen.findByText('A recorded reply')).toBeTruthy()
    expect(Object.keys(fixture.client).sort()).toEqual(['lines', 'scope'])
    expect(Object.keys(fixture.client.lines).sort()).toEqual(['get', 'list', 'threads'])
  })

  it('refuses management hooks without a management client', () => {
    const fixture = readClient()
    expect(() => renderHook(() => useChannelsClient(), { wrapper: fixture.wrapper })).toThrow('Channel setup requires a management client.')
  })

  it('keeps full management clients compatible', () => {
    const fixture = createChannelsFixture()
    const wrapper = ({ children }: PropsWithChildren) => <ChannelsProvider client={fixture.client} pollInterval={false}>{children}</ChannelsProvider>
    const { result } = renderHook(() => useChannelsClient(), { wrapper })
    expect(result.current).toBe(fixture.client)
  })

  it('discards a late conversation read after switching read-only scope', async () => {
    const first = readClient()
    const second = readClient()
    second.client.scope = 'agent:second-read-only'
    let resolve!: (threads: Array<typeof first.thread>) => void
    const pending = new Promise<Array<typeof first.thread>>(done => { resolve = done })
    first.client.lines.threads = () => ({ list: () => pending, messages: async () => [] })
    const fresh = { ...second.thread, id: 'thread_second' }
    second.client.lines.threads = () => ({ list: async () => [fresh], messages: async () => [] })
    let client = first.client
    const wrapper = ({ children }: PropsWithChildren) => <ChannelsProvider client={client} pollInterval={false}>{children}</ChannelsProvider>
    const { result, rerender } = renderHook(() => useChannelConversations('ln_demo'), { wrapper })
    client = second.client
    rerender()
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', value: [{ id: 'thread_second' }] }))
    await act(async () => { resolve([first.thread]) })
    expect(result.current).toMatchObject({ status: 'ready', value: [{ id: 'thread_second' }] })
  })
})
