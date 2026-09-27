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
 * `mergeComposedSkills` combines batches and throws (via
 * `assertSkillDeliveryDisjoint`) on a skill accidentally delivered both
 * ways. Picking WHICH harnesses can take `mounted` delivery is platform-bound
 * (see `@tangle-network/agent-app/skills-placement`) and deliberately kept out
 * of this substrate-free module.
 *
 * Storage-independent and exact over the profile boundary: the only inbound
 * seam is the glob-result map the consumer passes in (its call site keeps the
 * literal `import.meta.glob` Vite must static-analyze); the only outbound seam
 * is `@tangle-network/agent-interface`'s
 * `AgentProfileFileMount[]`/`AgentProfileResourceRef[]`,
 * the exact shapes `resources.files`/`resources.skills` consume. Node builtins
 * are resolved lazily via `process.getBuiltinModule` so a static `node:*`
 * import never reaches the Vite SSR bundle.
 */
import type { AgentProfileFileMount, AgentProfileResourceRef } from '@tangle-network/agent-interface';
/** A Vite eager `?raw` glob result: glob key -> raw file body. The consumer
 *  produces this by calling `import.meta.glob('<lit>', { eager: true, query:
 *  '?raw', import: 'default' })` at its own call site — the literal must stay
 *  literal so Vite can static-analyze it; passing the result here keeps that
 *  constraint at the edge and the loader substrate-free. */
export type GlobModules = Record<string, string>;
/** One markdown document discovered from the corpus. */
export interface CorpusEntry {
    /** Slug derived from the glob key (folder slug for `SKILL.md` layouts, or the
     *  normalized relative path for flat `*.md` layouts). */
    id: string;
    /** Glob/fs key the entry was loaded from, normalized to a stable relative
     *  form (leading `./` and absolute prefixes stripped). */
    key: string;
    /** Raw markdown body (including any frontmatter). */
    content: string;
}
/** A hand-authored, tier-gated installable skill. Mirrors the per-product
 *  registry entry (gtm/insurance `SkillEntry`); the runtime's certified `skill`
 *  artifact kind is unrelated. `skillMd` is the inline body — file provenance
 *  does not apply to the registry. */
