/**
 * Exportable theme-token contract checker — the incident guard for the
 * invisible-popover class of bugs.
 *
 * The failure mode (tax-agent's transparent model dropdown; the whole
 * `bg-surface-container-*` family): a consumer app ships a component that
 * references a theme token — either as `var(--popover)` or as a Tailwind class
 * like `bg-surface-container-high` that the agent-app preset maps to
 * `hsl(var(--popover))` — but the app's OWN build never emits that custom
 * property (it forgot `import '@tangle-network/agent-app/styles'`, or dropped a
 * token in its local tokens.css). CSS resolves the missing var to nothing, the
 * surface paints transparent, and NOTHING errors. It ships invisible.
 *
 * `tests/theme/tokens-contract.test.ts` guards agent-app's OWN components. This
 * module lifts that walking logic into a function every CONSUMER app can run
 * against ITS OWN source in CI, comparing references to the tokens.css agent-app
 * ships plus any extra CSS the app defines.
 *
 * ── What each check covers (scope is deliberately honest) ────────────────────
 *
 *  1. var(--…) check — COMPLETE. Every `var(--name)` literal in the scanned
 *     source (inline styles, `bg-[var(--name)]` arbitrary Tailwind values, CSS
 *     template strings) is matched and compared against the defined token set.
 *     This is exact: a `var(--x)` reference is unambiguous. It is a raw-text
 *     scan (no AST), so a `var(--x)` written inside a comment or string literal
 *     counts too — deliberate: it keeps the single-source logic identical to the
 *     agent-app self-test, and a dangling `var(--x)` in a comment is a smell
 *     worth surfacing. Suppress a deliberate one with `allowlist`.
 *
 *  2. Tailwind-utility check — INTENTIONALLY PARTIAL. Bare classes like
 *     `bg-card` carry no `var(--)` and so are invisible to check 1; Tailwind
 *     resolves them to `hsl(var(--card))` at build via the preset. Fully
 *     resolving arbitrary Tailwind config is out of scope (it would mean
 *     re-implementing Tailwind). Instead we check the SPECIFIC known-dangerous
 *     families that have actually shipped invisible: the MD3 surface ladder
 *     (`surface-container` / `-high` / `-highest`) and the `card` / `popover`
 *     elevation pairs — exactly the utilities the agent-app tailwind-preset
 *     registers onto elevation tokens (see src/theme/tailwind-preset.ts, the
 *     source of truth for this mapping). The canvas/sequence aliases
 *     (`--bg-input`, `--text-primary`, …) are consumed as `bg-[var(--…)]`
 *     arbitrary values and so are already covered fully by check 1 — they need
 *     no entry here.
 *
 * Node-only (reads the filesystem) → this lives in the `./theme-contract`
 * subpath, NOT `./theme`, which must stay browser-clean (it's in the
 * browser-safe manifest test).
 */

import { type Dirent, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ThemeContractOptions {
  /** Consumer source directories to scan for token references (recursively). */
  srcDirs: string[]
  /**
   * Path to the base tokens.css whose `--name:` definitions are the ground
   * truth. Defaults to the tokens.css agent-app ships (`./styles`) — the set a
   * consumer gets from `import '@tangle-network/agent-app/styles'`.
   */
  tokensCss?: string
  /**
   * Additional CSS files whose `--name:` definitions also count as defined —
   * the app's own overrides/extensions layered on top of the base tokens.
   */
  extraTokensCss?: string[]
  /**
   * Token names (e.g. `--my-app-accent`) to treat as always-defined, suppressing
   * them from the missing list. For app-specific vars defined outside any CSS
   * the checker can see (injected at runtime, from a third-party stylesheet, …).
   */
  allowlist?: string[]
}

export interface ThemeContractMiss {
  /** The undefined custom property, e.g. `--popover`. */
  varName: string
  /**
   * Where it was referenced: `path/to/file.tsx`, or
   * `path/to/file.tsx (via bg-surface-container-high)` when the reference is a
   * Tailwind utility that resolves to the token rather than a literal var().
   */
  referencedIn: string
}

export interface ThemeContractResult {
  ok: boolean
  missing: ThemeContractMiss[]
}

/** Source extensions scanned for token references. */
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage'])

/**
 * Known-dangerous Tailwind utility families and the elevation token each
 * resolves to, mirroring src/theme/tailwind-preset.ts. Ordered longest-suffix
 * first so `surface-container-highest` is matched before `surface-container`.
 * The negative look-around in {@link buildUtilityRe} makes ordering belt-and-
 * suspenders rather than load-bearing.
 */
const DANGEROUS_UTILITIES: ReadonlyArray<{ suffix: string; varName: string }> = [
  { suffix: 'surface-container-highest', varName: '--secondary' },
  { suffix: 'surface-container-high', varName: '--popover' },
  { suffix: 'surface-container', varName: '--card' },
  { suffix: 'card-foreground', varName: '--card-foreground' },
  { suffix: 'popover-foreground', varName: '--popover-foreground' },
  { suffix: 'card', varName: '--card' },
  { suffix: 'popover', varName: '--popover' },
]

/** Tailwind color-utility prefixes that can carry a background/text/border color. */
const UTILITY_PREFIXES = 'bg|text|border|ring|fill|stroke'

/**
 * Match a whole utility class for `suffix`, tolerant of variants (`hover:`,
 * `dark:`) and opacity (`/95`) but not of longer siblings: the trailing
 * `(?![\w-])` stops `bg-surface-container` from matching inside
 * `bg-surface-container-high`, and `bg-card` from matching inside
 * `bg-card-foreground`.
 */
function buildUtilityRe(suffix: string): RegExp {
  return new RegExp(`(?<![\\w-])(?:${UTILITY_PREFIXES})-${suffix}(?![\\w-])`, 'g')
}

/** Recursively collect scannable source files under a directory. */
function walkSources(dir: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((e) => {
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : walkSources(join(dir, e.name))
    return SOURCE_RE.test(e.name) && !e.name.endsWith('.d.ts') ? [join(dir, e.name)] : []
  })
}

/**
 * Every `--name:` DEFINITION across the given CSS files. A definition is
 * `--name:` at the start of a (trimmed) line; RHS references like
 * `hsl(var(--card))` are mid-line and are never counted as definitions.
 */
function definedVars(cssFiles: string[]): Set<string> {
  const defs = new Set<string>()
  for (const file of cssFiles) {
    let css: string
    try {
      css = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const m of css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)) if (m[1]) defs.add(m[1])
  }
  return defs
}

