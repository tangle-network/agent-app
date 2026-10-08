import type { HubApiKeyConnectionMetadata, HubConnection, HubProvider } from '@tangle-network/hub-sdk'
import {
  ApiKeyConnectDialog,
  IntegrationConnectionDetail,
  IntegrationsCatalog,
  OAuthConnectionParameterDialog,
  ProviderIcon,
  type IntegrationDisplayAction,
  type IntegrationSort,
} from '@tangle-network/sandbox-ui/integrations'
import { Button, StatusPill, type StatusTone } from '@tangle-network/ui/primitives'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { HubIntegrationsClient, HubIntegrationsIdentity } from './client'
import { contextKey, displayProvider, type HubIntegrationCapabilities } from './projection'
import { useHubIntegrations } from './use-hub-integrations'

/** Host-owned access state for one account, such as whether this agent can use it. */
export interface HubAccountStatus {
  label: string
  tone?: StatusTone
}

/**
 * Lists each connected account once, with its host status and one inline host
 * control. The catalog below then offers only providers without an account;
 * Manage opens permissions, Test, Disconnect and Connect another account.
 */
export interface HubIntegrationsAccounts {
  title: string
  description?: string
  /** Shown before any account exists. The catalog below is its next action. */
  emptyLabel?: string
  getStatus?: (connection: HubConnection) => HubAccountStatus | undefined
  /** The host authorizes this control and supplies its new status only after its server confirms. */
  getPrimaryAction?: (connection: HubConnection) => IntegrationDisplayAction | undefined
  /** Host-owned rows rendered after the accounts, such as access to an account that is no longer connected. */
  footer?: ReactNode
}

