import { useCallback, useEffect, useState } from 'react'
import { ApiAccessPanel, AgentSetupBlock, type ApiAccessKey } from '@tangle-network/agent-app/web-react'
import { json, post } from './api'

const access = [
  { scope: 'operator:read', label: 'Read workspace', description: 'Read your conversations, task results, and pending owner decisions.' },
  { scope: 'operator:run', label: 'Run agent work', description: 'Start work and modify your workspace using this deployment’s paid model and sandbox access. No finite spending cap is enforced on this lane.', requires: ['operator:read'] },
]

export function ApiAccess() {
  const [runEnabled, setRunEnabled] = useState(false)
  const [keys, setKeys] = useState<ApiAccessKey[]>([])
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try {
      const [stored, policy] = await Promise.all([json<{ keys: ApiAccessKey[] }>('/api/keys'), json<{ operatorRunEnabled: boolean }>('/api/keys/access')])
      setKeys(stored.keys); setRunEnabled(policy.operatorRunEnabled); setError(null)
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  return <div className="h-full overflow-y-auto p-6">
    <AgentSetupBlock productName={document.title} setupUrl={`${location.origin}/agent-setup.md`} description="Give your external agent the setup instructions. You sign in, issue or reuse an expiring key, and grant its scopes. The agent verifies access with that key; it cannot approve deployment spending for you." />
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {!runEnabled && <p>External-agent execution is disabled until the deployment payer enables it. Read-only access remains available.</p>}
    <ApiAccessPanel keys={keys} access={access.filter(item => item.scope !== 'operator:run' || runEnabled)} defaultScopes={['operator:read']} baseUrl={`${location.origin}/api/operator/v1`}
      description="Give an external agent an expiring, revocable key to your personal workspace. Existing accounts and keys can be reused."
      limitsDescription="Read-only is the default. Run access can incur provider charges and change workspace files. Review your budget before granting it. Human decisions remain in your browser."
      onCreate={async ({ name, scopes, expiresAt }) => json('/api/keys', post({ name, scopes, expiresAt }))}
      onRevoke={async id => { await json(`/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }) }}
      onChanged={() => void refresh()} />
  </div>
}
