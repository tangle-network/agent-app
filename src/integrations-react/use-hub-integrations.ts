import type { HubApiKeyConnectionMetadata, HubConnection, HubPolicyDecision, HubProvider } from '@tangle-network/hub-sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { confirmWrite, useAsyncResource, useConfirmedMutation } from '../web-react/async'
import type { HubIntegrationsClient, HubIntegrationsIdentity } from './client'
import { connectWithPopup, type PopupConnectResult } from './popup'
import { ACTION_LIMIT, catalogRows, contextKey, permissionDetails, type HubIntegrationCapabilities } from './projection'

type Selection = { scope: string; providerId: string | null; connectionId: string | null }
type Dialog = { scope: string; kind: 'api-key' | 'oauth'; provider: HubProvider } | null

export interface UseHubIntegrationsOptions {
  identity: HubIntegrationsIdentity
  client: HubIntegrationsClient
  /** Display only. The host server must authorize every exact operation. */
  can: HubIntegrationCapabilities
  /** Local app route that renders `HubConnectCallbackPage`. */
  callbackPath: string
  /** Optional host handler for custom/native signup. No Platform redirect is assumed. */
  onUnsupportedConnect?: (provider: HubProvider) => void
}

type WriteInput =
  | { kind: 'api-key'; identity: HubIntegrationsIdentity; scope: string; providerId: string; apiKey: string; metadata?: HubApiKeyConnectionMetadata }
  | { kind: 'revoke'; identity: HubIntegrationsIdentity; scope: string; connectionId: string }
  | { kind: 'health'; identity: HubIntegrationsIdentity; scope: string; connectionId: string }
  | { kind: 'set'; identity: HubIntegrationsIdentity; scope: string; connectionId: string; actionPath: string; decision: HubPolicyDecision }
  | { kind: 'reset'; identity: HubIntegrationsIdentity; scope: string; connectionId: string; actionPath: string }

export interface HubWriteReceipt {
  scope: string
  kind: WriteInput['kind']
  reconciliation: 'verified' | 'refresh-failed'
  message: string
}

function initialSelection(scope: string): Selection {
  if (typeof window === 'undefined') return { scope, providerId: null, connectionId: null }
  const query = new URL(window.location.href).searchParams
  return { scope, providerId: query.get('integration'), connectionId: query.get('connection') }
}

function updateUrl(providerId: string | null, connectionId: string | null): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (providerId) url.searchParams.set('integration', providerId)
  else url.searchParams.delete('integration')
  if (connectionId) url.searchParams.set('connection', connectionId)
  else url.searchParams.delete('connection')
  window.history.pushState(window.history.state, '', url)
}