/**
 * Default tokens.css: the one agent-app ships as `./styles`. Resolved relative
 * to this module's URL, but tolerant of where the bundler lands the running
 * code — tsup code-splits shared logic into a chunk at the dist ROOT, so the
 * tokens.css sits one directory DIFFERENTLY depending on layout:
 *   - source (src/theme-contract/index.ts) → ../theme/tokens.css  (src/theme)
 *   - split chunk    (dist/contract-*.js)  → ./theme/tokens.css   (dist/theme)
 *   - unsplit entry  (dist/theme-contract/index.js) → ../theme/tokens.css
 * Probe both and return the one that exists; fall back to the first for a
 * sensible error path if neither is present.
 */
function defaultTokensCss(): string {
  const candidates = ['../theme/tokens.css', './theme/tokens.css'].map((rel) =>
    fileURLToPath(new URL(rel, import.meta.url)),
  )
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!
}

/**
 * Check that every theme token a consumer's source references is actually
 * defined in the CSS that consumer ships. Returns the full missing set; the
 * caller decides how to fail (the bin exits non-zero on any miss).
 */
export function checkThemeContract(opts: ThemeContractOptions): ThemeContractResult {
  const tokensCss = opts.tokensCss ?? defaultTokensCss()
  const defined = definedVars([tokensCss, ...(opts.extraTokensCss ?? [])])
  const allow = new Set(opts.allowlist ?? [])
  const isDefined = (name: string) => defined.has(name) || allow.has(name)

  const files = opts.srcDirs.flatMap(walkSources)
  const utilityMatchers = DANGEROUS_UTILITIES.map((u) => ({ ...u, re: buildUtilityRe(u.suffix) }))

  // Dedupe by varName (literal check) and by varName+utility (utility check),
  // keeping the FIRST referencing file — enough to locate the offender without
  // drowning the report when one token is referenced across many files.
  const seenVar = new Map<string, string>()
  const seenUtility = new Map<string, string>()

  for (const file of files) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const where = displayPath(file)

    // Check 1 — literal var(--…) references.
    for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      const name = m[1]
      if (!name || isDefined(name) || seenVar.has(name)) continue
      seenVar.set(name, where)
    }

    // Check 2 — known-dangerous Tailwind utility classes.
    for (const u of utilityMatchers) {
      if (isDefined(u.varName)) continue
      const key = `${u.varName}::${u.suffix}`
      if (seenUtility.has(key)) continue
      u.re.lastIndex = 0
      if (u.re.test(text)) seenUtility.set(key, `${where} (via ${firstUtilityHit(text, u.suffix)})`)
    }
  }

  const missing: ThemeContractMiss[] = [
    ...[...seenVar].map(([varName, referencedIn]) => ({ varName, referencedIn })),
    ...[...seenUtility].map(([key, referencedIn]) => ({ varName: key.split('::')[0]!, referencedIn })),
  ]
  return { ok: missing.length === 0, missing }
}

/** The literal utility class (with prefix) first seen in `text` for `suffix`, for the report. */
function firstUtilityHit(text: string, suffix: string): string {
  const m = buildUtilityRe(suffix).exec(text)
  return m?.[0] ?? `<utility>-${suffix}`
}

/** Path relative to cwd when it stays inside it, else the path as given — for readable reports. */
function displayPath(file: string): string {
  const rel = relative(process.cwd(), file)
  return rel && !rel.startsWith('..') ? rel : file
}
