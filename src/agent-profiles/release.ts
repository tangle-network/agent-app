/**
 * A stored profile runs the current product release plus its own changes.
 *
 * Revisions are complete AgentProfile snapshots, so a workspace's import carries a copy of the product text current
 * when it was made, and that copy goes stale with the next release. A turn resolves the stored profile over the
 * release serving it: text equal to a version the product shipped (the release's own, or one in the workspace's
 * history) is product text and runs as the release's; text that matches no shipped version is the workspace's own
 * and stays. Nothing stored is rewritten.
 *
 * Only `prompt.systemPrompt` follows a release. No product profile ships `prompt.instructions` (2026-11-15: Creative,
 * Legal, Hardware, Tax and GTM set only the system prompt there); instructions in a stored revision are a person's.
 */
import { canonicalCandidateDigest, snapshotAgentProfile, type AgentProfile } from '@tangle-network/agent-interface'
import type { ProfilePromptHistoryEntry, ProfileRevision, ProfileRevisionStore } from './index'

type SkillRef = NonNullable<NonNullable<AgentProfile['resources']>['skills']>[number]
type Specialist = NonNullable<AgentProfile['subagents']>[string]
type IsProductAuthor = (author: ProfileRevision['author']) => boolean

/** How a stored profile's text compares with the current release; `customized` text is the workspace's own and stays. */
export interface ProfileReleaseUpdates {
  systemPrompt: 'current' | 'outdated' | 'customized'
  specialists: { updated: string[]; customized: string[] }
  skills: {
    added: string[]
    updated: string[]
    removed: string[]
    /** Built-in skills this workspace edited; they stay as they are. */
    customized: string[]
  }
}

/** The longest history read; a longer one reads as incomplete, so its prompt is kept. */
export const PROFILE_PROMPT_HISTORY_MAX = 500

const skillName = (skill: SkillRef) => skill.name ?? (skill.kind === 'github' ? skill.path : '')
const digest = (value: unknown) => canonicalCandidateDigest(value ?? null)

/**
 * The active profile's skills with built-ins brought to the release. A built-in counts as untouched while it
 * matches a version the product shipped (`shipped`); edited built-ins and workspace skills are kept.
 */
export function refreshBuiltinSkills(active: AgentProfile, shipped: readonly SkillRef[], release: AgentProfile):
  { skills: SkillRef[]; updates: ProfileReleaseUpdates['skills'] } {
  const current = release.resources?.skills ?? []
  const currentByName = new Map(current.map(skill => [skillName(skill), skill]))
  const shippedNames = new Set(shipped.map(skillName))
  const shippedDigests = new Set(shipped.map(digest))
  const updates: ProfileReleaseUpdates['skills'] = { added: [], updated: [], removed: [], customized: [] }
  const skills: SkillRef[] = []
  for (const skill of active.resources?.skills ?? []) {
    const name = skillName(skill)
    const next = currentByName.get(name)
    const builtin = next !== undefined || shippedNames.has(name)
    if (!builtin || (next && digest(skill) === digest(next))) { skills.push(skill); continue }
    if (!shippedDigests.has(digest(skill))) { updates.customized.push(name); skills.push(skill); continue }
    if (next) { updates.updated.push(name); skills.push(next) } else updates.removed.push(name)
  }
  const present = new Set(skills.map(skillName))
  for (const skill of current) {
    if (present.has(skillName(skill))) continue
    updates.added.push(skillName(skill))
    skills.push(skill)
  }
  return { skills, updates }
}

/**
 * Resolve a stored profile over the release. `shipped` holds every complete profile the product delivered to this
 * workspace (its import and each release refresh). The system prompt, specialists, built-in skills and every
 * executable control come from the release; the workspace keeps the text it wrote.
 */
export function overlayOnRelease(stored: AgentProfile, shipped: readonly AgentProfile[], release: AgentProfile):
  { profile: AgentProfile; updates: ProfileReleaseUpdates } {
  const product = [release, ...shipped]
  const storedPrompt = stored.prompt?.systemPrompt
  const promptCustomized = storedPrompt !== undefined && !product.some(profile => profile.prompt?.systemPrompt === storedPrompt)
  const systemPrompt = promptCustomized ? storedPrompt : release.prompt?.systemPrompt
  const instructions = stored.prompt?.instructions

  const subagents: Record<string, Specialist> = { ...release.subagents }
  const specialists: ProfileReleaseUpdates['specialists'] = { updated: [], customized: [] }
  for (const [id, mine] of Object.entries(stored.subagents ?? {})) {
    const versions = product.map(profile => profile.subagents?.[id]).filter((value): value is Specialist => value !== undefined)
    const ownPrompt = mine.prompt !== undefined && !versions.some(version => version.prompt === mine.prompt)
    const ownDescription = mine.description !== undefined && !versions.some(version => version.description === mine.description)
    const next = release.subagents?.[id]
    if (ownPrompt || ownDescription) {
      specialists.customized.push(id)
      subagents[id] = { ...(next ?? mine),
        ...(ownPrompt ? { prompt: mine.prompt } : {}), ...(ownDescription ? { description: mine.description } : {}) }
    } else if (next && (next.prompt !== mine.prompt || next.description !== mine.description)) specialists.updated.push(id)
  }

  const { skills, updates: skillUpdates } = refreshBuiltinSkills(stored,
    shipped.flatMap(profile => profile.resources?.skills ?? []), release)
  const releaseFiles = release.resources?.files ?? []
  const releasePaths = new Set(releaseFiles.map(file => file.path))
  const files = [...releaseFiles, ...(stored.resources?.files ?? []).filter(file => !releasePaths.has(file.path))]

  const prompt = { ...release.prompt,
    ...(systemPrompt === undefined ? {} : { systemPrompt }), ...(instructions === undefined ? {} : { instructions }) }
  if (systemPrompt === undefined) delete prompt.systemPrompt
  const profile = snapshotAgentProfile({ ...release,
    ...(stored.name === undefined ? {} : { name: stored.name }),
    ...(stored.description === undefined ? {} : { description: stored.description }),
    ...(Object.keys(prompt).length ? { prompt } : {}),
    ...(Object.keys(subagents).length ? { subagents } : {}),
    resources: { ...release.resources, skills, ...(files.length ? { files } : {}) },
  })
  return { profile, updates: {
    systemPrompt: promptCustomized ? 'customized' : storedPrompt === release.prompt?.systemPrompt ? 'current' : 'outdated',
    specialists, skills: skillUpdates,
  } }
}

