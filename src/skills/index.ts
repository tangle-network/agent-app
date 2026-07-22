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
 * A THIRD surface lives alongside those two: adoptable `SkillEntry`s sourced
 * from `SKILL.md` frontmatter rather than hand-authored fields.
 * `parseSkillFrontmatter` is the ONE frontmatter parser (hand-rolled, no YAML
 * dependency — fail loud on a malformed block rather than silently mis-reading
 * a field); `skillEntryFromMarkdown`/`parseCorpusSkills` turn raw markdown into
 * `SkillEntry`s. From there a skill reaches the agent by one of two DELIVERY
 * MODES: `inline` renders the skill body straight into the system prompt (every
 * harness can read it, at prompt-byte cost), or `mounted` projects it onto the
 * typed `resources.skills` channel (`AgentProfileResourceRef[]`) plus an index
 * section that just names the file, and lets the platform materializer place it
 * at the harness-native skill dir. `composeSkills` builds either shape;
 * `assertSkillDeliveryDisjoint` catches a skill accidentally delivered both
 * ways. Picking WHICH harnesses can take `mounted` delivery is platform-bound
 * (see `@tangle-network/agent-app/skills-placement`) and deliberately kept out
 * of this substrate-free module.
 *
 * Substrate-free over storage, exact over the SDK boundary: the only inbound
 * seam is the glob-result map the consumer passes in (its call site keeps the
 * literal `import.meta.glob` Vite must static-analyze); the only outbound seam
 * is `@tangle-network/sandbox`'s `AgentProfileFileMount[]`/`AgentProfileResourceRef[]`,
 * the exact shapes `resources.files`/`resources.skills` consume. Node builtins
 * are resolved lazily via `process.getBuiltinModule` so a static `node:*`
 * import never reaches the Vite SSR bundle.
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

/** Harness skill-discovery path the Claude Code backend reads natively. The
 *  registry mounts here; the corpus mounts at its relative path.
 *
 *  @deprecated Hardcodes the claude-code path (`~/.claude/skills/<id>/SKILL.md`).
 *  It is NOT a path other harnesses read — OpenCode discovers `.opencode/skills`,
 *  not `~/.claude/skills` (the doc comment here previously claimed otherwise);
 *  codex, kimi-code, and the rest each have their own dir or none at all. Use
 *  {@link skillRefs} to put a skill on the typed `resources.skills` channel and
 *  let the platform materializer place it correctly, or resolve the
 *  harness-native dir directly via `@tangle-network/agent-app/skills-placement`.
 *  Kept only for the pre-existing `registrySkills`/`userSkillMounts` callers;
 *  do not add new call sites. */
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

// ─── Adoptable skills: one frontmatter parser, two delivery modes ─────────────

/** Fields a `SKILL.md` frontmatter block may declare. All optional — absent
 *  frontmatter (or an absent field within it) is legal; callers fill defaults
 *  (see {@link skillEntryFromMarkdown}). */
export interface SkillFrontmatter {
  id?: string
  name?: string
  description?: string
  author?: { name: string; url?: string }
  source?: string
  category?: string
  tags?: string[]
  tier?: string
}

/** The result of {@link parseSkillFrontmatter}: the parsed fields, the body
 *  with the frontmatter block stripped, and the original untouched text. */
export interface ParsedSkill {
  frontmatter: SkillFrontmatter
  body: string
  raw: string
}

/** Quoted values (`description: "..."`, as emitted by materialize's
 *  `normalizeSkillMd`) are JSON strings — decode with `JSON.parse` so escapes
 *  round-trip; anything else is a bare scalar, trimmed. */
function parseFrontmatterScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"')) return JSON.parse(trimmed) as string
  return trimmed
}

