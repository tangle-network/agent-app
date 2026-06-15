/**
 * Unified skill + corpus mounter for agent products.
 *
 * Every agent product hand-rolls the same two file-mount systems and then
 * drifts on the seams between them. (1) An ALWAYS-MOUNTED markdown corpus —
 * (`skills/<slug>/SKILL.md`, `doctrine` and `knowledge` markdown trees) — discovered
 * by a Vite `?raw` glob in the Worker bundle and by Node `fs` under the eval
 * CLI, then projected into `resources.files`. (2) A TIER-GATED installable
 * registry — a hand-authored array of `SkillEntry` whose free tier mounts at
 * the harness skill-discovery path and whose paid tier is installed on demand.
 * Both ride the same `resources.files` channel but use different provenance
 * (file-backed vs inline), different mount paths (relative corpus path vs
 * `~/.claude/skills/<id>/SKILL.md`), and different selection rules. This module
 * makes both DATA: a corpus loader that accepts a Vite glob-result map (or an
 * fs fallback), a registry adapter that tier-gates, and a single
 * `composeShellResources` that projects either onto the SDK file-mount shape.
 *
 * Substrate-free over storage, exact over the SDK boundary: the only inbound
 * seam is the glob-result map the consumer passes in (its call site keeps the
 * literal `import.meta.glob` Vite must static-analyze); the only outbound seam
 * is `@tangle-network/sandbox`'s `AgentProfileFileMount[]`, the exact shape the
 * agent profile's `resources.files` consumes. Node builtins are resolved lazily
 * via `process.getBuiltinModule` so a static `node:*` import never reaches the
 * Vite SSR bundle.
 */

import type { AgentProfileFileMount, AgentProfileResourceRef } from '@tangle-network/sandbox'

/** Construct the inline arm of the SDK's `AgentProfileResourceRef`. Inlined here
 *  so this leaf subpath stays type-only over `@tangle-network/sandbox` — it
 *  carries no runtime dependency on the SDK, just its file-mount type contract. */
function inlineResource(name: string, content: string): AgentProfileResourceRef {
  return { kind: 'inline', name, content }
}

/** A Vite eager `?raw` glob result: glob key -> raw file body. The consumer
 *  produces this by calling `import.meta.glob('<lit>', { eager: true, query:
 *  '?raw', import: 'default' })` at its own call site — the literal must stay
 *  literal so Vite can static-analyze it; passing the result here keeps that
 *  constraint at the edge and the loader substrate-free. */
export type GlobModules = Record<string, string>

/** One markdown document discovered from the corpus. */
export interface CorpusEntry {
  /** Slug derived from the glob key (folder slug for `SKILL.md` layouts, or the
   *  normalized relative path for flat `*.md` layouts). */
  id: string
  /** Glob/fs key the entry was loaded from, normalized to a stable relative
   *  form (leading `./` and absolute prefixes stripped). */
  key: string
  /** Raw markdown body (including any frontmatter). */
  content: string
}

/** A hand-authored, tier-gated installable skill. Mirrors the per-product
 *  registry entry (gtm/insurance `SkillEntry`); the runtime's certified `skill`
 *  artifact kind is unrelated. `skillMd` is the inline body — file provenance
 *  does not apply to the registry. */
export interface SkillEntry {
  id: string
  name: string
  description: string
  author?: { name: string; url?: string }
  source?: string
  category?: string
  tags?: string[]
  /** Gate keyword. `composeShellResources`/`registrySkills` treat `free` as
   *  always-mounted; everything else is install-on-demand. */
  tier: string
  skillMd: string
}

/** Harness skill-discovery path the Claude Code / OpenCode backend reads
 *  natively. The registry mounts here; the corpus mounts at its relative path. */
export function skillMountPath(id: string): string {
  return `~/.claude/skills/${id}/SKILL.md`
}

/** Strip a glob/fs key down to a stable relative form: drop a leading `./`,
 *  and for an absolute fs path keep only the tail from the last anchor segment
 *  the pattern implies. We normalize on the trailing `<dir>/.../*.md` so the
 *  Vite key (`./skills/x/SKILL.md`) and the fs key (`/abs/.../skills/x/SKILL.md`)
 *  collapse to the same value. */
function normalizeKey(key: string, anchor: string): string {
  const marker = `${anchor}/`
  const at = key.lastIndexOf(marker)
  if (at >= 0) return key.slice(at)
  return key.startsWith('./') ? key.slice(2) : key
}