/** Identity-bound Hub settings controller; connection state is always server-read. */
export function useHubIntegrations({ identity, client, can, callbackPath, onUnsupportedConnect }: UseHubIntegrationsOptions) {
  const scope = contextKey(identity)
  const activeScope = useRef(scope)
  activeScope.current = scope
  const [selection, setSelection] = useState<Selection>(() => initialSelection(scope))
  const visibleSelection = selection.scope === scope ? selection : { scope, providerId: null, connectionId: null }
  const [dialog, setDialog] = useState<Dialog>(null)
  const visibleDialog = dialog?.scope === scope ? dialog : null
  const [connectStatus, setConnectStatus] = useState<{ scope: string; status: 'idle' | 'pending' | 'connected' | 'failed'; providerId?: string; message?: string }>({ scope, status: 'idle' })
  const [writeScope, setWriteScope] = useState(scope)
  const pendingPopup = useRef<AbortController | null>(null)

  useEffect(() => {
    const onPop = () => setSelection(initialSelection(scope))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [scope])

  const providers = useAsyncResource({ load: ({ signal }) => client.providers(identity, signal), deps: [client, scope], isEmpty: () => false })
  const connections = useAsyncResource({ load: ({ signal }) => client.connections(identity, signal), deps: [client, scope], isEmpty: () => false })
  const providerList = providers.status === 'ready' ? providers.value : []
  const connectionList = connections.status === 'ready' ? connections.value : []
  const provider = providerList.find(item => item.providerId === visibleSelection.providerId) ?? null
  const connection = connectionList.find(item => item.id === visibleSelection.connectionId && item.providerId === provider?.providerId) ?? null
  const canReadPolicies = connection !== null && can({ operation: 'policies.list', connectionId: connection.id })
  const detail = useAsyncResource({
    enabled: canReadPolicies && connection?.status === 'active',
    deps: [client, scope, provider?.providerId, connection?.id, canReadPolicies],
    isEmpty: () => false,
    load: async ({ signal }) => {
      if (!provider || !connection) throw new Error('Choose a connection.')
      const [tools, policies] = await Promise.all([
        client.actions(identity, provider.providerId, ACTION_LIMIT, signal),
        client.policies(identity, connection.id, signal),
      ])
      if (tools.some(tool => !tool.path.startsWith(`${provider.providerId}.`)) || policies.some(policy => policy.connectionId !== connection.id)) {
        throw new Error('Hub settings response changed connection or provider.')
      }
      return { tools, policies, truncated: tools.length >= ACTION_LIMIT }
    },
  })

  const write = useConfirmedMutation<WriteInput, HubWriteReceipt>({
    concurrency: 'reject',
    mutate: async (input, { signal }) => {
      if (input.scope !== activeScope.current) throw new Error('Integration context changed. Retry in the current workspace.')
      const origin = input.identity
      const receipt = (reconciliation: HubWriteReceipt['reconciliation'], message: string) => confirmWrite<HubWriteReceipt>({ scope: input.scope, kind: input.kind, reconciliation, message })
      if (input.kind === 'api-key') {
        if (!can({ operation: 'api-key.connect', providerId: input.providerId })) throw new Error('Connection setup is unavailable.')
        const created = await client.connectApiKey(origin, input.providerId, input.apiKey, input.metadata, signal)
        if (created.providerId !== input.providerId || created.status !== 'active') throw new Error('Hub did not confirm the requested connection.')
        try {
          const current = await client.connections(origin, signal)
          return current.some(item => item.id === created.id && item.status === 'active')
            ? receipt('verified', 'Connection saved and verified.') : receipt('refresh-failed', 'Connection saved; current account state could not be confirmed.')
        } catch { return receipt('refresh-failed', 'Connection saved; refresh failed.') }
      }
      if (input.kind === 'revoke') {
        if (!can({ operation: 'connection.revoke', connectionId: input.connectionId })) throw new Error('Disconnect is unavailable.')
        await client.revoke(origin, input.connectionId, signal)
        try {
          const current = await client.connections(origin, signal)
          return current.some(item => item.id === input.connectionId && item.status === 'active')
            ? receipt('refresh-failed', 'Disconnected, but the current account state disagrees.') : receipt('verified', 'Connection disconnected and verified.')
        } catch { return receipt('refresh-failed', 'Disconnected; refresh failed.') }
      }
      if (input.kind === 'health') {
        if (!can({ operation: 'connection.health', connectionId: input.connectionId })) throw new Error('Connection test is unavailable.')
        const result = await client.health(origin, input.connectionId, signal)
        if (result.connection.id !== input.connectionId) throw new Error('Hub returned another connection.')
        return receipt('verified', `Connection test: ${result.health.status.replaceAll('_', ' ')}.`)
      }
      if (!can({ operation: input.kind === 'set' ? 'policy.set' : 'policy.reset', connectionId: input.connectionId, actionPath: input.actionPath })) {
        throw new Error('Permission editing is unavailable.')
      }
      if (input.kind === 'set') {
        const stored = await client.setPolicy(origin, input.connectionId, input.actionPath, input.decision, signal)
        if (stored.connectionId !== input.connectionId || stored.actionPath !== input.actionPath || stored.decision !== input.decision) {
          throw new Error('Hub did not confirm the requested permission.')
        }
      } else await client.resetPolicy(origin, input.connectionId, input.actionPath, signal)
      try {
        const current = await client.policies(origin, input.connectionId, signal)
        const override = current.find(policy => policy.actionPath === input.actionPath)
        const matches = input.kind === 'set' ? override?.decision === input.decision : override === undefined
        return matches
          ? receipt('verified', 'Permission saved and verified.') : receipt('refresh-failed', 'Permission write was accepted; current policy state disagrees.')
      } catch { return receipt('refresh-failed', 'Permission write was accepted; refresh failed.') }
    },
    onSucceeded: value => { if (value.scope === activeScope.current) { connections.retry(); detail.retry() } },
  })

  useEffect(() => {
    pendingPopup.current?.abort()
    pendingPopup.current = null
    setDialog(null)
    setConnectStatus({ scope, status: 'idle' })
    setWriteScope(scope)
    write.reset()
    return () => { pendingPopup.current?.abort(); pendingPopup.current = null }
  }, [scope, client, write.reset])

  const selectProvider = useCallback((providerId: string | null) => {
    const next = { scope, providerId, connectionId: null }
    setSelection(next)
    updateUrl(providerId, null)
  }, [scope])

  const selectConnection = useCallback((providerId: string, connectionId: string | null) => {
    if (connectionId && !connectionList.some(item => item.id === connectionId && item.providerId === providerId)) return
    setSelection({ scope, providerId, connectionId })
    updateUrl(providerId, connectionId)
  }, [scope, connectionList])

  const startOAuth = useCallback(async (target: HubProvider, connectionParameters?: Record<string, string>): Promise<PopupConnectResult> => {
    if (!can({ operation: 'oauth.start', providerId: target.providerId })) return 'unavailable'
    if (connections.status !== 'ready') { setConnectStatus({ scope, status: 'failed', message: 'Load connections before connecting.' }); return 'unavailable' }
    pendingPopup.current?.abort()
    const controller = new AbortController()
    pendingPopup.current = controller
    setConnectStatus({ scope, status: 'pending', providerId: target.providerId })
    const result = await connectWithPopup({
      client, identity, providerId: target.providerId, before: connections.value,
      callbackPath, connectionParameters, signal: controller.signal,
      isCurrent: () => activeScope.current === scope && !controller.signal.aborted,
    })
    if (pendingPopup.current !== controller || activeScope.current !== scope) return result
    pendingPopup.current = null
    if (result === 'connected') {
      connections.retry()
      setDialog(null)
      setConnectStatus({ scope, status: 'connected', message: 'Connection verified.' })
    } else setConnectStatus({ scope, status: 'failed', message: result === 'blocked' ? 'Allow the popup and try again.' : result === 'unverified' ? 'Could not verify a new connection. Refresh and try again.' : result === 'cancelled' ? 'Connection was cancelled.' : 'This connection flow is unavailable.' })
    return result
  }, [can, connections, client, identity, callbackPath, scope])

  const beginConnect = useCallback((target: HubProvider) => {
    if (target.authKind !== 'api_key' && target.authKind !== 'oauth2') {
      if (onUnsupportedConnect) onUnsupportedConnect(target)
      else setConnectStatus({ scope, status: 'failed', message: 'This provider needs an app-specific connection flow.' })
      return
    }
    if (!target.configured) {
      setConnectStatus({ scope, status: 'failed', message: 'This provider is not configured for connection.' })
      return
    }
    if (target.authKind === 'api_key') {
      if (can({ operation: 'api-key.connect', providerId: target.providerId })) setDialog({ scope, kind: 'api-key', provider: target })
      else setConnectStatus({ scope, status: 'failed', message: 'Connection setup is unavailable.' })
      return
    }
    if (target.authKind === 'oauth2') {
      if (!can({ operation: 'oauth.start', providerId: target.providerId })) {
        setConnectStatus({ scope, status: 'failed', message: 'Connection setup is unavailable.' }); return
      }
      if (target.connectionParameters?.length) setDialog({ scope, kind: 'oauth', provider: target })
      else void startOAuth(target)
      return
    }
  }, [can, onUnsupportedConnect, scope, startOAuth])

  const cancelConnect = useCallback(() => {
    pendingPopup.current?.abort()
    pendingPopup.current = null
    setDialog(null)
    setConnectStatus({ scope, status: 'failed', message: 'Connection was cancelled.' })
  }, [scope])

  const rows = useMemo(() => catalogRows(providerList, connectionList, visibleSelection.providerId && visibleSelection.connectionId
    ? { [visibleSelection.providerId]: visibleSelection.connectionId } : {}, can, !!onUnsupportedConnect),
  [providerList, connectionList, visibleSelection.providerId, visibleSelection.connectionId, can, onUnsupportedConnect])
  const details = detail.status === 'ready' && connection
    ? permissionDetails(detail.value.tools, detail.value.policies, connection.id, can) : undefined

  return {
    providers, connections, detail, rows, provider, connection, dialog: visibleDialog, setDialog,
    connectStatus: connectStatus.scope === scope ? connectStatus : { scope, status: 'idle' as const, providerId: undefined },
    selection: visibleSelection, selectProvider, selectConnection, beginConnect, startOAuth, cancelConnect,
    write, writeState: writeScope === scope ? write.state : { status: 'idle' as const }, details,
    refresh: () => { providers.retry(); connections.retry(); detail.retry() },
    submitApiKey: (providerId: string, apiKey: string, metadata?: HubApiKeyConnectionMetadata) => { setWriteScope(scope); return write.run({ kind: 'api-key', identity, scope, providerId, apiKey, metadata }) },
    revoke: (connectionId: string) => { setWriteScope(scope); return write.run({ kind: 'revoke', identity, scope, connectionId }) },
    test: (connectionId: string) => { setWriteScope(scope); return write.run({ kind: 'health', identity, scope, connectionId }) },
    setDecision: (connectionId: string, actionPath: string, decision: HubPolicyDecision) => { setWriteScope(scope); return write.run({ kind: 'set', identity, scope, connectionId, actionPath, decision }) },
    resetDecision: (connectionId: string, actionPath: string) => { setWriteScope(scope); return write.run({ kind: 'reset', identity, scope, connectionId, actionPath }) },
  }
}