async function promptHistory(store: ProfileRevisionStore, revision: ProfileRevision): Promise<ProfilePromptHistoryEntry[]> {
  if (store.readPromptHistory) return store.readPromptHistory(revision.workspaceId, revision.profileId, revision.id)
  const history: ProfilePromptHistoryEntry[] = []
  for (let current: ProfileRevision | null = revision; current && history.length < PROFILE_PROMPT_HISTORY_MAX;) {
    history.push({ id: current.id, parentId: current.parentId, author: current.author,
      systemPrompt: current.profile.prompt?.systemPrompt ?? null })
    current = current.parentId ? await store.getRevision(revision.workspaceId, revision.profileId, current.parentId) : null
  }
  return history
}

/**
 * The system prompts the product wrote into a revision's history: each revision by a product author whose prompt
 * differs from its parent's (an import, or a release refresh). A product revision that carries its parent's prompt
 * forward ships nothing, so a person's text a release copied stays theirs. `null` when the history is incomplete
 * (a missing ancestor, or a longer history than `PROFILE_PROMPT_HISTORY_MAX`): no prompt in it is then shown to be
 * the product's.
 */
export async function shippedSystemPrompts(store: ProfileRevisionStore, revision: ProfileRevision,
  isProductAuthor: IsProductAuthor): Promise<string[] | null> {
  const history = await promptHistory(store, revision)
  const shipped: string[] = []
  for (const [index, entry] of history.entries()) {
    const parent = history[index + 1]
    if (entry.parentId !== null && parent?.id !== entry.parentId) return null
    if (entry.systemPrompt !== null && isProductAuthor(entry.author) &&
        (entry.parentId === null || parent?.systemPrompt !== entry.systemPrompt)) shipped.push(entry.systemPrompt)
  }
  return shipped
}

/** Per product-author rule, whether a revision's stored prompt is product text. Revisions and their history are
 *  immutable, so an answer never changes. */
const productPromptRevisions = new WeakMap<IsProductAuthor, Map<string, boolean>>()
const PRODUCT_PROMPT_REVISIONS_MAX = 10_000

/**
 * The profile a turn runs for `revision`: the stored profile with the release's system prompt where the stored prompt
 * is one the product shipped into its history (`shippedSystemPrompts`) or absent; unchanged, and returned as is,
 * where a person wrote it. Only the system prompt moves; authority, name, description and instructions stay. The
 * history is read once per revision and isolate, in one round trip on the D1 store, and not at all when the stored
 * prompt already is the release's. A plan digest computed from the result moves with each release, so a product's
 * `verifyEffectivePlan` must compute it from this function's result too.
 */
export async function followProductRelease(store: ProfileRevisionStore, revision: ProfileRevision,
  release: AgentProfile, isProductAuthor: IsProductAuthor): Promise<AgentProfile> {
  const stored = revision.profile
  const storedPrompt = stored.prompt?.systemPrompt
  const releasePrompt = release.prompt?.systemPrompt
  if (storedPrompt === releasePrompt) return stored
  if (storedPrompt !== undefined) {
    let decisions = productPromptRevisions.get(isProductAuthor)
    if (!decisions) productPromptRevisions.set(isProductAuthor, decisions = new Map())
    const key = `${revision.workspaceId}\0${revision.profileId}\0${revision.id}`
    let product = decisions.get(key)
    if (product === undefined) {
      product = (await shippedSystemPrompts(store, revision, isProductAuthor))?.includes(storedPrompt) ?? false
      decisions.set(key, product)
      const oldest = decisions.keys().next().value
      if (decisions.size > PRODUCT_PROMPT_REVISIONS_MAX && oldest !== undefined) decisions.delete(oldest)
    }
    if (!product) return stored
  }
  const { systemPrompt: _stored, ...rest } = stored.prompt ?? {}
  const prompt = releasePrompt === undefined ? rest : { ...rest, systemPrompt: releasePrompt }
  const { prompt: _prompt, ...profile } = stored
  return snapshotAgentProfile(Object.keys(prompt).length ? { ...profile, prompt } : profile)
}