/** Folder-slug for a `<anchor>/<slug>/SKILL.md` layout; falls back to the
 *  normalized key (sans `<anchor>/` prefix, sans `.md`) for flat layouts. */
function toCorpusId(normalizedKey: string, anchor: string): string {
  const nested = normalizedKey.match(new RegExp(`${anchor}/([^/]+)/SKILL\\.md$`))
  if (nested) return nested[1]!
  const flat = normalizedKey.match(new RegExp(`${anchor}/(.+)\\.md$`))
  if (flat) return flat[1]!
  return normalizedKey
}

/** Resolve Node builtins lazily. `process.getBuiltinModule` (Node 22+) is
 *  absent in workerd, so this returns undefined there and the fs path is never
 *  taken — Workers always reach the loader through the Vite glob map. A static
 *  `import 'node:fs'` would break Vite SSR bundling in the consumer apps, so it
 *  is deliberately avoided. */
function nodeBuiltins():
  | { fs: typeof import('node:fs'); path: typeof import('node:path'); url: typeof import('node:url') }
  | undefined {
  const getBuiltin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } })
    .process?.getBuiltinModule
  if (typeof getBuiltin !== 'function') return undefined
  return {
    fs: getBuiltin('node:fs') as typeof import('node:fs'),
    path: getBuiltin('node:path') as typeof import('node:path'),
    url: getBuiltin('node:url') as typeof import('node:url'),
  }
}

/** Options for {@link loadMarkdownCorpus}. */
export interface LoadCorpusOptions {
  /** The anchor folder name that appears in both glob keys and fs paths
   *  (`skills`, `doctrine`, `knowledge`). Used to normalize keys + derive ids. */
  anchor: string
  /** Vite glob-result map. When present and non-empty it is authoritative and
   *  the fs path is skipped. Omit it (or pass an empty map) only outside Vite. */
  globModules?: GlobModules
  /** Absolute or `import.meta.url`-relative base dir the fs fallback walks when
   *  `globModules` is empty. Required for the fs path to run; without it the fs
   *  fallback returns no entries (Workers never need it). */
  fsBaseDir?: string
  /** Walk strategy for the fs fallback. `nested` finds `<dir>/<slug>/SKILL.md`
   *  one level deep; `flat` recurses for every `*.md`. Default: `flat`. */
  fsLayout?: 'nested' | 'flat'
  /** Drop an entry by its normalized key after load. Covers the per-product
   *  skip lists (corpus index/log files, scaffold templates, allow-lists). */
  skip?: (normalizedKey: string) => boolean
}

/** Outcome of {@link loadMarkdownCorpus}: the entries plus which path produced
 *  them, so a caller can fail loud when both are empty rather than silently
 *  mounting nothing. */
export interface CorpusLoadResult {
  source: 'vite' | 'fs' | 'empty'
  entries: CorpusEntry[]
}

function fsWalkFlat(
  builtins: NonNullable<ReturnType<typeof nodeBuiltins>>,
  root: string,
): GlobModules {
  const { fs, path } = builtins
  const out: GlobModules = {}
  if (!fs.existsSync(root)) return out
  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.md')) out[full] = fs.readFileSync(full, 'utf8')
    }
  }
  walk(root)
  return out
}

function fsWalkNested(
  builtins: NonNullable<ReturnType<typeof nodeBuiltins>>,
  root: string,
): GlobModules {
  const { fs, path } = builtins
  const out: GlobModules = {}
  if (!fs.existsSync(root)) return out
  let entries: import('node:fs').Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillFile = path.join(root, entry.name, 'SKILL.md')
    if (!fs.existsSync(skillFile)) continue
    out[skillFile] = fs.readFileSync(skillFile, 'utf8')
  }
  return out
}

/** Resolve `fsBaseDir` against `import.meta.url` when relative-looking, so a
 *  consumer can pass a bare folder name (`'skills'`) and have it land beside
 *  the calling module. Absolute paths pass through. */
function resolveFsBase(
  builtins: NonNullable<ReturnType<typeof nodeBuiltins>>,
  fsBaseDir: string,
  importMetaUrl?: string,
): string {
  const { path, url } = builtins
  if (path.isAbsolute(fsBaseDir)) return fsBaseDir
  const here = importMetaUrl
    ? path.dirname(url.fileURLToPath(importMetaUrl))
    : process.cwd()
  return path.join(here, fsBaseDir)
}