export interface HubIntegrationsPanelProps {
  identity: HubIntegrationsIdentity
  client: HubIntegrationsClient
  can: HubIntegrationCapabilities
  callbackPath: string
  title?: string
  className?: string
  onRequestIntegration?: (prefill: string) => void
  onUnsupportedConnect?: (provider: HubProvider) => void
  /** Host-owned context and actions; the host authorizes and confirms their effects. */
  getConnectionContext?: (connection: HubConnection) => string | undefined
  getConnectionActions?: (connection: HubConnection) => readonly IntegrationDisplayAction[]
  accounts?: HubIntegrationsAccounts
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

function accountName(connection: HubConnection, providerTitle: string): string {
  return connection.accountDisplay?.trim() || connection.displayName?.trim() || providerTitle
}

function AccountStatus({ connection, accounts }: { connection: HubConnection; accounts: HubIntegrationsAccounts }) {
  const status = accounts.getStatus?.(connection)
  return status ? <StatusPill tone={status.tone ?? 'neutral'} size="sm" className="shrink-0">{status.label}</StatusPill> : null
}

function AccountPrimaryAction({ connection, accounts, busy }: { connection: HubConnection; accounts: HubIntegrationsAccounts; busy: boolean }) {
  const primary = accounts.getPrimaryAction?.(connection)
  return primary ? <Button type="button" variant="outline" size="sm" disabled={busy || primary.disabled}
    onClick={primary.onSelect}>{primary.label}</Button> : null
}

function HubAccountList({ accounts, connections, providers, loading, error, busy, onRetry, onManage, canManage }: {
  accounts: HubIntegrationsAccounts
  connections: readonly HubConnection[]
  providers: readonly HubProvider[]
  loading: boolean
  error: string | null
  busy: boolean
  onRetry: () => void
  onManage: (connection: HubConnection) => void
  canManage: (connection: HubConnection) => boolean
}) {
  const titles = new Map(providers.map(provider => [provider.providerId, provider.title]))
  const title = (connection: HubConnection) => titles.get(connection.providerId) ?? connection.displayName ?? connection.providerId
  const rows = connections.filter(connection => connection.status !== 'revoked')
    .map(connection => ({ connection, provider: title(connection), name: accountName(connection, title(connection)) }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name) || a.connection.id.localeCompare(b.connection.id))
  return <section className="mb-8 min-w-0 space-y-3" aria-labelledby="hub-accounts-heading" aria-busy={loading || undefined}>
    <header>
      <h2 id="hub-accounts-heading" className="text-lg font-semibold">{accounts.title}</h2>
      {accounts.description ? <p className="mt-1 text-sm text-muted-foreground">{accounts.description}</p> : null}
    </header>
    {error ? <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 bg-card p-4 text-sm text-destructive">
      <p className="min-w-0 flex-1 break-words">{error}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>Retry</Button>
    </div> : loading && rows.length === 0 ? <p role="status" className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">Loading connected accounts…</p>
      : rows.length === 0 ? <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">{accounts.emptyLabel ?? 'No accounts connected yet. Connect one below.'}</p>
        : <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card" aria-label={accounts.title}>
          {rows.map(({ connection, provider, name }) => {
            const health = connection.status !== 'active' ? connection.status.replaceAll('_', ' ')
              : connection.health === 'unhealthy' ? 'needs attention' : null
            return <li key={connection.id} data-testid={`hub-account-${connection.id}`}
              className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
                <ProviderIcon id={connection.providerId} displayName={provider} size={32} className="shrink-0 rounded-lg" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium" title={name}>{name}</p>
                  <p className="truncate text-xs text-muted-foreground">{provider}{health ? ` · ${health}` : ''}</p>
                </div>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
                <AccountStatus connection={connection} accounts={accounts} />
                <div className="flex shrink-0 items-center gap-1">
                  <AccountPrimaryAction connection={connection} accounts={accounts} busy={busy} />
                  {canManage(connection) ? <Button type="button" variant="ghost" size="sm" aria-label={`Manage ${provider} account ${name}`}
                    onClick={() => onManage(connection)}>Manage</Button> : null}
                </div>
              </div>
            </li>
          })}
        </ul>}
    {accounts.footer}
  </section>
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
  // With an account list, the catalog only offers providers that have no account yet.
  const catalogRows = props.accounts ? rows.filter(row => row.connections.length === 0) : rows
  const connectionList = hub.connections.status === 'ready' ? hub.connections.value : []
  const selectedConnection = hub.connection
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
      {(props.accounts && selectedConnection) || selectedRow?.canConnect ? <div className="mb-4 flex min-w-0 flex-wrap items-center gap-2">
        {props.accounts && selectedConnection ? <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2" data-testid="hub-account-access"
          aria-label={`Access for ${accountName(selectedConnection, hub.provider.title)}`} role="group">
          <span className="min-w-0 max-w-full truncate text-sm font-medium">{accountName(selectedConnection, hub.provider.title)}</span>
          <AccountStatus connection={selectedConnection} accounts={props.accounts} />
          <AccountPrimaryAction connection={selectedConnection} accounts={props.accounts} busy={pending} />
        </div> : null}
        {selectedRow?.canConnect ? <Button type="button" variant="outline" className="ml-auto" disabled={pending}
          onClick={() => hub.beginConnect(hub.provider!)}>Connect another account</Button> : null}
      </div> : null}
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
    </> : <>
      {props.accounts ? <>
        {hub.connectStatus.status === 'connected' && hub.connectStatus.message ? <p role="status" className="mb-3 text-sm">{hub.connectStatus.message}</p> : null}
        <HubAccountList accounts={props.accounts} connections={connectionList} providers={hub.providers.status === 'ready' ? hub.providers.value : []}
          loading={hub.connections.status === 'loading'} error={hub.connections.status === 'error' ? hub.connections.message : null} busy={pending}
          onRetry={() => hub.refresh()} onManage={connection => hub.selectConnection(connection.providerId, connection.id)}
          canManage={connection => props.can({ operation: 'policies.list', connectionId: connection.id })} />
      </> : null}
      {props.accounts && hub.connections.status === 'error' ? null : <IntegrationsCatalog
      title={props.title ?? 'Integrations'}
      rows={catalogRows}
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
      emptyCatalogLabel={props.accounts && rows.length > 0 ? 'Every available integration already has a connected account above.' : undefined}
    />}
    </>}
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
