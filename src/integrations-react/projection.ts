import type { HubConnection, HubPolicy, HubProvider, HubTool } from '@tangle-network/hub-sdk'
import type {
  IntegrationConnectionDetails,
  IntegrationDisplayProvider,
  IntegrationPermissionDisplay,
  IntegrationPermissionGroup,
  IntegrationsProviderRow,
} from '@tangle-network/sandbox-ui/integrations'

export type HubIntegrationCapability =
  | { operation: 'oauth.start' | 'api-key.connect'; providerId: string }
  | { operation: 'connection.revoke' | 'connection.health' | 'policies.list'; connectionId: string }
  | { operation: 'policy.set' | 'policy.reset'; connectionId: string; actionPath: string }

/** Display hints only. `createHubSettingsRoutes.authorize` remains authoritative. */
export type HubIntegrationCapabilities = (intent: HubIntegrationCapability) => boolean

export const ACTION_LIMIT = 200

export function contextKey(identity: { userId: string; sessionId: string; workspaceId: string }): string {
  return JSON.stringify([identity.userId, identity.sessionId, identity.workspaceId])
}

export function displayProvider(provider: HubProvider): IntegrationDisplayProvider {
  return { providerId: provider.providerId, title: provider.title, category: provider.category }
}

export function catalogRows(
  providers: readonly HubProvider[],
  connections: readonly HubConnection[],
  selectedIds: Readonly<Record<string, string | null>>,
  can: HubIntegrationCapabilities,
  hasUnsupportedConnect = false,
): IntegrationsProviderRow[] {
  return providers.map(provider => {
    const accounts = connections.filter(connection => connection.providerId === provider.providerId)
    return {
      ...displayProvider(provider),
      kind: 'provider',
      authKind: provider.authKind,
      selectedConnectionId: accounts.some(account => account.id === selectedIds[provider.providerId])
        ? selectedIds[provider.providerId] ?? null : null,
      canConnect: provider.authKind === 'oauth2'
        ? provider.configured && can({ operation: 'oauth.start', providerId: provider.providerId })
        : provider.authKind === 'api_key'
          ? provider.configured && can({ operation: 'api-key.connect', providerId: provider.providerId })
          : hasUnsupportedConnect,
      connections: accounts.map(connection => ({
        id: connection.id,
        accountDisplay: connection.accountDisplay ?? connection.displayName,
        statusLabel: connection.status === 'active' ? 'Connected' : connection.status.replaceAll('_', ' '),
        statusTone: connection.status === 'active' && connection.health !== 'unhealthy' ? 'success' : 'warning',
        detail: connection.providerAccountId ?? undefined,
        capabilities: {
          manage: can({ operation: 'policies.list', connectionId: connection.id }),
          disconnect: can({ operation: 'connection.revoke', connectionId: connection.id }),
          test: can({ operation: 'connection.health', connectionId: connection.id }),
          editPermissions: can({ operation: 'policies.list', connectionId: connection.id }),
          resetPermissions: can({ operation: 'policies.list', connectionId: connection.id }),
        },
      })),
    }
  })
}

const OPTIONS = [
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask' },
  { value: 'deny', label: 'Deny' },
] as const

/** Stored overrides are shown; app-specific effective policy is never guessed. */
export function permissionDetails(
  tools: readonly HubTool[],
  policies: readonly HubPolicy[],
  connectionId: string,
  can: HubIntegrationCapabilities,
): IntegrationConnectionDetails {
  const overrides = new Map(policies.filter(policy => policy.connectionId === connectionId).map(policy => [policy.actionPath, policy.decision]))
  const groups: IntegrationPermissionGroup[] = [
    { id: 'writes', title: 'Write and unknown actions', rows: [] },
    { id: 'reads', title: 'Read actions', collapsed: true, rows: [] },
  ]
  const writes: IntegrationPermissionDisplay[] = []
  const reads: IntegrationPermissionDisplay[] = []
  for (const tool of tools) {
    const override = overrides.get(tool.path)
    const row = {
      actionPath: tool.path,
      title: tool.title ?? tool.path,
      riskLabel: tool.risk ?? 'unknown',
      riskTone: tool.risk === 'destructive' ? 'error' : tool.risk === 'write' || tool.risk === undefined ? 'warning' : 'neutral',
      decision: override ?? null,
      decisionOptions: OPTIONS,
      sourceLabel: override ? 'Stored override' : 'No stored override',
      canReset: override !== undefined && can({ operation: 'policy.reset', connectionId, actionPath: tool.path }),
      disabled: !can({ operation: 'policy.set', connectionId, actionPath: tool.path }),
    } as const
    if (tool.risk === 'read') reads.push(row)
    else writes.push(row)
  }
  writes.sort((a, b) => a.title.localeCompare(b.title))
  reads.sort((a, b) => a.title.localeCompare(b.title))
  groups[0] = { ...groups[0]!, rows: writes }
  groups[1] = { ...groups[1]!, rows: reads }
  return { permissionGroups: groups }
}