export interface SkillEntry {
    id: string;
    name: string;
    description: string;
    author?: {
        name: string;
        url?: string;
    };
    source?: string;
    category?: string;
    tags?: string[];
    /** Gate keyword. `composeShellResources`/`registrySkills` treat `free` as
     *  always-mounted; everything else is install-on-demand. */
    tier: string;
    skillMd: string;
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
export declare function skillMountPath(id: string): string;
/** Options for {@link loadMarkdownCorpus}. */
export interface LoadCorpusOptions {
    /** The anchor folder name that appears in both glob keys and fs paths
     *  (`skills`, `doctrine`, `knowledge`). Used to normalize keys + derive ids. */
    anchor: string;
    /** Vite glob-result map. When present and non-empty it is authoritative and
     *  the fs path is skipped. Omit it (or pass an empty map) only outside Vite. */
    globModules?: GlobModules;
    /** Absolute or `import.meta.url`-relative base dir the fs fallback walks when
     *  `globModules` is empty. Required for the fs path to run; without it the fs
     *  fallback returns no entries (Workers never need it). */
    fsBaseDir?: string;
    /** Walk strategy for the fs fallback. `nested` finds `<dir>/<slug>/SKILL.md`
     *  one level deep; `flat` recurses for every `*.md`. Default: `flat`. */
    fsLayout?: 'nested' | 'flat';
    /** Drop an entry by its normalized key after load. Covers the per-product
     *  skip lists (corpus index/log files, scaffold templates, allow-lists). */
    skip?: (normalizedKey: string) => boolean;
}
/** Outcome of {@link loadMarkdownCorpus}: the entries plus which path produced
 *  them, so a caller can fail loud when both are empty rather than silently
 *  mounting nothing. */
export interface CorpusLoadResult {
    source: 'vite' | 'fs' | 'empty';
    entries: CorpusEntry[];
}
/**
 * Load a markdown corpus, preferring a Vite glob-result map and falling back to
 * a Node fs walk. Selection is by non-empty glob result — never an env flag.
 * Entries are normalized, optionally skip-filtered, and sorted by id for
 * determinism. The `import.meta.glob` literal stays at the CONSUMER call site
 * (passed in as `globModules`); this loader never constructs a glob.
 */
export declare function loadMarkdownCorpus(options: LoadCorpusOptions, importMetaUrl?: string): CorpusLoadResult;
/** Project corpus entries onto SDK file mounts at a relative path under
 *  `<anchor>/`. Always-mounted: the corpus is the agent's baseline knowledge. */
export declare function corpusSkills(corpus: CorpusEntry[], anchor: string): AgentProfileFileMount[];
/** Project the registry's free-tier (or `tier`-matched) entries onto SDK file
 *  mounts at the harness skill-discovery path. Tier-gating is the registry's
 *  only selection rule — paid skills are installed on demand, not at boot. */
export declare function registrySkills(registry: SkillEntry[], tier?: string): AgentProfileFileMount[];
/** Inputs to {@link composeShellResources}. Each channel is optional so a
 *  product mounts only the systems it has — corpus-only, registry-only, or
 *  both — without conflating them. */
export interface ComposeShellResourcesInput {
    /** Corpus mounts (always-mounted baseline). Pass the result of
     *  {@link corpusSkills}, or a hand-built mount list. */
    skills?: AgentProfileFileMount[];
    /** Knowledge-corpus mounts (a second always-mounted corpus, e.g. a domain
     *  knowledge pack distinct from the skills corpus). */
    knowledge?: AgentProfileFileMount[];
    /** Evolvable / learned-guidance mounts (single-file corpora). */
    evolvable?: AgentProfileFileMount[];
    /** Registry mounts (tier-gated). Pass the result of {@link registrySkills}. */
    registry?: AgentProfileFileMount[];
    /** Final skip filter applied to the composed mount list by mount `path`. */
    predicate?: (mount: AgentProfileFileMount) => boolean;
}
/**
 * Compose every mount channel into one `resources.files`-ready array. Corpus
 * channels come first (baseline), the tier-gated registry last (so a registry
 * entry can override a corpus entry that mounts at the same path). The result
 * is exactly `AgentProfileFileMount[]` — assign it straight into
 * `profile.resources.files` with no cast.
 */
export declare function composeShellResources(input: ComposeShellResourcesInput): AgentProfileFileMount[];
/** Fields a `SKILL.md` frontmatter block may declare. All optional — absent
 *  frontmatter (or an absent field within it) is legal; callers fill defaults
 *  (see {@link skillEntryFromMarkdown}). */
export interface SkillFrontmatter {
    id?: string;
    name?: string;
    description?: string;
    author?: {
        name: string;
        url?: string;
    };
    source?: string;
    category?: string;
    tags?: string[];
    tier?: string;
}
/** The result of {@link parseSkillFrontmatter}: the parsed fields, the body
 *  with the frontmatter block stripped, and the original untouched text. */
export interface ParsedSkill {
    frontmatter: SkillFrontmatter;
    body: string;
    raw: string;
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
export declare function parseSkillFrontmatter(raw: string): ParsedSkill;
/** Build a {@link SkillEntry} from a raw `SKILL.md` body. `id` comes from
 *  frontmatter, falling back to `fallbackId` (typically the corpus entry's
 *  slug/filename); neither present throws. `name` defaults to `id`,
 *  `description` to `''`, `tier` to `'free'`. `skillMd` is always the
 *  untouched `raw` input — the full file, frontmatter included, is what a
 *  `mounted` delivery writes to disk and what `renderInlineSkills` strips per
 *  render. */
export declare function skillEntryFromMarkdown(raw: string, fallbackId?: string): SkillEntry;
/** Map a loaded corpus (see {@link loadMarkdownCorpus}) onto `SkillEntry`s,
 *  using each entry's `id` as the fallback when its `SKILL.md` carries no
 *  frontmatter `id` of its own. */
export declare function parseCorpusSkills(corpus: CorpusEntry[]): SkillEntry[];
/** Project skills onto the typed `resources.skills` channel
 *  (`AgentProfileResourceRef[]`), tier-filtered (same `s.tier === tier`
 *  semantics as {@link registrySkills}) when `opts.tier` is given, sorted by
 *  id for determinism. `ref.name` MUST be the skill id: the platform
 *  materializer writes each ref to `${skillDir}/${name}/SKILL.md`. */
export declare function skillRefs(skills: SkillEntry[], opts?: {
    tier?: string;
}): AgentProfileResourceRef[];
/** Inputs to {@link renderInlineSkills}. */
export interface RenderInlineSkillsInput {
    skills: SkillEntry[];
    /** Section heading. Default `'## Skills'`. */
    heading?: string;
    /** Tier filter — same semantics as {@link skillRefs}. */
    tier?: string;
    /** Per-skill body renderer. Default strips frontmatter and emits
     *  `### <name>\n\n<body>`. */
    body?: (skill: SkillEntry) => string;
}
/**
 * Render every (tier-filtered) skill's full body inline into the prompt — the
 * `inline` delivery mode. Returns `''` when no skill survives the filter, else
 * a section starting `\n\n<heading>\n\n` with each skill's body joined by
 * `\n\n` — the same "already carries its own leading `\n\n`" shape
 * `assembleSystemPrompt` expects from every section it concatenates.
 */
export declare function renderInlineSkills(input: RenderInlineSkillsInput): string;
/** Inputs to {@link renderSkillIndex}. */
export interface RenderSkillIndexInput {
    skills: SkillEntry[];
    /** cwd-relative directory the skills are mounted under (e.g.
     *  `.opencode/skills`) — named in each index line so the agent knows where
     *  to read the full `SKILL.md`. */
    skillDir: string;
    /** Section heading. Default `'## Skills'`. */
    heading?: string;
    /** Tier filter — same semantics as {@link skillRefs}. */
    tier?: string;
}
/**
 * Render a one-line-per-skill INDEX (name, description, and the path to read
 * the full body) — the `mounted` delivery mode's prompt section, paired with
 * {@link skillRefs} putting the actual files on `resources.skills`. Same
 * empty/section shape as {@link renderInlineSkills}.
 */
export declare function renderSkillIndex(input: RenderSkillIndexInput): string;
/** How a skill reaches the agent: `inline` renders its full body into the
 *  system prompt; `mounted` puts it on the typed `resources.skills` channel
 *  and renders only an index line. */
export type SkillDeliveryMode = 'inline' | 'mounted';
/** The output of {@link composeSkills}: the refs to attach to
 *  `resources.skills` (empty for `inline`) and the prompt section to fold into
 *  the system prompt (already carries its own leading `\n\n`, or `''`).
 *  `inlineIds`/`mountedIds` record which (tier-filtered) skills were delivered
 *  in each mode so {@link mergeComposedSkills} can enforce the modes stay
 *  disjoint when batches are combined. */
export interface ComposedSkills {
    refs: AgentProfileResourceRef[];
    promptSection: string;
    inlineIds: string[];
    mountedIds: string[];
}
/** Inputs to {@link composeSkills}. */
export interface ComposeSkillsInput {
    skills: SkillEntry[];
    mode: SkillDeliveryMode;
    tier?: string;
    heading?: string;
    /** REQUIRED (non-null) for `mode: 'mounted'` — the cwd-relative skill dir
     *  the harness reads. Resolve it with `@tangle-network/agent-app/skills-placement`
     *  rather than hardcoding it; omitted or `null` throws. */
    skillDir?: string | null;
}
/**
 * Build the {@link ComposedSkills} for one delivery mode. `inline` never
 * touches `resources.skills` — `refs` is always `[]`. `mounted` requires a
 * non-null `skillDir` (the harness must have a native skill-discovery
 * directory); a null/absent one throws rather than silently falling back, so
 * the caller resolves the fallback deliberately (see
 * `@tangle-network/agent-app/skills-placement`'s `composeSkillsForHarness`,
 * whose own default is to throw rather than choose `inline` for you — inline
 * is a narrow, explicitly opted-into fallback, not a co-equal mode).
 */
export declare function composeSkills(input: ComposeSkillsInput): ComposedSkills;
/** Throw when the same skill id is delivered both `inline` and `mounted` —
 *  the agent would see it twice (once in the prompt body, once as a mounted
 *  file it's told to go read), doubling prompt bytes and inviting drift
 *  between the two copies. Lists every offending id in the message. */
export declare function assertSkillDeliveryDisjoint(inlineIds: Iterable<string>, mountedIds: Iterable<string>): void;
/**
 * Combine multiple {@link ComposedSkills} batches (e.g. a built-in corpus and
 * an installed catalog) into one, concatenating refs and prompt sections in
 * batch order. This is the seam where inline and mounted deliveries can first
 * collide, so it applies {@link assertSkillDeliveryDisjoint} — a skill id
 * delivered inline by one batch and mounted by another throws instead of
 * reaching the agent twice. Merge through this rather than spreading batch
 * fields by hand.
 */
export declare function mergeComposedSkills(batches: ComposedSkills[]): ComposedSkills;
