import { createContext, useContext, type ReactNode } from 'react'
import type { ChannelsClient, ChannelsReadClient } from './types'

const Context = createContext<{ client: ChannelsReadClient; pollInterval: number | false } | null>(null)

/** Mount below authentication. Changing scope remounts all channel state. */
export function ChannelsProvider({ client, pollInterval = 3000, children }: {
  client: ChannelsReadClient
  /** Poll after a read settles, never concurrently. false disables polling. */
  pollInterval?: number | false
  children: ReactNode
}) {
  if (pollInterval !== false && (!Number.isFinite(pollInterval) || pollInterval < 100)) {
    throw new Error('ChannelsProvider pollInterval must be false or at least 100 ms.')
  }
  return <Context.Provider value={{ client, pollInterval }} key={client.scope}>{children}</Context.Provider>
}

/** Management hooks keep the existing full-client contract; read views never call this. */
export function useChannelsClient(): ChannelsClient {
  const { client } = useChannelsContext()
  if (!('setup' in client) || !client.setup || !('fromConnection' in client.lines) || typeof client.lines.fromConnection !== 'function') {
    throw new Error('Channel setup requires a management client.')
  }
  return client as ChannelsClient
}

export function useChannelsContext() {
  const value = useContext(Context)
  if (!value) throw new Error('Channel components and hooks require ChannelsProvider.')
  return value
}
