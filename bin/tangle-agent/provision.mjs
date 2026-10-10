import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { Sandbox } from '@tangle-network/sandbox/core'
import { HubClient } from '@tangle-network/hub-sdk'
import { agentProfileSchema, defineAgentProfilePublicConfig as publicValue,
  defineAgentProfileSecretRef as secretRef, mergeAgentProfiles } from '@tangle-network/agent-interface'
import { GENERAL_AGENT_MODEL, GENERAL_AGENT_SYSTEM_PROMPT, DEFAULT_AGENT_HOME,
  withDefaultAgentHome, agentHomeWorkflows } from '../../dist/hosted-agent/index.js'

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
const role = z.enum(['owner', 'manager', 'staff', 'vendor', 'finance', 'practitioner'])
const envKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
const domain = z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/)
const protectedProfile = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  if (Object.hasOwn(value, 'interactions')) context.addIssue({ code: 'custom',
    message: 'A general-agent profile cannot override backend permission interactions' })
}).transform(value => agentProfileSchema.parse(value))
const backend = z.object({ type: z.literal('opencode').optional(), profile: protectedProfile }).strict()
  .transform(value => ({ ...value, type: 'opencode', interactions: { permission: true } }))
const configSchema = z.object({
  version: z.literal(1),
  keyPrefix: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/),
  environment: z.string().min(1),
  model: z.string().min(1).default(GENERAL_AGENT_MODEL),
  imageModel: z.string().min(1), videoModel: z.string().min(1),
  runtimeModule: z.string().regex(/^\//).default('/opt/tangle-agent/node_modules/@tangle-network/agent-app/bin/tangle-agent.mjs'),
  home: z.literal(DEFAULT_AGENT_HOME).default(DEFAULT_AGENT_HOME),
  chromium: z.string().regex(/^\//),
  proxyEnv: envKey.default('HTTPS_PROXY'), routerKeyEnv: envKey.default('OPENCODE_MODEL_API_KEY'),
  allowDomains: z.array(domain).max(95).default([]),
  resources: z.object({ cpuCores: z.number().int().min(2).max(64).default(2),
    memoryMB: z.number().int().min(4096).max(262144).default(4096),
    diskGB: z.number().int().min(10).max(2048).default(20) }).strict().prefault({}),
  baseProfile: protectedProfile.prefault({}),
  scopedServers: z.record(z.string(), z.array(name).min(1).max(16)).default({}),
  members: z.array(z.object({ address: z.string().regex(/^\+[1-9]\d{6,14}$/), role,
    label: z.string().min(1).max(60), backend: backend.optional(),
    secretNames: z.array(z.string().regex(/^TANGLE_AGENT_PRODUCT_[A-Z0-9_]{1,96}$/)).max(16).optional() }).strict()).min(1).max(50),
  lines: z.array(z.object({ id: z.string().regex(/^ln_[A-Za-z0-9_-]+$/),
    transport: z.enum(['imessage', 'whatsapp']),
    voice: z.object({ ph0nyConnectionId: z.string().min(1), ph0nyAgentId: z.string().min(1),
      outboundFrom: z.string().regex(/^\+[1-9]\d{6,14}$/) }).strict().optional(),
  }).strict()).min(1).max(8),
  // No guessed owner timezone. Supplying this installs both disabled jobs;
  // the operator enables them after consent and the deployed boundary proof.
  heartbeat: z.object({ lineId: z.string().min(1), owner: z.string().regex(/^\+[1-9]\d{6,14}$/),
    cron: z.literal('0 8-22 * * *').default('0 8-22 * * *'), timezone: z.string().min(1),
    prompt: z.string().min(1).max(8000).optional(),
  }).strict(),
}).strict()

export function buildGeneralAgent(configInput) {
  const config = configSchema.parse(configInput)
  if (new Set(config.members.map(member => member.address)).size !== config.members.length ||
      new Set(config.lines.map(line => line.id)).size !== config.lines.length) throw new Error('Members and lines must be unique')
  if (config.members.filter(member => member.role === 'owner').length !== 1) throw new Error('Exactly one enrolled owner is required for approvals')
  if (config.baseProfile.prompt?.systemPrompt) throw new Error('Business presets add instructions and skills, not a replacement system prompt')
  for (const line of config.lines) if (line.voice && line.transport !== 'imessage') throw new Error('Hub voice requires the Inkbox iMessage line')
  const roles = {}, grants = {}, members = {}
  for (const member of config.members) {
    const general = ['owner', 'manager'].includes(member.role)
    roles[member.role] = { context: 'own', tools: 'act' }
    if (general) grants[member.role] = { kind: 'general' }
    else {
      const servers = config.scopedServers[member.role]
      if (!servers?.length || !member.backend) throw new Error(`Scoped ${member.role} needs an enrolled product backend and named MCP servers`)
      grants[member.role] = { kind: 'scoped', mcpServers: servers }
    }
    if (member.backend) members[member.address] = { backend: member.backend,
      ...(member.secretNames ? { secretNames: member.secretNames } : {}) }
  }
  const substrate = agentProfileSchema.parse({
    name: 'tangle-agent-v1', model: { default: config.model },
    prompt: { systemPrompt: GENERAL_AGENT_SYSTEM_PROMPT, instructions: [
      `Your protected home is ${config.home}. It is preinstalled and root-owned. Read AGENTS.md and SOUL.md there. Use home_read, home_write, home_append, home_status, home_bootstrap and home_consolidate. Ordinary shell and code remain available outside this protected directory. Never create an unprotected replacement home.`,
      'The protected writer enforces Unicode-character, byte and file-count caps before any memory mutation. Replacements, deletions and consolidation require expectedHead from the snapshot you read. Reread after a conflict or an unconfirmed append. Every successful mutation returns a local Git checkpoint, not proof of remote persistence. A SOUL.md change requires an immediate owner notice. Keep credentials and third-party private data out of memory.',
      'Use the published tangle_agent tools for Router search/read, Browser Agent and image/video generation. Use native computer-use tools for the virtual display and explicitly mounted Hub connections for email, calendar and ph0ny. Do not substitute direct provider APIs or disable the allowlist proxy.',
      'The platform scheduler owns reminders and maintenance. The hourly heartbeat and nightly consolidation use the same consenting owner session. A queued workflow is not a completed reminder; report the actual workflow and eventual line receipts.',
    ] },
    mcp: { tangle_agent: { transport: 'stdio', command: 'node',
      args: [publicValue(config.runtimeModule), publicValue('serve')],
      env: {
        TANGLE_AGENT_ROUTER_KEY: secretRef(config.routerKeyEnv),
        TANGLE_AGENT_BROWSER_PROXY: secretRef(config.proxyEnv),
        TANGLE_AGENT_HOME: publicValue(config.home), TANGLE_AGENT_CHROMIUM: publicValue(config.chromium),
        TANGLE_AGENT_MODEL: publicValue(config.model), TANGLE_AGENT_IMAGE_MODEL: publicValue(config.imageModel),
        TANGLE_AGENT_VIDEO_MODEL: publicValue(config.videoModel),
      }, enabled: true } },
    resources: { failOnError: true },
  })
  const composed = mergeAgentProfiles(config.baseProfile, substrate)
  if (!composed) throw new Error('General profile composition failed')
  const profile = withDefaultAgentHome(composed)
  for (const line of config.lines) {
    if (!line.voice) continue
    const { ph0nyConnectionId, ph0nyAgentId, outboundFrom } = line.voice
    const capabilities = ['phony.start_outbound_call', 'phony.get_call']
    const existing = profile.connections?.find(value => value.connectionId === ph0nyConnectionId)
    if (existing) {
      if (!existing.capabilities.includes('*')) existing.capabilities = [...new Set([...existing.capabilities, ...capabilities])]
    } else profile.connections = [...(profile.connections ?? []), { connectionId: ph0nyConnectionId, capabilities }]
    profile.prompt.instructions.push(`Voice line ${line.id}: use the connected ph0ny tools with agentId ${ph0nyAgentId} and the operator-attested fromNumber ${outboundFrom}. The enrolled owner destination is ${config.members.find(member => member.role === 'owner').address}. Wait for owner approval and actual consent. The call hook rechecks membership and binds the destination member's role and private workspace. Report the actual call id and connected/completed state, not a submission alone.`)
  }
  agentProfileSchema.parse(profile)
  const respond = { kind: 'agent', backend: {
    type: 'opencode', profile, interactions: { permission: true },
  }, rolePolicy: { version: 1, roles: grants, members } }
  const attachments = config.lines.map(line => ({
    number: line.id, mode: 'shared', unknownSenders: 'reject', roles,
    members: config.members.map(({ address, role, label }) => ({ address, role, label })),
    respond, clientReference: config.keyPrefix,
    instance: { keyPrefix: config.keyPrefix, create: {
      name: 'tangle-agent-v1', environment: config.environment, ownerContext: 'isolated', capabilities: ['computer_use'],
      resources: config.resources,
      egressPolicy: { mode: 'strict', includeImplicitDomains: false,
        allowDomains: [...new Set(['router.tangle.tools', 'id.tangle.tools', ...config.allowDomains])] },
      idleTimeoutSeconds: 600, maxLifetimeSeconds: 90 * 86400, deleteAfterStoppedSeconds: 90 * 86400,
    } },
  }))
  const h = config.heartbeat
  if (!config.lines.some(line => line.id === h.lineId) ||
      !config.members.some(member => member.address === h.owner && member.role === 'owner')) {
    throw new Error('Heartbeat must target a configured line and its enrolled owner')
  }
  const workflows = agentHomeWorkflows({ instanceKey: config.keyPrefix, lineId: h.lineId,
    ownerAddress: h.owner, timeZone: h.timezone, heartbeatInstructions: h.prompt })
  return { config, attachments, workflows, heartbeat: workflows.find(job => job.purpose === 'heartbeat').yaml }
}

export async function provision(path, apply = false) {
  const plan = buildGeneralAgent(JSON.parse(await readFile(path, 'utf8')))
  if (!apply) {
    console.log(JSON.stringify({ attachments: plan.attachments, workflows: plan.workflows }, null, 2))
    return
  }
  const key = process.env.TANGLE_API_KEY
  if (!key) throw new Error('TANGLE_API_KEY must be supplied to the trusted operator, never the agent image')
  const sandbox = new Sandbox({ apiKey: key, baseUrl: process.env.SANDBOX_BASE_URL ?? 'https://sandbox.tangle.tools' })
  const hub = new HubClient({ apiKey: key, baseUrl: 'https://id.tangle.tools' })
  // Validate all owned transports first. SDK attach is idempotent for the
  // exact config and refuses a changed active attachment. Never auto-detach.
  for (const line of plan.config.lines) {
    const current = await sandbox.lines.get(line.id)
    if (current.transport !== line.transport || current.status !== 'active') throw new Error('Line is not an active owned line on the declared transport')
  }
  const receipts = []
  for (let i = 0; i < plan.attachments.length; i++) {
    const attachment = await sandbox.lines.attach(plan.attachments[i])
    const line = plan.config.lines[i]
    if (line.voice) {
      const { ph0nyConnectionId, ph0nyAgentId } = line.voice
      await sandbox.lines.enableVoice(line.id, { ph0nyConnectionId, ph0nyAgentId })
    }
    receipts.push({ line: await sandbox.lines.get(line.id), attachment })
    console.log(JSON.stringify({ state: 'attached', lineId: line.id, attachmentId: attachment.id }))
  }
  const existing = await hub.workflows.list()
  const workflows = []
  for (const job of plan.workflows) {
    const matches = existing.filter(value => value.name === job.name)
    if (matches.length > 1) throw new Error('Duplicate home workflows exist; refuse to create another')
    const workflow = matches.length ? await hub.workflows.update(matches[0].id, job.yaml)
      : await hub.workflows.create(job.yaml)
    workflows.push({ purpose: job.purpose, workflow })
  }
  console.log(JSON.stringify({ receipts, workflows,
    next: 'Do not use this attachment until ADC checks exact native approval on each member instance and the local allow/deny effect-sink proof passes. Then the owner must text first. Verify the actual runtime UID, protected home, scoped vendor denial and installed tools before enabling the two disabled Hub workflows.' }, null, 2))
}
