import type { HubApiKeyConnectionMetadata, HubConnection, HubProvider } from '@tangle-network/hub-sdk'
import {
  ApiKeyConnectDialog,
  IntegrationConnectionDetail,
  IntegrationsCatalog,
  OAuthConnectionParameterDialog,
  type IntegrationDisplayAction,
  type IntegrationsCatalogProps,
  type IntegrationSort,
} from '@tangle-network/sandbox-ui/integrations'
import { Button } from '@tangle-network/ui/primitives'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { HubIntegrationsClient, HubIntegrationsIdentity } from './client'
import { contextKey, displayProvider, type HubIntegrationCapabilities } from './projection'
import { useHubIntegrations } from './use-hub-integrations'

export interface HubIntegrationsPanelProps {
  identity: HubIntegrationsIdentity
  client: HubIntegrationsClient
  can: HubIntegrationCapabilities
  callbackPath: string
  title?: string
  /** Compact, icon-led tiles or descriptive cards. Defaults to cards. */
  layout?: IntegrationsCatalogProps['layout']
  className?: string
  onRequestIntegration?: (prefill: string) => void
  onUnsupportedConnect?: (provider: HubProvider) => void
  /** Host-owned context and actions; the host authorizes and confirms their effects. */
  getConnectionContext?: (connection: HubConnection) => string | undefined
  getConnectionActions?: (connection: HubConnection) => readonly IntegrationDisplayAction[]
  /** Host-owned, transient fields for providers that require API-key metadata. */
  renderApiKeyMetadata?: (input: {
    provider: HubProvider
    value: HubApiKeyConnectionMetadata | undefined
    onChange: (value: HubApiKeyConnectionMetadata | undefined) => void
  }) => ReactNode
}

function catalogHref(): string {
  if (typeof window === 'undefined') return '/'
  const url = new URL(window.location.href)
  url.searchParams.delete('integration')
  url.searchParams.delete('connection')
  return `${url.pathname}${url.search}${url.hash}`
}

