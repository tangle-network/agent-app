/**
 * Delivery of a profile's declared skill corpus onto a running box.
 *
 * The platform materializer is add-or-skip-identical only: it refuses to
 * replace a `SKILL.md` whose content changed and never removes a skill dropped
 * from a later selection. Products edit skill bodies on deploy while boxes live
 * for hours, so this reconcile supplies replace-on-change and prune-on-removal,
 * keyed on a content manifest on the box so an unchanged corpus transfers no
 * bodies. `resolveSkillDir` decides the directory; no path literal lives here.
 *
 * The SDK file API replaces complete files, so identical concurrent reconciles
 * converge without a lock; a concurrent stale delete may return not found.
 */
import type { AgentProfileFileMount, AgentProfileResourceRef } from '@tangle-network/agent-interface'
import { NotFoundError, type SandboxInstance } from '@tangle-network/sandbox'
import type { Harness } from '../harness/index'
import type { Outcome } from '../sandbox/outcome'
import { writeProfileFilesToBox } from '../sandbox/profile-files'
import { shellQuote } from '../sandbox/binary-read'
import { resolveSkillDir } from './index'
import { sha256Hex } from '../crypto/digest'

interface DeclaredSkill {
  id: string
  content: string
}

interface SkillCorpusManifest {
  schema: string
  hash: string
  ids: string[]
}

const SKILL_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PLACED_CORPORA_LIMIT = 512

export interface ProfileSkillPlacerConfig {
  /** Manifest schema id written on the box, e.g. `acme-skill-corpus-v1`.
   *  Changing it makes every box re-place its corpus once. */
  manifestSchema: string
  /** Home-relative directory holding one manifest per harness, e.g. `~/.tangle/acme-skill-corpora`. */
  manifestDir: string
  /** Resource name prefix for the manifest file mount, e.g. `acme` gives `<harness>-acme-skill-manifest`. */
  manifestName: string
  /**
   * The box filesystem's identity, when the product can read it. With it, a
   * corpus this isolate already placed on the same filesystem skips the
   * on-box manifest read entirely; a replaced filesystem has a new id, so its
   * receipt never matches. Return null when the filesystem is not identified.
   */
  filesystemIncarnation?: (box: SandboxInstance) => string | null
  /**
   * Serialize placement on the box with a `mkdir` lock beside the manifest
   * (30 s wait, a lock older than 2 minutes is reclaimed). Without it, two
   * isolates placing different corpora at once (a rolling deploy) can leave a
   * manifest that names a skill the other one pruned.
   */
  boxLock?: boolean
}

function homeRelative(path: string): string {
  if (!path.startsWith('~/')) throw new Error(`Expected a home-relative path, got ${path}`)
  return path.slice(2)
}

function shellHomePath(path: string): string {
  return `~/${shellQuote(homeRelative(path))}`
}

async function acquireBoxLock(box: SandboxInstance, manifestDir: string, lockPath: string): Promise<Outcome<void>> {
  const command = [
    `mkdir -p ${shellHomePath(manifestDir)}`,
    `lock=${shellHomePath(lockPath)}`,
    'deadline=$(( $(date +%s) + 30 ))',
    'while ! mkdir "$lock" 2>/dev/null; do',
    '  now=$(date +%s)',
    '  if [ -n "$(find "$lock" -maxdepth 0 -mmin +2 -print 2>/dev/null)" ]; then rm -rf "$lock"; continue; fi',
    '  if [ "$now" -ge "$deadline" ]; then echo "timed out waiting for skill placement lock" >&2; exit 42; fi',
    '  sleep 0.1',
    'done',
  ].join('\n')
  try {
    const acquired = await box.exec(command)
    if (acquired.exitCode === 0) return { succeeded: true, value: undefined }
    return { succeeded: false, error: new Error(`placeProfileSkillsOnBox: ${acquired.stderr || 'failed to acquire skill placement lock'}`) }
  } catch (error) {
    return { succeeded: false, error: new Error('placeProfileSkillsOnBox: failed to acquire the skill placement lock', { cause: error }) }
  }
}

