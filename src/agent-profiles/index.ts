/** Chat-owned profile revisions and member/channel bindings. Execution stays in the substrate. */
import {
  canonicalAgentProfileDigest,
  diffAgentProfiles,
  snapshotAgentProfile,
  sha256Utf8,
  type AgentProfile,
  type AgentProfileDiff,
} from '@tangle-network/agent-interface'
import { z } from 'zod'
import type { McpToolDefinition } from '../tools'

export type ProfileAuthorKind = 'person' | 'agent' | 'optimizer'
export type ProfileRevisionState = 'active' | 'candidate' | 'pending-consent'

/** The decision table used by every write path; products may narrow access, never widen it. */
export const PROFILE_CHANGE_POLICY = {
  textEdit: { admission: 'automatic', conversation: 'same', destructive: false },
  sameAuthoritySwitch: { admission: 'automatic', conversation: 'same', destructive: false },
  differentAuthoritySwitch: { admission: 'prepare-then-flip', conversation: 'same', destructive: false },
  authorityEdit: { admission: 'editor-consent', conversation: 'same', destructive: false },
  optimizerRevision: { admission: 'eval-promotion', conversation: 'same', destructive: false },
  destructiveAction: { admission: 'reaper-only', conversation: 'none', destructive: true },
} as const

export interface ProfileRevision {
  id: string
  workspaceId: string
  profileId: string
  parentId: string | null
  profile: AgentProfile
  knowledgeText: string
  author: { kind: ProfileAuthorKind; id: string }
  reason: string
  diff: AgentProfileDiff[]
  authorityDigest: string
  /** ADC hash of the public profile plan, without per-turn product attachments. */
  planDigest: string
  state: ProfileRevisionState
  createdAt: number
}

export interface ProfileBindingKey {
  workspaceId: string
  memberId: string
  /** `chat`, or a product-scoped phone line and sender key. */
  channel: string
}

export interface ProfileBinding extends ProfileBindingKey {
  profileId: string
  pinnedRevisionId: string | null
  authorityDigest: string
  planDigest: string
  version: number
}

export interface ProfileTurnPin {
  workspaceId: string
  memberId: string
  channel: string
  messageId: string
  inputHash: string
  profileId: string
  revisionId: string
  authorityDigest: string
  /** Effective ADC plan selected by the executor, including allowed turn attachments. */
  planDigest: string
}

/** Remove events name only adds they observed; a concurrent add survives. */
export interface ProfileKnowledgeEvent {
  id: string
  workspaceId: string
  profileId: string
  documentId: string
  kind: 'add' | 'remove'
  content: string | null
  observedAddIds: string[]
  createdAt: number
}

export interface ProfileKnowledgeDocument {
  documentId: string
  content: string
  addEventId: string
}

export interface ProfileSwitchReceipt {
  key: ProfileBindingKey
  messageId: string
  inputHash: string
  profileId: string | null
  revisionId: string | null
  /** A rollback binds the previous immutable revision, not the current head. */
  pinnedRevisionId: string | null
  authorityDigest: string | null
  planDigest: string | null
  outcome: 'switched' | 'refused'
  message: string
  /** Workspace resource collisions retain the original and place the profile copy beside it. */
  conflicts: string[]
}

export interface ProfileRevisionStore {
  getActiveRevision(workspaceId: string, profileId: string): Promise<ProfileRevision | null>
  getRevision(workspaceId: string, profileId: string, revisionId: string): Promise<ProfileRevision | null>
  /** Append the immutable row and optionally an activation event in one guarded transaction. */
  appendRevision(revision: ProfileRevision, expectedActiveId: string | null, activate: boolean): Promise<boolean>
  /** Promotion appends an activation event; the historical revision remains immutable. */
  promoteRevision(workspaceId: string, profileId: string, revisionId: string, expectedActiveId: string | null): Promise<boolean>
  getBinding(key: ProfileBindingKey): Promise<ProfileBinding | null>
  getSwitchReceipt(key: ProfileBindingKey, messageId: string, inputHash: string): Promise<ProfileSwitchReceipt | null>
  /** Receipt and binding event append atomically; a refusal leaves the binding untouched. */
  recordSwitch(receipt: ProfileSwitchReceipt, expectedVersion: number): Promise<ProfileSwitchReceipt>
  /** Persist one immutable pin under a message id; retries must return the same pin. */
  pinTurn(pin: ProfileTurnPin, expectedBindingVersion: number): Promise<ProfileTurnPin>
  getTurnPin(key: ProfileBindingKey, messageId: string, inputHash: string): Promise<ProfileTurnPin | null>
  listKnowledgeEvents(workspaceId: string, profileId: string): Promise<ProfileKnowledgeEvent[]>
  appendKnowledgeEvent(event: ProfileKnowledgeEvent): Promise<void>
}