/** THE one `SKILL.md` frontmatter parser — hand-rolled, no YAML dependency.
 *
 * Absent frontmatter (text does not open with a `---` delimiter line) is
 * legal: returns `{frontmatter: {}, body: raw, raw}`. An OPENED block with no
 * closing `---` is truncated input and throws. Inside the block: scalar
 * `key: value` lines (value optionally double-quoted, decoded via
 * `JSON.parse`); a nested `author:` block whose indented `name:`/`url:` lines
 * are the only children it accepts; `tags:` as an inline `[a, b]` list or as
 * an indented `- item` block. Unknown scalar keys are ignored (forward-compat)
 * — but a line that matches NONE of these shapes (no colon, an orphaned
 * indented line, a bad dash) throws naming the offending line. Silently
 * mis-parsed metadata is the bug class this parser exists to kill; an
 * unrecognized shape is never guessed at.
 */
export function parseSkillFrontmatter(raw: string): ParsedSkill {
  const lines = raw.split('\n')
  if ((lines[0] ?? '').trim() !== '---') {
    return { frontmatter: {}, body: raw, raw }
  }

  let closeIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '---') {
      closeIndex = i
      break
    }
  }
  if (closeIndex === -1) {
    throw new Error(
      'parseSkillFrontmatter: opening "---" has no closing "---" — truncated frontmatter block',
    )
  }

  const blockLines = lines.slice(1, closeIndex)
  const body = lines.slice(closeIndex + 1).join('\n').replace(/^\n+/, '')
  const frontmatter: SkillFrontmatter = {}
  const scalarKeys = new Set(['id', 'name', 'description', 'source', 'category', 'tier'])
  const topLineRe = /^(\S[^:]*):\s*(.*)$/

  let i = 0
  while (i < blockLines.length) {
    const line = blockLines[i] ?? ''
    if (line.trim() === '') {
      i++
      continue
    }
    const match = line.match(topLineRe)
    if (!match) {
      throw new Error(`parseSkillFrontmatter: unrecognized frontmatter line: ${JSON.stringify(line)}`)
    }
    const key = (match[1] ?? '').trim()
    const rest = match[2] ?? ''

    if (key === 'author') {
      if (rest.trim() !== '') {
        throw new Error(`parseSkillFrontmatter: unrecognized frontmatter line: ${JSON.stringify(line)}`)
      }
      const author: { name: string; url?: string } = { name: '' }
      let sawName = false
      i++
      while (i < blockLines.length && /^\s+\S/.test(blockLines[i] ?? '')) {
        const sub = (blockLines[i] ?? '').trim()
        const subMatch = sub.match(/^(name|url):\s*(.*)$/)
        if (!subMatch) {
          throw new Error(
            `parseSkillFrontmatter: unrecognized frontmatter line: ${JSON.stringify(blockLines[i])}`,
          )
        }
        const subKey = subMatch[1] as 'name' | 'url'
        const subValue = parseFrontmatterScalar(subMatch[2] ?? '')
        if (subKey === 'name') {
          author.name = subValue
          sawName = true
        } else {
          author.url = subValue
        }
        i++
      }
      if (sawName) frontmatter.author = author
      continue
    }

    if (key === 'tags') {
      const inline = rest.trim()
      if (inline.startsWith('[') && inline.endsWith(']')) {
        const inner = inline.slice(1, -1).trim()
        frontmatter.tags = inner === '' ? [] : inner.split(',').map((t) => parseFrontmatterScalar(t))
        i++
        continue
      }
      if (inline !== '') {
        throw new Error(`parseSkillFrontmatter: unrecognized frontmatter line: ${JSON.stringify(line)}`)
      }
      const tags: string[] = []
      i++
      while (i < blockLines.length && /^\s*-\s*/.test(blockLines[i] ?? '')) {
        tags.push(parseFrontmatterScalar((blockLines[i] ?? '').replace(/^\s*-\s*/, '')))
        i++
      }
      frontmatter.tags = tags
      continue
    }

    if (scalarKeys.has(key)) {
      ;(frontmatter as Record<string, string>)[key] = parseFrontmatterScalar(rest)
    }
    // Unknown scalar key: ignored, forward-compat.
    i++
  }

  return { frontmatter, body, raw }
}

