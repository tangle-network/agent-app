import { useCallback, useEffect, useRef } from 'react'
import { confirmWrite, rejectWrite, useAsyncResource, useConfirmedMutation } from '../web-react/async'
import type { AsyncLoadContext, AsyncResourceState, MutationOutcome } from '../web-react/async'
import { useChannelsContext } from './context'
import type { ChannelVerification, ConnectChannelInput, Line, LineTransport } from './types'

/** Reuse the kit's abort/sequence-aware read machine; polling never overlaps a read. */
export function useChannelResource<T>(load: (context: AsyncLoadContext) => Promise<T>, deps: readonly unknown[], enabled = true, poll = true): AsyncResourceState<T> {
  const { client, pollInterval } = useChannelsContext()
  const resource = useAsyncResource({ load, deps: [client, client.scope, ...deps], enabled })
  useEffect(() => {
    if (!enabled || !poll || pollInterval === false || resource.status === 'loading' || resource.status === 'idle') return
    const delay = typeof document !== 'undefined' && document.hidden ? Math.max(15000, pollInterval) : pollInterval
    const timer = setTimeout(resource.retry, delay)
    return () => clearTimeout(timer)
  }, [enabled, poll, pollInterval, resource.status, resource.retry, resource])
  return enabled ? resource : { status: 'idle', retry: resource.retry }
}

/** Single-flight on top of the shared confirmed-write primitive. */
export function useChannelMutation<I, O>(mutate: (input: I, context: AsyncLoadContext) => Promise<O>, onSucceeded?: (value: O) => void) {
  const { client } = useChannelsContext()
  const lock = useRef<object | null>(null)
  const mutation = useConfirmedMutation<I, O>({
    mutate: async (input, context) => confirmWrite(await mutate(input, context)),
    onSucceeded,
  })
  const { reset, run } = mutation
  useEffect(() => {
    reset()
    return () => { lock.current = null; reset() }
  }, [client, client.scope, reset])
  const singleRun = useCallback(async (input: I): Promise<MutationOutcome<O>> => {
    if (lock.current) return rejectWrite('Another channel operation is still in progress.')
    const token = {}
    lock.current = token
    try { return await run(input) }
    finally { if (lock.current === token) lock.current = null }
  }, [run])
  return { ...mutation, run: singleRun }
}

export function useChannels() {
  const { client } = useChannelsContext()
  return useChannelResource(() => client.lines.list(), [])
}

export function useChannelConnections(transport: LineTransport) {
  const { client } = useChannelsContext()
  return useChannelResource(context => client.setup.connections(transport, context), [transport], true, false)
}

export function useWhatsAppNumbers(connectionId: string) {
  const { client } = useChannelsContext()
  return useChannelResource(context => client.setup.whatsappNumbers(connectionId, context), [connectionId], !!connectionId, false)
}

/** Connect only acquires/binds a line. It never labels it verified or activates replies. */
export function useConnectChannel(onConnected?: (line: Line) => void) {
  const { client } = useChannelsContext()
  return useChannelMutation<ConnectChannelInput, Line>(async input => {
    if (input.kind === 'connection') {
      if (!input.input.connectionId.trim()) throw new Error('Choose a connection.')
      if (input.input.transport === 'whatsapp' && !input.input.phoneNumberId.trim()) throw new Error('Choose a WhatsApp number.')
      return client.lines.fromConnection(input.input)
    }
    if (input.kind === 'order') {
      if (!input.orderId.trim()) throw new Error('Choose a number order.')
      return client.setup.fromOrder(input.orderId)
    }
    const address = input.address.trim().toLowerCase()
    if (!input.connectionId.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error('Choose a connection and enter a valid mailbox address.')
    return client.setup.fromEmail({ connectionId: input.connectionId, address })
  }, onConnected)
}

export function verificationExpired(test: ChannelVerification, now = Date.now()): boolean {
  return test.expired || (test.status !== 'verified' && test.expiresAt <= now)
}

export type VerificationAction = 'start' | 'resume' | 'send' | 'activate' | 'reset'

export function useChannel(lineId: string) {
  const { client } = useChannelsContext()
  const resource = useChannelResource(async context => {
    const [line, verification] = await Promise.all([client.lines.get(lineId), client.setup.verification(lineId, context)])
    if (line.id !== lineId || (verification && verification.lineId !== lineId)) throw new Error('Channel binding changed. Reload channel setup.')
    return { line, verification }
  }, [lineId], !!lineId)
  const mutation = useChannelMutation<{ action: VerificationAction; confirm?: boolean }, void>(async ({ action, confirm }) => {
    if (resource.status !== 'ready') throw new Error('Read the current channel state before changing it.')
    const { line, verification: test } = resource.value
    if (line.id !== lineId) throw new Error('Channel binding changed. Reload channel setup.')
    if (action !== 'reset' && line.status !== 'active') throw new Error('This line is not active.')
    if (action === 'start') {
      if (test && test.status !== 'revoked') throw new Error('Stop the existing test before starting another.')
      await client.setup.start(lineId)
      return
    }
    if (!test || test.lineId !== lineId) throw new Error('Start a channel test first.')
    if (action === 'reset') {
      if (confirm !== true) throw new Error('Confirm stopping this test.')
      await client.setup.reset(lineId, test.id)
      return
    }
    if (verificationExpired(test)) throw new Error('This test expired. Stop it and start a new test.')
    if (action === 'activate') {
      if (test.status !== 'verified') throw new Error('Verify inbound delivery and the test reply before activation.')
      const activated = await client.setup.activate(lineId, test.id)
      if (activated.id !== lineId || activated.status !== 'active' || activated.attachment?.status !== 'active') throw new Error('Messaging activation was not confirmed.')
    } else if (action === 'send') {
      if (test.status !== 'received') throw new Error('Wait for the inbound test message before sending a reply.')
      await client.setup.send(lineId, test.id)
    } else {
      if (test.status !== 'configuring' && test.status !== 'uncertain') throw new Error('This test is not waiting for a setup check.')
      await client.setup.resume(lineId, test.id)
    }
  }, resource.retry)
  useEffect(() => mutation.reset(), [lineId, mutation.reset])
  return { resource, ...mutation }
}

export function useChannelConversations(lineId: string) {
  const { client } = useChannelsContext()
  return useChannelResource(() => client.lines.threads(lineId).list(), [lineId], !!lineId)
}

export function useChannelConversation(lineId: string, threadId: string) {
  const { client } = useChannelsContext()
  return useChannelResource(async () => {
    const messages = await client.lines.threads(lineId).messages(threadId)
    // The SDK returns newest first. Never mutate it, and never render another thread.
    if (messages.some(message => message.threadId !== threadId)) throw new Error('The message response belongs to another conversation.')
    return [...new Map(messages.map(message => [message.id, message])).values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }, [lineId, threadId], !!lineId && !!threadId)
}