async function releaseBoxLock(box: SandboxInstance, lockPath: string): Promise<Outcome<void>> {
  try {
    const released = await box.exec(`rm -rf ${shellHomePath(lockPath)}`)
    if (released.exitCode === 0) return { succeeded: true, value: undefined }
    return { succeeded: false, error: new Error(`placeProfileSkillsOnBox: failed to release skill placement lock: ${released.stderr}`) }
  } catch (error) {
    return { succeeded: false, error: new Error('placeProfileSkillsOnBox: failed to release the skill placement lock', { cause: error }) }
  }
}

/** `null` when any ref is not an inline body: a github ref needs async
 *  pre-resolution, which the platform materializer also refuses. */
function declaredSkills(refs: readonly AgentProfileResourceRef[]): DeclaredSkill[] | null {
  const skills: DeclaredSkill[] = []
  for (const ref of refs) {
    if (ref.kind !== 'inline') return null
    skills.push({ id: ref.name, content: ref.content })
  }
  return skills
}

function skillFileMounts(root: string, skills: readonly DeclaredSkill[]): AgentProfileFileMount[] {
  return skills.map((skill) => ({
    path: `~/${root}/${skill.id}/SKILL.md`,
    resource: { kind: 'inline' as const, name: skill.id, content: skill.content },
  }))
}

/**
 * Build the product's skill placer. `placeProfileSkillsOnBox` makes the box's
 * skill directory for a harness match the declared corpus exactly: every
 * declared body present, every previously placed body no longer declared
 * removed. Empty `refs`, or a harness with no skill directory, is a no-op.
 */
