export interface AgentHomeWorkflowOptions {
  /** Stable name for idempotent operator reconciliation. */
  instanceKey: string
  lineId: string
  ownerAddress: string
  timeZone: string
}

export interface AgentHomeWorkflow {
  name: string
  purpose: 'heartbeat' | 'consolidation'
  /** JSON is valid YAML. Install with the published HubClient.workflows API. */
  yaml: string
}

/** Definitions only. Platform owns timing, admission, approvals, persistence and delivery. */
export function agentHomeWorkflows(options: AgentHomeWorkflowOptions): AgentHomeWorkflow[] {
  if (!/^ln_[A-Za-z0-9_-]+$/.test(options.lineId) || !/^\+[1-9]\d{6,14}$/.test(options.ownerAddress)) {
    throw new Error('Home workflows need a real Hub line id and enrolled owner address')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/.test(options.instanceKey)) {
    throw new Error('Home workflow instance key is invalid')
  }
  // Intl validates IANA zones without guessing an offset or dropping DST rules.
  new Intl.DateTimeFormat('en-US', { timeZone: options.timeZone }).format(new Date(0))
  const jobs = [
    { purpose: 'heartbeat' as const, cron: '0 8-22 * * *', prompt: [
      'This is the authorized private heartbeat. It is not a new owner request.',
      'Check only actionable items the owner asked you to watch. Do not manufacture a check-in.',
      'Respect the owner\'s local hours and pending approvals. Do not contact another person.',
      'If nothing needs attention, return exactly NO_REPLY, with no other text.',
    ].join(' ') },
    { purpose: 'consolidation' as const, cron: '0 3 * * *', prompt: [
      'This is authorized private home maintenance, not a new owner message.',
      'Read the daily notes and current USER.md and MEMORY.md. Keep dated, useful, non-secret facts only.',
      'Consolidate without inventing facts or copying private guest, vendor, browser or credential data.',
      'Run python3 .tangle/home.py consolidate with JSON on stdin: user and memory are the complete curated texts.',
      'The home command enforces character budgets and commits only the home allowlist to its separate git history.',
      'Keep source notes. A needed permission is still needed; do not bypass it.',
      'Return exactly NO_REPLY after maintenance. A failure is recorded in the line receipt, not a routine chat announcement.',
    ].join(' ') },
  ]
  return jobs.map(job => {
    const name = `${options.instanceKey}:${job.purpose}`
    return { name, purpose: job.purpose, yaml: JSON.stringify({
      name,
      on: { schedule: { cron: job.cron, timezone: options.timeZone } },
      do: [{ 'agent.run': {
        line: { id: options.lineId, member: options.ownerAddress, purpose: job.purpose, timezone: options.timeZone },
        prompt: job.prompt,
      } }],
    }, null, 2) }
  })
}