export class ProfileConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileConflictError'
  }
}

export class ProfileAccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileAccessError'
  }
}

/** Remove exactly the declared text axes. Unknown future fields remain authority. */
export function profileAuthority(profile: AgentProfile): AgentProfile {
  const { name: _name, description: _description, prompt, ...authority } = profile
  const { systemPrompt: _systemPrompt, instructions: _instructions, ...promptAuthority } = prompt ?? {}
  return { ...authority, ...(Object.keys(promptAuthority).length ? { prompt: promptAuthority } : {}) }
}

export function profileAuthorityDigest(profile: AgentProfile): string {
  return canonicalAgentProfileDigest(profileAuthority(snapshotAgentProfile(profile)))
}

export function projectKnowledgeDocuments(events: readonly ProfileKnowledgeEvent[]): ProfileKnowledgeDocument[] {
  const removed = new Set(events.filter(event => event.kind === 'remove').flatMap(event => event.observedAddIds))
  const visible = events.filter(event => event.kind === 'add' && !removed.has(event.id))
  const latest = new Map<string, ProfileKnowledgeEvent>()
  for (const event of visible) {
    const prior = latest.get(event.documentId)
    if (!prior || event.createdAt > prior.createdAt ||
        (event.createdAt === prior.createdAt && event.id > prior.id)) latest.set(event.documentId, event)
  }
  return [...latest.values()].sort((a, b) => a.documentId.localeCompare(b.documentId))
    .map(event => ({ documentId: event.documentId, content: event.content!, addEventId: event.id }))
}

export async function addProfileKnowledgeDocument(input: {
  store: ProfileRevisionStore
  workspaceId: string
  profileId: string
  documentId: string
  content: string
  actorRole: 'owner' | 'manager' | 'member' | 'viewer'
  id?: string
  now?: number
}): Promise<ProfileKnowledgeEvent> {
  if (input.actorRole !== 'owner' && input.actorRole !== 'manager') {
    throw new ProfileAccessError('Profile management is required')
  }
  if (!input.documentId || !input.content) throw new TypeError('A knowledge document needs an id and content')
  const event: ProfileKnowledgeEvent = { id: input.id ?? crypto.randomUUID(),
    workspaceId: input.workspaceId, profileId: input.profileId, documentId: input.documentId,
    kind: 'add', content: input.content, observedAddIds: [], createdAt: input.now ?? Date.now() }
  await input.store.appendKnowledgeEvent(event)
  return event
}

export async function removeProfileKnowledgeDocument(input: {
  store: ProfileRevisionStore
  workspaceId: string
  profileId: string
  documentId: string
  actorRole: 'owner' | 'manager' | 'member' | 'viewer'
  id?: string
  now?: number
}): Promise<ProfileKnowledgeEvent> {
  if (input.actorRole !== 'owner' && input.actorRole !== 'manager') {
    throw new ProfileAccessError('Profile management is required')
  }
  const events = await input.store.listKnowledgeEvents(input.workspaceId, input.profileId)
  const removed = new Set(events.filter(event => event.kind === 'remove').flatMap(event => event.observedAddIds))
  const observedAddIds = events.filter(event => event.kind === 'add' &&
    event.documentId === input.documentId && !removed.has(event.id)).map(event => event.id)
  const event: ProfileKnowledgeEvent = { id: input.id ?? crypto.randomUUID(),
    workspaceId: input.workspaceId, profileId: input.profileId, documentId: input.documentId,
    kind: 'remove', content: null, observedAddIds, createdAt: input.now ?? Date.now() }
  await input.store.appendKnowledgeEvent(event)
  return event
}

/** The per-turn text overlay is validated without admitting tools, model, MCP or resources. */
export function bindProfileText(consentedBaseline: AgentProfile, selected: AgentProfile): AgentProfile {
  if (profileAuthorityDigest(consentedBaseline) !== profileAuthorityDigest(selected)) {
    throw new ProfileAccessError('Profile authority differs; prepare its managed plan before the next turn')
  }
  const result: AgentProfile = { ...consentedBaseline, name: selected.name, description: selected.description }
  const prompt = { ...consentedBaseline.prompt, systemPrompt: selected.prompt?.systemPrompt,
    instructions: selected.prompt?.instructions }
  if (Object.values(prompt).some(value => value !== undefined)) result.prompt = prompt
  else delete result.prompt
  return snapshotAgentProfile(result)
}