export function createProfileSkillPlacer(config: ProfileSkillPlacerConfig) {
  const { manifestSchema, manifestDir, manifestName, filesystemIncarnation, boxLock = false } = config

  // Corpora this isolate placed or verified, by box, filesystem and harness. Digests only.
  const placedCorpora = new Map<string, string>()
  // A composed corpus is one cached array per harness, so its digest is too.
  const corpusManifests = new WeakMap<readonly AgentProfileResourceRef[], Promise<SkillCorpusManifest>>()

  async function skillManifest(skills: readonly DeclaredSkill[]): Promise<SkillCorpusManifest> {
    const normalized = [...skills].sort((a, b) => a.id.localeCompare(b.id))
    return {
      schema: manifestSchema,
      hash: await sha256Hex(JSON.stringify(normalized)),
      ids: normalized.map((skill) => skill.id),
    }
  }

  function corpusManifest(refs: readonly AgentProfileResourceRef[], skills: readonly DeclaredSkill[]) {
    let manifest = corpusManifests.get(refs)
    if (!manifest) {
      manifest = skillManifest(skills)
      manifest.catch(() => corpusManifests.delete(refs))
      corpusManifests.set(refs, manifest)
    }
    return manifest
  }

  function parseSkillManifest(raw: string): SkillCorpusManifest | null {
    try {
      const value = JSON.parse(raw) as Partial<SkillCorpusManifest>
      if (value.schema !== manifestSchema || typeof value.hash !== 'string') return null
      if (!Array.isArray(value.ids) || value.ids.some((id) => typeof id !== 'string' || !SKILL_ID_RE.test(id))) return null
      return { schema: manifestSchema, hash: value.hash, ids: value.ids }
    } catch {
      return null
    }
  }

  function receiptKey(box: SandboxInstance, harness: Harness): string | null {
    const incarnation = filesystemIncarnation?.(box)
    return box.id && incarnation ? `${box.id}\0${incarnation}\0${harness}` : null
  }

  function recordPlacement(key: string | null, hash: string): void {
    if (!key) return
    if (placedCorpora.size >= PLACED_CORPORA_LIMIT) placedCorpora.clear()
    placedCorpora.set(key, hash)
  }

  async function placeSkills(
    box: SandboxInstance,
    harness: Harness,
    root: string,
    skills: readonly DeclaredSkill[],
    expected: SkillCorpusManifest,
  ): Promise<Outcome<void>> {
    const markerPath = `${manifestDir}/${harness}.json`
    let current: SkillCorpusManifest | null = null
    try {
      current = parseSkillManifest(await box.fs.read(homeRelative(markerPath)))
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        return {
          succeeded: false,
          error: new Error('placeProfileSkillsOnBox: failed to read the sandbox skill manifest', { cause: err }),
        }
      }
    }
    if (current?.hash === expected.hash) return { succeeded: true, value: undefined }

    const written = await writeProfileFilesToBox(box, skillFileMounts(root, skills))
    if (!written.succeeded) {
      return {
        succeeded: false,
        error: new Error('placeProfileSkillsOnBox: failed to write the sandbox skill corpus', { cause: written.error }),
      }
    }

    const expectedIds = new Set(expected.ids)
    for (const id of (current?.ids ?? []).filter((id) => !expectedIds.has(id))) {
      try {
        await box.fs.delete(homeRelative(`~/${root}/${id}`), { recursive: true })
      } catch (err) {
        // Another identical reconcile may have removed it first; any other failure stays visible.
        if (err instanceof NotFoundError) continue
        return {
          succeeded: false,
          error: new Error('placeProfileSkillsOnBox: stale skill cleanup failed', { cause: err }),
        }
      }
    }

    const manifestWritten = await writeProfileFilesToBox(box, [{
      path: markerPath,
      resource: { kind: 'inline', name: `${harness}-${manifestName}-skill-manifest`, content: JSON.stringify(expected) },
    }])
    if (!manifestWritten.succeeded) {
      return {
        succeeded: false,
        error: new Error('placeProfileSkillsOnBox: failed to write the sandbox skill manifest', { cause: manifestWritten.error }),
      }
    }
    return { succeeded: true, value: undefined }
  }

  async function placeProfileSkillsOnBox(
    box: SandboxInstance,
    harness: Harness,
    refs: readonly AgentProfileResourceRef[],
  ): Promise<Outcome<void>> {
    const root = resolveSkillDir(harness)
    if (!root || refs.length === 0) return { succeeded: true, value: undefined }

    const skills = declaredSkills(refs)
    if (!skills) {
      return { succeeded: false, error: new Error('placeProfileSkillsOnBox: every declared skill ref must be an inline body') }
    }
    const ids = skills.map((skill) => skill.id)
    if (ids.some((id) => !SKILL_ID_RE.test(id)) || new Set(ids).size !== ids.length) {
      return { succeeded: false, error: new Error('placeProfileSkillsOnBox: skill ids must be unique path-safe slugs') }
    }

    let expected: SkillCorpusManifest
    try {
      expected = await corpusManifest(refs, skills)
    } catch (err) {
      return {
        succeeded: false,
        error: new Error('placeProfileSkillsOnBox: failed to hash the declared skill corpus', { cause: err }),
      }
    }

    const key = receiptKey(box, harness)
    if (key && placedCorpora.get(key) === expected.hash) return { succeeded: true, value: undefined }
    if (!boxLock) {
      const placed = await placeSkills(box, harness, root, skills, expected)
      if (placed.succeeded) recordPlacement(key, expected.hash)
      return placed
    }
    const lockPath = `${manifestDir}/${harness}.json.lock`
    const acquired = await acquireBoxLock(box, manifestDir, lockPath)
    if (!acquired.succeeded) return acquired
    const placed = await placeSkills(box, harness, root, skills, expected)
    const released = await releaseBoxLock(box, lockPath)
    if (placed.succeeded && released.succeeded) recordPlacement(key, expected.hash)
    return released.succeeded ? placed : released
  }

  /** Whether two skill declarations carry the same inline corpus. */
  async function sameSkillCorpus(
    left: readonly AgentProfileResourceRef[] | undefined,
    right: readonly AgentProfileResourceRef[],
  ): Promise<boolean> {
    if (!left) return right.length === 0
    if (left === right) return true
    const leftSkills = declaredSkills(left)
    const rightSkills = declaredSkills(right)
    if (!leftSkills || !rightSkills) return false
    const [a, b] = await Promise.all([corpusManifest(left, leftSkills), corpusManifest(right, rightSkills)])
    return a.hash === b.hash
  }

  return { placeProfileSkillsOnBox, sameSkillCorpus }
}
