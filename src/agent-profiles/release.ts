/**
 * A stored profile runs the current product release plus its own changes.
 *
 * Revisions are complete AgentProfile snapshots, so a workspace's import carries a copy of the product text current
 * when it was made, and that copy goes stale with the next release. A turn resolves the stored profile over the
 * release serving it: text equal to a version the product shipped (the release's own, or one in `shipped`) is
 * product text and runs as the release's; text that matches no shipped version is the workspace's own and stays.
 * Nothing stored is rewritten.
 */
import { canonicalCandidateDigest, snapshotAgentProfile, type AgentProfile } from '@tangle-network/agent-interface'
import type { ProfileRevision, ProfileRevisionStore } from './index'

type SkillRef = NonNullable<NonNullable<AgentProfile['resources']>['skills']>[number]
type Specialist = NonNullable<AgentProfile['subagents']>[string]

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

const skillName = (skill: SkillRef) => skill.name ?? (skill.kind === 'github' ? skill.path : '')
const digest = (value: unknown) => canonicalCandidateDigest(value ?? null)

/** The system prompt a turn runs: the release's where the stored one is product text, otherwise the stored one. */
function promptOnRelease(stored: AgentProfile, shipped: readonly AgentProfile[], release: AgentProfile) {
  const storedPrompt = stored.prompt?.systemPrompt
  const customized = storedPrompt !== undefined &&
    ![release, ...shipped].some(profile => profile.prompt?.systemPrompt === storedPrompt)
  return {
    systemPrompt: customized ? storedPrompt : release.prompt?.systemPrompt,
    state: customized ? 'customized' as const : storedPrompt === release.prompt?.systemPrompt ? 'current' as const : 'outdated' as const,
  }
}

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
 * Resolve a stored profile over the release. `shipped` holds every profile the product delivered to this workspace
 * (its import and each release refresh). The system prompt, specialists, built-in skills and every executable
 * control come from the release; the workspace keeps the text it wrote.
 */
export function overlayOnRelease(stored: AgentProfile, shipped: readonly AgentProfile[], release: AgentProfile):
  { profile: AgentProfile; updates: ProfileReleaseUpdates } {
  const product = [release, ...shipped]
  const { systemPrompt, state } = promptOnRelease(stored, shipped, release)
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
  return { profile, updates: { systemPrompt: state, specialists, skills: skillUpdates } }
}

/**
 * Every profile the product wrote into a revision's history: each revision `isProductRevision` accepts whose system
 * prompt differs from its parent's (an import, or a release refresh). A product revision that carries its parent's
 * prompt forward ships nothing, so a person's text a release copied stays theirs. A missing ancestor ends the walk.
 */
export async function shippedProfileRevisions(store: ProfileRevisionStore, revision: ProfileRevision,
  isProductRevision: (revision: ProfileRevision) => boolean): Promise<AgentProfile[]> {
  const shipped: AgentProfile[] = []
  for (let current: ProfileRevision | null = revision; current;) {
    const parent: ProfileRevision | null = current.parentId
      ? await store.getRevision(current.workspaceId, current.profileId, current.parentId) : null
    if (isProductRevision(current) && (!parent || parent.profile.prompt?.systemPrompt !== current.profile.prompt?.systemPrompt)) {
      shipped.push(current.profile)
    }
    current = parent
  }
  return shipped
}

/** Revision ids whose stored prompt is product text. A revision and its history are immutable, so this never changes. */
const productPromptRevisions = new Map<string, boolean>()
const PRODUCT_PROMPT_REVISIONS_MAX = 10_000

/**
 * The profile a turn runs for `revision`: the stored profile with the release's system prompt where the stored
 * prompt is one the product shipped into its history (`shippedProfileRevisions`), unchanged where a person wrote it.
 * Only the system prompt moves; the stored authority, name, description and instructions stay. The history walk
 * runs once per revision and isolate, and not at all when the stored prompt is already the release's.
 */
export async function followProductRelease(store: ProfileRevisionStore, revision: ProfileRevision,
  release: AgentProfile, isProductRevision: (revision: ProfileRevision) => boolean): Promise<AgentProfile> {
  const stored = revision.profile
  const releasePrompt = release.prompt?.systemPrompt
  if (stored.prompt?.systemPrompt === undefined || stored.prompt.systemPrompt === releasePrompt) return stored
  const key = `${revision.workspaceId}\0${revision.profileId}\0${revision.id}`
  let product = productPromptRevisions.get(key)
  if (product === undefined) {
    product = promptOnRelease(stored, await shippedProfileRevisions(store, revision, isProductRevision), release).state !== 'customized'
    productPromptRevisions.set(key, product)
    const oldest = productPromptRevisions.keys().next().value
    if (productPromptRevisions.size > PRODUCT_PROMPT_REVISIONS_MAX && oldest !== undefined) productPromptRevisions.delete(oldest)
  }
  if (!product) return stored
  const prompt = { ...stored.prompt, systemPrompt: releasePrompt }
  if (releasePrompt === undefined) delete prompt.systemPrompt
  return snapshotAgentProfile({ ...stored, prompt })
}