export interface ProposeRevisionInput {
  store: ProfileRevisionStore
  workspaceId: string
  profileId: string
  expectedRevisionId: string | null
  profile: AgentProfile
  knowledgeText: string
  /** The exact ADC `hashWorkspacePlan` for this authored snapshot. */
  planDigest: string
  author: ProfileRevision['author']
  /** Trusted role from the authenticated session, never model arguments. */
  actorRole: 'owner' | 'manager' | 'member' | 'viewer'
  reason: string
  id?: string
  now?: number
}

/** All authors use one immutable write path. Optimizer and authority edits cannot self-activate. */
export async function proposeRevision(input: ProposeRevisionInput): Promise<ProfileRevision> {
  if (input.author.kind !== 'optimizer' && input.actorRole !== 'owner' && input.actorRole !== 'manager') {
    throw new ProfileAccessError('Only an owner or manager can change a profile')
  }
  if (!input.workspaceId || !input.profileId || !input.author.id || !input.reason.trim() ||
      !/^sha256:[a-f0-9]{64}$/.test(input.planDigest)) {
    throw new TypeError('A profile revision needs workspace, profile, author, reason and plan digest')
  }
  const previous = await input.store.getActiveRevision(input.workspaceId, input.profileId)
  if ((previous?.id ?? null) !== input.expectedRevisionId) {
    throw new ProfileConflictError('The profile changed; read its latest revision before saving')
  }
  const profile = snapshotAgentProfile(input.profile)
  const diff = previous ? diffAgentProfiles(previous.profile, profile) : []
  const authorityDigest = profileAuthorityDigest(profile)
  const authorityChanged = !!previous && previous.authorityDigest !== authorityDigest
  const admission = input.author.kind === 'optimizer'
    ? PROFILE_CHANGE_POLICY.optimizerRevision.admission
    : authorityChanged
      ? PROFILE_CHANGE_POLICY.authorityEdit.admission
      : PROFILE_CHANGE_POLICY.textEdit.admission
  const state: ProfileRevisionState = admission === 'eval-promotion' ? 'candidate'
    : admission === 'editor-consent' ? 'pending-consent' : 'active'
  const revision: ProfileRevision = {
    id: input.id ?? crypto.randomUUID(), workspaceId: input.workspaceId, profileId: input.profileId,
    parentId: previous?.id ?? null, profile, knowledgeText: input.knowledgeText,
    author: input.author, reason: input.reason.trim(), diff, authorityDigest,
    planDigest: input.planDigest, state, createdAt: input.now ?? Date.now(),
  }
  if (!await input.store.appendRevision(revision, input.expectedRevisionId, state === 'active')) {
    throw new ProfileConflictError('The profile changed while saving')
  }
  return revision
}

export async function promoteRevision(input: {
  store: ProfileRevisionStore
  workspaceId: string
  profileId: string
  revisionId: string
  actorRole: 'owner' | 'manager' | 'member' | 'viewer'
  /** Verified by the product's consent route; required when authority changes. */
  verifyConsent?: (revision: ProfileRevision) => Promise<boolean>
}): Promise<ProfileRevision> {
  if (input.actorRole !== 'owner' && input.actorRole !== 'manager') {
    throw new ProfileAccessError('Only an owner or manager can promote a profile')
  }
  const [revision, head] = await Promise.all([
    input.store.getRevision(input.workspaceId, input.profileId, input.revisionId),
    input.store.getActiveRevision(input.workspaceId, input.profileId),
  ])
  if (!revision || revision.parentId !== (head?.id ?? null)) throw new ProfileConflictError('Profile parent changed')
  if (revision.authorityDigest !== head?.authorityDigest &&
      (!input.verifyConsent || !await input.verifyConsent(revision))) {
    throw new ProfileAccessError('Authority changes require owner consent')
  }
  if (!await input.store.promoteRevision(input.workspaceId, input.profileId, revision.id, head?.id ?? null)) {
    throw new ProfileConflictError('The profile changed while promoting')
  }
  return revision
}

export function parseProfileSwitch(text: string): { name: string } | { invalid: true } | null {
  const trimmed = text.trim()
  if (!/^switch\s+to\b/i.test(trimmed)) return null
  const match = /^switch[ \t]+to[ \t]+([^\r\n]+)$/i.exec(trimmed)
  return match?.[1]?.trim() ? { name: match[1].trim() } : { invalid: true }
}