/** Build a {@link SkillEntry} from a raw `SKILL.md` body. `id` comes from
 *  frontmatter, falling back to `fallbackId` (typically the corpus entry's
 *  slug/filename); neither present throws. `name` defaults to `id`,
 *  `description` to `''`, `tier` to `'free'`. `skillMd` is always the
 *  untouched `raw` input — the full file, frontmatter included, is what a
 *  `mounted` delivery writes to disk and what `renderInlineSkills` strips per
 *  render. */
export function skillEntryFromMarkdown(raw: string, fallbackId?: string): SkillEntry {
  const { frontmatter } = parseSkillFrontmatter(raw)
  const id = frontmatter.id ?? fallbackId
  if (!id) {
    throw new Error(
      'skillEntryFromMarkdown: no "id" in frontmatter and no fallbackId supplied — cannot build a SkillEntry',
    )
  }
  const entry: SkillEntry = {
    id,
    name: frontmatter.name ?? id,
    description: frontmatter.description ?? '',
    tier: frontmatter.tier ?? 'free',
    skillMd: raw,
  }
  if (frontmatter.author) entry.author = frontmatter.author
  if (frontmatter.source) entry.source = frontmatter.source
  if (frontmatter.category) entry.category = frontmatter.category
  if (frontmatter.tags) entry.tags = frontmatter.tags
  return entry
}

/** Map a loaded corpus (see {@link loadMarkdownCorpus}) onto `SkillEntry`s,
 *  using each entry's `id` as the fallback when its `SKILL.md` carries no
 *  frontmatter `id` of its own. */
export function parseCorpusSkills(corpus: CorpusEntry[]): SkillEntry[] {
  return corpus.map((entry) => skillEntryFromMarkdown(entry.content, entry.id))
}

/** Project skills onto the typed `resources.skills` channel
 *  (`AgentProfileResourceRef[]`), tier-filtered (same `s.tier === tier`
 *  semantics as {@link registrySkills}) when `opts.tier` is given, sorted by
 *  id for determinism. `ref.name` MUST be the skill id: the platform
 *  materializer writes each ref to `${skillDir}/${name}/SKILL.md`. */
export function skillRefs(
  skills: SkillEntry[],
  opts: { tier?: string } = {},
): AgentProfileResourceRef[] {
  const filtered = opts.tier ? skills.filter((s) => s.tier === opts.tier) : skills
  return [...filtered]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => inlineResource(s.id, s.skillMd))
}

/** Strip the frontmatter block from a skill's `skillMd` and render it as a
 *  prompt subsection. The default `body` renderer {@link renderInlineSkills}
 *  passes to itself. */
function renderInlineSkillBody(skill: SkillEntry): string {
  const { body } = parseSkillFrontmatter(skill.skillMd)
  return `### ${skill.name}\n\n${body.trim()}`
}

/** Inputs to {@link renderInlineSkills}. */
export interface RenderInlineSkillsInput {
  skills: SkillEntry[]
  /** Section heading. Default `'## Skills'`. */
  heading?: string
  /** Tier filter — same semantics as {@link skillRefs}. */
  tier?: string
  /** Per-skill body renderer. Default strips frontmatter and emits
   *  `### <name>\n\n<body>`. */
  body?: (skill: SkillEntry) => string
}

/**
 * Render every (tier-filtered) skill's full body inline into the prompt — the
 * `inline` delivery mode. Returns `''` when no skill survives the filter, else
 * a section starting `\n\n<heading>\n\n` with each skill's body joined by
 * `\n\n` — the same "already carries its own leading `\n\n`" shape
 * `assembleSystemPrompt` expects from every section it concatenates.
 */
export function renderInlineSkills(input: RenderInlineSkillsInput): string {
  const heading = input.heading ?? '## Skills'
  const filtered = input.tier ? input.skills.filter((s) => s.tier === input.tier) : input.skills
  if (filtered.length === 0) return ''
  const renderBody = input.body ?? renderInlineSkillBody
  return `\n\n${heading}\n\n${filtered.map(renderBody).join('\n\n')}`
}

