import { DEFAULT_AGENT_HOME } from '../profile/home'

export interface AgentHomeWorkflowOptions {
  /** Stable name for idempotent operator reconciliation. */
  instanceKey: string
  lineId: string
  ownerAddress: string
  timeZone: string
  /** Additional owner-authorized watch instructions, not a schedule override. */
  heartbeatInstructions?: string
}

export interface AgentHomeWorkflow {
  name: string
  purpose: 'heartbeat' | 'consolidation'
  /** JSON is valid YAML. Install with the published HubClient.workflows API. */
  yaml: string
}

/** Platform owns timing, admission, approvals, persistence and DM delivery. */
export function agentHomeWorkflows(options: AgentHomeWorkflowOptions): AgentHomeWorkflow[] {
  if (!/^ln_[A-Za-z0-9_-]+$/.test(options.lineId) || !/^\+[1-9]\d{6,14}$/.test(options.ownerAddress)) {
    throw new Error('Home workflows need a real Hub line id and enrolled owner address')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/.test(options.instanceKey)) {
    throw new Error('Home workflow instance key is invalid')
  }
  if ((options.heartbeatInstructions?.length ?? 0) > 8000) throw new Error('Heartbeat instructions exceed their budget')
  new Intl.DateTimeFormat('en-US', { timeZone: options.timeZone }).format(new Date(0))
  const jobs = [
    { purpose: 'heartbeat' as const, cron: '0 8-22 * * *', prompt: [
      'This is the authorized private heartbeat, not a new owner message.',
      `Your protected home is ${DEFAULT_AGENT_HOME}. Read relevant notes through home_read.`,
      'Check only actionable items the owner asked you to watch. Do not manufacture a check-in.',
      'Respect the owner\'s local hours and pending approvals. Do not contact another person.',
      options.heartbeatInstructions ?? '',
      'If nothing needs attention, return exactly NO_REPLY, with no other text.',
    ].filter(Boolean).join(' ') },
    { purpose: 'consolidation' as const, cron: '0 3 * * *', prompt: [
      'This is authorized private home maintenance, not a new owner message.',
      'Use home_status to obtain the current Git commit and inventory.',
      'Read daily notes, USER.md and MEMORY.md with home_read. Keep dated, useful, non-secret facts only.',
      'Consolidate without inventing facts or copying private guest, vendor, browser or credential data.',
      'Call home_consolidate with complete user and memory texts and the expectedHead from the snapshot you read.',
      'The protected writer validates both documents before writing and commits them together. If the head changed, reread first.',
      'Keep source notes. A needed permission is still needed; do not bypass it.',
      'Return exactly NO_REPLY after maintenance. Read the settled line receipt to confirm completion; queue admission is not completion.',
    ].join(' ') },
  ]
  return jobs.map(job => {
    const name = `${options.instanceKey}:${job.purpose}`
    return { name, purpose: job.purpose, yaml: JSON.stringify({
      name,
      // The operator enables these after the owner has consented and the
      // installed role/home boundary has passed the deployed smoke proof.
      enabled: false,
      on: { schedule: { cron: job.cron, timezone: options.timeZone } },
      do: [{ 'agent.run': {
        line: { id: options.lineId, member: options.ownerAddress, purpose: job.purpose, timezone: options.timeZone },
        prompt: job.prompt,
      } }],
    }, null, 2) }
  })
}