export function normalizeProfileName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

export interface SwitchableProfile {
  id: string
  name: string
  status: 'active' | 'draft' | 'paused'
}

export interface SwitchProfileInput {
  store: ProfileRevisionStore
  key: ProfileBindingKey
  messageId: string
  content: string
  choice: { name: string } | { profileId: string }
  profiles: readonly SwitchableProfile[]
  /** Product's role/phone allowlist decision for the authenticated member. */
  canSelect: (profileId: string) => Promise<boolean>
  /** Stage a complete managed plan for the same conversation; never mutate live workspace files. */
  prepareAuthority: (revision: ProfileRevision, key: ProfileBindingKey) => Promise<{
    planDigest: string; healthy: true; conflicts: string[]
  }>
}

/** The picker and deterministic text command converge here. Models cannot call it. */
export async function switchProfile(input: SwitchProfileInput): Promise<ProfileSwitchReceipt> {
  const inputHash = sha256Utf8(input.content)
  const previousReceipt = await input.store.getSwitchReceipt(input.key, input.messageId, inputHash)
  if (previousReceipt) return previousReceipt
  const binding = await input.store.getBinding(input.key)
  const choice = input.choice
  const matches = 'name' in choice
    ? input.profiles.filter(profile => normalizeProfileName(profile.name) === normalizeProfileName(choice.name))
    : input.profiles.filter(profile => profile.id === choice.profileId)
  const target = matches.length === 1 ? matches[0] : undefined
  let revision: ProfileRevision | null = null
  if (target?.status === 'active' && await input.canSelect(target.id)) {
    revision = await input.store.getActiveRevision(input.key.workspaceId, target.id)
    if (revision && 'name' in choice &&
        normalizeProfileName(revision.profile.name ?? '') !== normalizeProfileName(choice.name)) {
      revision = null
    }
  }
  let outcome: ProfileSwitchReceipt['outcome'] = 'refused'
  let message = matches.length > 1 ? 'That profile name is ambiguous.'
    : target?.status !== 'active' && target ? `${target.name} is not active.`
    : 'That profile is not available for this member.'
  let planDigest: string | null = null
  let conflicts: string[] = []
  if (revision && target) {
    const admission = binding?.authorityDigest === revision.authorityDigest
      ? PROFILE_CHANGE_POLICY.sameAuthoritySwitch.admission
      : PROFILE_CHANGE_POLICY.differentAuthoritySwitch.admission
    if (admission === 'prepare-then-flip' || binding?.planDigest !== revision.planDigest) {
      try {
        const prepared = await input.prepareAuthority(revision, input.key)
        if (!prepared.healthy || prepared.planDigest !== revision.planDigest) {
          throw new ProfileConflictError('The managed plan was not prepared for this revision')
        }
        planDigest = prepared.planDigest
        conflicts = prepared.conflicts
      } catch {
        revision = null
        message = `Could not prepare ${target.name}; your current agent is unchanged.`
      }
    } else {
      planDigest = binding.planDigest
    }
    if (revision && planDigest) {
      outcome = 'switched'
      message = `Now talking to ${target.name}`
    }
  }
  return input.store.recordSwitch({ key: input.key, messageId: input.messageId, inputHash,
    profileId: revision?.profileId ?? null, revisionId: revision?.id ?? null,
    pinnedRevisionId: null, authorityDigest: revision?.authorityDigest ?? null,
    planDigest, outcome, message, conflicts }, binding?.version ?? 0)
}

/** Call before dispatching a chat message; a recognized command is never sent to the model. */
export async function handleProfileSwitchText(
  input: Omit<SwitchProfileInput, 'choice'>,
): Promise<ProfileSwitchReceipt | null> {
  const parsed = parseProfileSwitch(input.content)
  if (!parsed) return null
  if ('name' in parsed) return switchProfile({ ...input, choice: parsed })
  const inputHash = sha256Utf8(input.content)
  const previous = await input.store.getSwitchReceipt(input.key, input.messageId, inputHash)
  if (previous) return previous
  const binding = await input.store.getBinding(input.key)
  return input.store.recordSwitch({ key: input.key, messageId: input.messageId, inputHash,
    profileId: null, revisionId: null, pinnedRevisionId: null, outcome: 'refused',
    authorityDigest: null, planDigest: null, conflicts: [],
    message: 'Send only “Switch to [agent name]” to change agents.' },
  binding?.version ?? 0)
}