/** Inputs to {@link renderSkillIndex}. */
export interface RenderSkillIndexInput {
  skills: SkillEntry[]
  /** cwd-relative directory the skills are mounted under (e.g.
   *  `.opencode/skills`) — named in each index line so the agent knows where
   *  to read the full `SKILL.md`. */
  skillDir: string
  /** Section heading. Default `'## Skills'`. */
  heading?: string
  /** Tier filter — same semantics as {@link skillRefs}. */
  tier?: string
}

/**
 * Render a one-line-per-skill INDEX (name, description, and the path to read
 * the full body) — the `mounted` delivery mode's prompt section, paired with
 * {@link skillRefs} putting the actual files on `resources.skills`. Same
 * empty/section shape as {@link renderInlineSkills}.
 */
export function renderSkillIndex(input: RenderSkillIndexInput): string {
  const heading = input.heading ?? '## Skills'
  const filtered = input.tier ? input.skills.filter((s) => s.tier === input.tier) : input.skills
  if (filtered.length === 0) return ''
  const lines = filtered.map(
    (s) => `- ${s.name}: ${s.description} (read ${input.skillDir}/${s.id}/SKILL.md)`,
  )
  return `\n\n${heading}\n\n${lines.join('\n')}`
}

/** How a skill reaches the agent: `inline` renders its full body into the
 *  system prompt; `mounted` puts it on the typed `resources.skills` channel
 *  and renders only an index line. */
export type SkillDeliveryMode = 'inline' | 'mounted'

/** The output of {@link composeSkills}: the refs to attach to
 *  `resources.skills` (empty for `inline`) and the prompt section to fold into
 *  the system prompt (already carries its own leading `\n\n`, or `''`). */
export interface ComposedSkills {
  refs: AgentProfileResourceRef[]
  promptSection: string
}

/** Inputs to {@link composeSkills}. */
export interface ComposeSkillsInput {
  skills: SkillEntry[]
  mode: SkillDeliveryMode
  tier?: string
  heading?: string
  /** REQUIRED (non-null) for `mode: 'mounted'` — the cwd-relative skill dir
   *  the harness reads. Resolve it with `@tangle-network/agent-app/skills-placement`
   *  rather than hardcoding it; omitted or `null` throws. */
  skillDir?: string | null
}

/**
 * Build the {@link ComposedSkills} for one delivery mode. `inline` never
 * touches `resources.skills` — `refs` is always `[]`. `mounted` requires a
 * non-null `skillDir` (the harness must have a native skill-discovery
 * directory); a null/absent one throws rather than silently falling back, so
 * the caller resolves the fallback deliberately (see
 * `@tangle-network/agent-app/skills-placement`'s `composeSkillsForHarness`,
 * which does exactly that).
 */
export function composeSkills(input: ComposeSkillsInput): ComposedSkills {
  const { skills, mode, tier, heading } = input
  if (mode === 'inline') {
    return { refs: [], promptSection: renderInlineSkills({ skills, tier, heading }) }
  }
  if (!input.skillDir) {
    throw new Error(
      'composeSkills: mode "mounted" requires a non-null skillDir — this harness cannot receive ' +
        'skill files at a cwd path; pass mode "inline" instead',
    )
  }
  return {
    refs: skillRefs(skills, { tier }),
    promptSection: renderSkillIndex({ skills, skillDir: input.skillDir, tier, heading }),
  }
}

/** Throw when the same skill id is delivered both `inline` and `mounted` —
 *  the agent would see it twice (once in the prompt body, once as a mounted
 *  file it's told to go read), doubling prompt bytes and inviting drift
 *  between the two copies. Lists every offending id in the message. */
export function assertSkillDeliveryDisjoint(
  inlineIds: Iterable<string>,
  mountedIds: Iterable<string>,
): void {
  const inline = new Set(inlineIds)
  const overlap = [...new Set(mountedIds)].filter((id) => inline.has(id))
  if (overlap.length > 0) {
    throw new Error(
      `assertSkillDeliveryDisjoint: skill id(s) delivered both inline and mounted: ${overlap.join(', ')}`,
    )
  }
}