/** Embeddable settings surface. The app supplies authenticated transport and grants. */
export function HubIntegrationsPanel(props: HubIntegrationsPanelProps) {
  const hub = useHubIntegrations(props)
  const scope = contextKey(props.identity)
  const activeScope = useRef(scope)
  activeScope.current = scope
  const activeDialog = useRef(hub.dialog)
  activeDialog.current = hub.dialog
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [sort, setSort] = useState<IntegrationSort>('featured')
  const [catalogSelection, setCatalogSelection] = useState<{ scope: string; ids: Record<string, string | null> }>({ scope, ids: {} })
  const [keyInput, setKeyInput] = useState({ scope, value: '' })
  const apiKey = keyInput.scope === scope ? keyInput.value : ''
  const setApiKey = (value: string) => setKeyInput({ scope, value })
  const [metadataInput, setMetadataInput] = useState<{ scope: string; value: HubApiKeyConnectionMetadata | undefined }>({ scope, value: undefined })
  const metadata = metadataInput.scope === scope ? metadataInput.value : undefined
  const setMetadata = (value: HubApiKeyConnectionMetadata | undefined) => setMetadataInput({ scope, value })
  const [parameterInput, setParameterInput] = useState({ scope, values: {} as Record<string, string> })
  const parameters = parameterInput.scope === scope ? parameterInput.values : {}
  const setParameters = (values: Record<string, string>) => setParameterInput({ scope, values })

  useEffect(() => { setApiKey(''); setMetadata(undefined); setParameters({}) }, [scope])
  const pending = hub.writeState.status === 'pending' || hub.connectStatus.status === 'pending'
  const error = hub.providers.status === 'error' ? hub.providers.message
    : hub.connections.status === 'error' ? hub.connections.message : null
  const mutationError = hub.writeState.status === 'failed' ? hub.writeState.message : null
  const writeMessage = hub.writeState.status === 'succeeded' ? hub.writeState.value.message : null
  const writeWarning = hub.writeState.status === 'succeeded' && hub.writeState.value.reconciliation === 'refresh-failed'
  const rows = hub.rows.map(row => {
    const selectedId = catalogSelection.scope === scope ? catalogSelection.ids[row.providerId] : null
    return {
      ...row,
      selectedConnectionId: row.connections.some(connection => connection.id === selectedId) ? selectedId ?? null : null,
      connections: row.connections.map(connection => {
        const source = hub.connections.status === 'ready'
          ? hub.connections.value.find(item => item.id === connection.id) : undefined
        return source ? {
          ...connection,
          detail: props.getConnectionContext?.(source) ?? connection.detail,
          actions: props.getConnectionActions?.(source),
        } : connection
      }),
    }
  })
  const selectedRow = rows.find(row => row.providerId === hub.provider?.providerId)
  const detailError = hub.detail.status === 'error' ? hub.detail.message
    : hub.detail.status === 'ready' && hub.detail.value.truncated
      ? `Showing at most ${hub.detail.value.tools.length} actions. The provider catalog may be incomplete.` : null
  const detailsByConnectionId = useMemo(() => hub.connection ? {
    [hub.connection.id]: {
      ...hub.details,
      loading: hub.detail.status === 'loading',
      busy: pending,
      error: detailError,
    },
  } : {}, [hub.connection, hub.details, hub.detail.status, pending, detailError])

  const closeDialog = () => {
    if (hub.connectStatus.status === 'pending') hub.cancelConnect()
    else hub.setDialog(null)
    setApiKey(''); setMetadata(undefined); setParameters({})
  }

  return <section className={props.className}>
    {hub.connectStatus.status === 'pending' ? <div role="status" className="mb-4 flex flex-wrap items-center gap-3">
      <span>Finish connecting in the popup.</span>
      <Button type="button" variant="outline" onClick={hub.cancelConnect}>Cancel connection</Button>
    </div> : null}
    {hub.writeState.status === 'pending' ? <p role="status">Saving Hub settings…</p> : null}
    {mutationError ? <p role="alert">{mutationError}</p> : null}
    {writeMessage ? <p role={writeWarning ? 'alert' : 'status'}>{writeMessage}</p> : null}
    {hub.connectStatus.message && hub.provider ? <p role={hub.connectStatus.status === 'failed' ? 'alert' : 'status'}>{hub.connectStatus.message}</p> : null}
    {hub.provider ? <>
      {selectedRow?.canConnect ? <div className="mb-4 flex justify-end"><Button type="button" variant="outline" disabled={pending}
        onClick={() => hub.beginConnect(hub.provider!)}>Connect another account</Button></div> : null}
      <IntegrationConnectionDetail
      provider={displayProvider(hub.provider)}
      connections={selectedRow?.connections ?? []}
      selectedConnectionId={hub.connection?.id ?? null}
      onSelectConnection={connectionId => hub.selectConnection(hub.provider!.providerId, connectionId)}
      detailsByConnectionId={detailsByConnectionId}
      loading={hub.connections.status === 'loading' || hub.detail.status === 'loading'}
      error={detailError}
      backHref={catalogHref()}
      onRetry={() => hub.refresh()}
      onTestConnection={connectionId => { void hub.test(connectionId) }}
      onDisconnect={connectionId => { void hub.revoke(connectionId) }}
      onDecisionChange={(connectionId, actionPath, decision) => {
        if (decision !== 'allow' && decision !== 'ask' && decision !== 'deny') return
        void hub.setDecision(connectionId, actionPath, decision)
      }}
      onResetDecision={(connectionId, actionPath) => { void hub.resetDecision(connectionId, actionPath) }}
      />
    </> : <IntegrationsCatalog
      title={props.title ?? 'Integrations'}
      layout={props.layout}
      rows={rows}
      query={query}
      onQueryChange={setQuery}
      categoryFilter={category}
      onCategoryFilterChange={setCategory}
      sort={sort}
      onSortChange={setSort}
      onSelectConnection={(providerId, connectionId) => setCatalogSelection(current => ({
        scope,
        ids: { ...(current.scope === scope ? current.ids : {}), [providerId]: connectionId },
      }))}
      onConnect={row => { const provider = hub.providers.status === 'ready' ? hub.providers.value.find(item => item.providerId === row.providerId) : null; if (provider) hub.beginConnect(provider) }}
      onManage={(connection, row) => hub.selectConnection(row.providerId, connection.id)}
      onDisconnect={connection => { void hub.revoke(connection.id) }}
      onRequestIntegration={props.onRequestIntegration}
      onRetry={() => hub.refresh()}
      loading={hub.providers.status === 'loading' || hub.connections.status === 'loading'}
      error={error}
      actionError={mutationError}
      connectError={hub.connectStatus.status === 'failed' ? hub.connectStatus.message : null}
      busyProviderId={hub.connectStatus.status === 'pending' ? hub.connectStatus.providerId ?? null : null}
      reserveConnectionContext
    />}
    {hub.dialog?.kind === 'api-key' ? <ApiKeyConnectDialog
      open
      onOpenChange={open => { if (!open) closeDialog() }}
      providerId={hub.dialog.provider.providerId}
      title={hub.dialog.provider.title}
      description={hub.dialog.provider.authHint}
      value={apiKey}
      onValueChange={setApiKey}
      busy={pending}
      error={mutationError}
      canSubmit={apiKey.trim().length > 0 && !pending}
      onSubmit={() => {
        const secret = apiKey
        const target = hub.dialog?.provider.providerId
        const submittedDialog = hub.dialog
        setApiKey('')
        if (target) void hub.submitApiKey(target, secret, metadata).then(result => {
          if (result.succeeded && activeScope.current === scope && activeDialog.current === submittedDialog) {
            hub.setDialog(null); setMetadata(undefined)
          }
        })
      }}
    >{props.renderApiKeyMetadata?.({ provider: hub.dialog.provider, value: metadata, onChange: setMetadata })}</ApiKeyConnectDialog> : null}
    {hub.dialog?.kind === 'oauth' ? <OAuthConnectionParameterDialog
      open
      onOpenChange={open => { if (!open) closeDialog() }}
      providerId={hub.dialog.provider.providerId}
      title={hub.dialog.provider.title}
      parameters={hub.dialog.provider.connectionParameters ?? []}
      values={parameters}
      onValueChange={(key, value) => setParameters({ ...parameters, [key]: value })}
      busy={pending}
      error={hub.connectStatus.status === 'failed' ? hub.connectStatus.message : null}
      canSubmit={!pending && (hub.dialog.provider.connectionParameters ?? []).every(field => !field.required || !!parameters[field.key]?.trim())}
      onSubmit={() => {
        const target = hub.dialog?.provider
        const submittedDialog = hub.dialog
        if (target) void hub.startOAuth(target, parameters).then(result => {
          if (result === 'connected' && activeScope.current === scope && activeDialog.current === submittedDialog) setParameters({})
        })
      }}
    /> : null}
  </section>
}