/** One-step rollback moves this member/channel to its previous immutable revision. */
export async function rollbackProfileBinding(input: {
  store: ProfileRevisionStore
  key: ProfileBindingKey
  messageId: string
  actorRole: 'owner' | 'manager' | 'member' | 'viewer'
  canSelect: (profileId: string) => Promise<boolean>
  prepareAuthority: SwitchProfileInput['prepareAuthority']
}): Promise<ProfileSwitchReceipt> {
  if (input.actorRole !== 'owner' && input.actorRole !== 'manager') {
    throw new ProfileAccessError('Only an owner or manager can roll back a profile')
  }
  const inputHash = sha256Utf8(`rollback:${input.messageId}`)
  const prior = await input.store.getSwitchReceipt(input.key, input.messageId, inputHash)
  if (prior) return prior
  const binding = await input.store.getBinding(input.key)
  if (!binding || !await input.canSelect(binding.profileId)) throw new ProfileAccessError('Profile is unavailable')
  const current = binding.pinnedRevisionId
    ? await input.store.getRevision(input.key.workspaceId, binding.profileId, binding.pinnedRevisionId)
    : await input.store.getActiveRevision(input.key.workspaceId, binding.profileId)
  if (!current?.parentId) throw new ProfileConflictError('The bound profile has no previous revision')
  const parent = await input.store.getRevision(input.key.workspaceId, binding.profileId, current.parentId)
  if (!parent) throw new ProfileConflictError('The previous revision is unavailable')
  let planDigest = binding.planDigest
  let conflicts: string[] = []
  if (binding.authorityDigest !== parent.authorityDigest || binding.planDigest !== parent.planDigest) {
    try {
      const prepared = await input.prepareAuthority(parent, input.key)
      if (!prepared.healthy || prepared.planDigest !== parent.planDigest) {
        throw new ProfileConflictError('The prior managed plan was not prepared')
      }
      planDigest = prepared.planDigest
      conflicts = prepared.conflicts
    } catch {
      return input.store.recordSwitch({ key: input.key, messageId: input.messageId, inputHash,
        profileId: null, revisionId: null, pinnedRevisionId: null, outcome: 'refused',
        authorityDigest: null, planDigest: null, conflicts: [],
        message: 'Could not prepare the previous profile; your current agent is unchanged.' },
      binding.version)
    }
  }
  return input.store.recordSwitch({ key: input.key, messageId: input.messageId, inputHash,
    profileId: parent.profileId, revisionId: parent.id, pinnedRevisionId: parent.id,
    authorityDigest: parent.authorityDigest, planDigest, outcome: 'switched', conflicts,
    message: `Now talking to ${parent.profile.name ?? 'this profile'}` }, binding.version)
}

export async function admitProfileTurn(input: {
  store: ProfileRevisionStore
  key: ProfileBindingKey
  messageId: string
  content: string
  /** Effective ADC plan digest selected by the executor for this revision and turn. */
  observedManagedPlanDigest: string
  /** Required if trusted per-turn attachments change the public profile plan. */
  verifyEffectivePlan?: (revision: ProfileRevision, effectivePlanDigest: string,
    key: ProfileBindingKey) => Promise<boolean>
}): Promise<ProfileTurnPin> {
  const inputHash = sha256Utf8(input.content)
  const prior = await input.store.getTurnPin(input.key, input.messageId, inputHash)
  if (prior) return prior
  const binding = await input.store.getBinding(input.key)
  if (!binding) throw new ProfileAccessError('Choose a profile before sending a message')
  const revision = binding.pinnedRevisionId
    ? await input.store.getRevision(input.key.workspaceId, binding.profileId, binding.pinnedRevisionId)
    : await input.store.getActiveRevision(input.key.workspaceId, binding.profileId)
  if (!revision) throw new ProfileConflictError('The bound profile revision is unavailable')
  if (revision.authorityDigest !== binding.authorityDigest ||
      !/^sha256:[a-f0-9]{64}$/.test(input.observedManagedPlanDigest)) {
    throw new ProfileAccessError('The selected managed plan is not active for this turn')
  }
  const planMatches = revision.planDigest === input.observedManagedPlanDigest ||
    (input.verifyEffectivePlan !== undefined &&
      await input.verifyEffectivePlan(revision, input.observedManagedPlanDigest, input.key))
  if (!planMatches) {
    throw new ProfileAccessError('The selected managed plan is not active for this turn')
  }
  return input.store.pinTurn({ ...input.key, messageId: input.messageId, inputHash,
    profileId: revision.profileId, revisionId: revision.id,
    authorityDigest: revision.authorityDigest, planDigest: input.observedManagedPlanDigest }, binding.version)
}

const textChangeSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().max(2000).nullable().optional(),
  systemPrompt: z.string().max(32000).nullable().optional(),
  instructions: z.array(z.string().max(32000)).max(40).optional(),
  knowledgeText: z.string().max(32000).optional(),
}).strict().refine(changes => Object.keys(changes).length > 0)
const updateToolSchema = z.object({ expectedRevisionId: z.string().min(1), changes: textChangeSchema }).strict()

export function profileTextChange(revision: ProfileRevision, changes: z.infer<typeof textChangeSchema>): {
  profile: AgentProfile; knowledgeText: string
} {
  const profile = structuredClone(revision.profile)
  if (changes.name !== undefined) profile.name = changes.name
  if (changes.description !== undefined) profile.description = changes.description ?? undefined
  if (changes.systemPrompt !== undefined || changes.instructions !== undefined) {
    profile.prompt = { ...profile.prompt,
      ...(changes.systemPrompt !== undefined ? { systemPrompt: changes.systemPrompt ?? undefined } : {}),
      ...(changes.instructions !== undefined ? { instructions: changes.instructions } : {}) }
  }
  return { profile: snapshotAgentProfile(profile), knowledgeText: changes.knowledgeText ?? revision.knowledgeText }
}

export interface ProfileToolContext {
  /** Resolve the running turn from the trusted server session; never from tool arguments. */
  activeTurn(): Promise<{ workspaceId: string; profileId: string; revisionId: string;
    memberId: string; role: 'owner' | 'manager' | 'member' | 'viewer' }>
  /** Product computes the plan with ADC, returning `hashWorkspacePlan(plan)`. */
  planDigest(profile: AgentProfile, knowledgeText: string): Promise<string>
  store: ProfileRevisionStore
}

/** Shared self-edit tools; only the authenticated active turn can name the profile. */
export function profileTools(context: ProfileToolContext): McpToolDefinition<Record<string, never>>[] {
  return [{
    name: 'profile.read',
    description: 'Read the active agent profile text and revision. Saved text applies on the next message.',
    inputSchema: z.toJSONSchema(z.object({}).strict(), { io: 'input' }) as Record<string, unknown>,
    async run(args) {
      z.object({}).strict().parse(args)
      const turn = await context.activeTurn()
      if (turn.role !== 'owner' && turn.role !== 'manager') throw new ProfileAccessError('Profile management is required')
      const revision = await context.store.getActiveRevision(turn.workspaceId, turn.profileId)
      if (!revision) throw new ProfileConflictError('Profile revision is unavailable')
      return { profileId: turn.profileId, revisionId: revision.id, currentTurnRevisionId: turn.revisionId,
        name: revision.profile.name, description: revision.profile.description ?? null,
        systemPrompt: revision.profile.prompt?.systemPrompt ?? null,
        instructions: revision.profile.prompt?.instructions ?? [], knowledgeText: revision.knowledgeText }
    },
  }, {
    name: 'profile.update',
    description: 'Save a requested owner or manager text change with the revision from profile.read. Applies on the next message.',
    inputSchema: z.toJSONSchema(updateToolSchema, { io: 'input' }) as Record<string, unknown>,
    async run(args) {
      const { expectedRevisionId, changes } = updateToolSchema.parse(args)
      const turn = await context.activeTurn()
      if (turn.role !== 'owner' && turn.role !== 'manager') throw new ProfileAccessError('Profile management is required')
      const current = await context.store.getActiveRevision(turn.workspaceId, turn.profileId)
      if (!current || current.id !== expectedRevisionId) throw new ProfileConflictError('The profile changed; read it again')
      const next = profileTextChange(current, changes)
      const revision = await proposeRevision({ store: context.store, workspaceId: turn.workspaceId,
        profileId: turn.profileId, expectedRevisionId, ...next,
        planDigest: await context.planDigest(next.profile, next.knowledgeText),
        author: { kind: 'agent', id: turn.memberId }, actorRole: turn.role,
        reason: 'Owner or manager requested a text change during chat' })
      return { profileId: turn.profileId, revisionId: revision.id, state: revision.state,
        canonicalSaved: revision.state === 'active', appliesTo: 'next_message', currentTurn: 'unchanged' }
    },
  }]
}