/**
 * Load a markdown corpus, preferring a Vite glob-result map and falling back to
 * a Node fs walk. Selection is by non-empty glob result — never an env flag.
 * Entries are normalized, optionally skip-filtered, and sorted by id for
 * determinism. The `import.meta.glob` literal stays at the CONSUMER call site
 * (passed in as `globModules`); this loader never constructs a glob.
 */
export function loadMarkdownCorpus(
  options: LoadCorpusOptions,
  importMetaUrl?: string,
): CorpusLoadResult {
  const { anchor, globModules, fsBaseDir, fsLayout = 'flat', skip } = options

  let modules: GlobModules
  let source: CorpusLoadResult['source']
  if (globModules && Object.keys(globModules).length > 0) {
    modules = globModules
    source = 'vite'
  } else {
    const builtins = nodeBuiltins()
    if (builtins && fsBaseDir) {
      const root = resolveFsBase(builtins, fsBaseDir, importMetaUrl)
      modules = fsLayout === 'nested' ? fsWalkNested(builtins, root) : fsWalkFlat(builtins, root)
      source = Object.keys(modules).length > 0 ? 'fs' : 'empty'
    } else {
      modules = {}
      source = 'empty'
    }
  }

  const entries: CorpusEntry[] = []
  for (const [rawKey, content] of Object.entries(modules)) {
    if (typeof content !== 'string') continue
    const key = normalizeKey(rawKey, anchor)
    if (skip && skip(key)) continue
    entries.push({ id: toCorpusId(key, anchor), key, content })
  }
  entries.sort((a, b) => a.id.localeCompare(b.id))
  return { source, entries }
}

/** Project corpus entries onto SDK file mounts at a relative path under
 *  `<anchor>/`. Always-mounted: the corpus is the agent's baseline knowledge. */
export function corpusSkills(corpus: CorpusEntry[], anchor: string): AgentProfileFileMount[] {
  return corpus
    .map(
      (entry) =>
        ({
          path: `${anchor}/${entry.id}.md`,
          resource: inlineResource(`${anchor}-${entry.id}`, entry.content),
        }) satisfies AgentProfileFileMount,
    )
    .sort((a, b) => a.path.localeCompare(b.path))
}

/** Project the registry's free-tier (or `tier`-matched) entries onto SDK file
 *  mounts at the harness skill-discovery path. Tier-gating is the registry's
 *  only selection rule — paid skills are installed on demand, not at boot. */
export function registrySkills(
  registry: SkillEntry[],
  tier: string = 'free',
): AgentProfileFileMount[] {
  return registry
    .filter((s) => s.tier === tier)
    .map(
      (s) =>
        ({
          path: skillMountPath(s.id),
          resource: inlineResource(s.id, s.skillMd),
        }) satisfies AgentProfileFileMount,
    )
    .sort((a, b) => a.path.localeCompare(b.path))
}

/** Inputs to {@link composeShellResources}. Each channel is optional so a
 *  product mounts only the systems it has — corpus-only, registry-only, or
 *  both — without conflating them. */
export interface ComposeShellResourcesInput {
  /** Corpus mounts (always-mounted baseline). Pass the result of
   *  {@link corpusSkills}, or a hand-built mount list. */
  skills?: AgentProfileFileMount[]
  /** Knowledge-corpus mounts (a second always-mounted corpus, e.g. a domain
   *  knowledge pack distinct from the skills corpus). */
  knowledge?: AgentProfileFileMount[]
  /** Evolvable / learned-guidance mounts (single-file corpora). */
  evolvable?: AgentProfileFileMount[]
  /** Registry mounts (tier-gated). Pass the result of {@link registrySkills}. */
  registry?: AgentProfileFileMount[]
  /** Final skip filter applied to the composed mount list by mount `path`. */
  predicate?: (mount: AgentProfileFileMount) => boolean
}

/**
 * Compose every mount channel into one `resources.files`-ready array. Corpus
 * channels come first (baseline), the tier-gated registry last (so a registry
 * entry can override a corpus entry that mounts at the same path). The result
 * is exactly `AgentProfileFileMount[]` — assign it straight into
 * `profile.resources.files` with no cast.
 */
export function composeShellResources(input: ComposeShellResourcesInput): AgentProfileFileMount[] {
  const { skills = [], knowledge = [], evolvable = [], registry = [], predicate } = input
  const composed = [...skills, ...knowledge, ...evolvable, ...registry]
  return predicate ? composed.filter(predicate) : composed
}
