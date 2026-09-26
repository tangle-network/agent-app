import { HubClient } from '@tangle-network/hub-sdk'

export interface AgentHeartbeatConfig {
  /** Deployment-time owner credential, never copied into the agent home. */
  apiKey: string
  agentId: string
  lineId: string
  ownerAddress: string
  timeZone: string
  /** Omitted: one heartbeat every fifteen minutes. Hub validates the cron. */
  cron?: string
  /** Update the existing workflow instead of creating a duplicate schedule. */
  workflowId?: string
}

export function agentHeartbeatDefinition(config: Omit<AgentHeartbeatConfig, 'apiKey' | 'workflowId'>): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(config.agentId)) throw new Error('Invalid agentId')
  if (!/^ln_[a-zA-Z0-9_-]+$/.test(config.lineId)) throw new Error('A Hub line ID is required')
  if (!/^\+[1-9]\d{6,14}$/.test(config.ownerAddress)) throw new Error('Use the enrolled owner phone address')
  new Intl.DateTimeFormat('en', { timeZone: config.timeZone })
  // JSON is valid YAML; the published Hub service validates and compiles this
  // definition. There is no local scheduler and no throwaway agent.run box.
  return JSON.stringify({
    name: `${config.agentId} heartbeat`,
    description: 'Wake the enrolled owner agent in its existing persistent sandbox. Line limits and approvals still apply.',
    enabled: true,
    on: { schedule: { cron: config.cron ?? '*/15 * * * *', timezone: config.timeZone } },
    do: [{ 'agent.run': {
      line: { id: config.lineId, member: config.ownerAddress },
      prompt: 'This is your scheduled heartbeat. Inspect /home/agent/tangle-home/HEARTBEAT.md when it exists, review due work and curate durable memory. Use the same role, scope and owner-approval rules as an ordinary turn. Do not spend money, delete data or contact a new outside party without approval. Do not report a queued operation as complete. If no work is due, keep the response brief.',
    } }],
  }, null, 2)
}

/** Called by the authorized deployer; returning is a real Hub workflow receipt. */
export async function configureAgentHeartbeat(config: AgentHeartbeatConfig) {
  const hub = new HubClient({ apiKey: config.apiKey, baseUrl: 'https://id.tangle.tools' })
  const definition = agentHeartbeatDefinition(config)
  return config.workflowId
    ? hub.workflows.update(config.workflowId, definition, { note: 'Tangle agent v1 persistent-line heartbeat' })
    : hub.workflows.create(definition)
}
