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
/** Define options for scanning source directories and CSS token files in a theme contract */
export interface ThemeContractOptions {
    /** Consumer source directories to scan for token references (recursively). */
    srcDirs: string[];
    /**
     * Path to the base tokens.css whose `--name:` definitions are the ground
     * truth. Defaults to the tokens.css agent-app ships (`./styles`) — the set a
     * consumer gets from `import '@tangle-network/agent-app/styles'`.
     */
    tokensCss?: string;
    /**
     * Additional CSS files whose `--name:` definitions also count as defined —
     * the app's own overrides/extensions layered on top of the base tokens.
     */
    extraTokensCss?: string[];
    /**
     * Token names (e.g. `--my-app-accent`) to treat as always-defined, suppressing
     * them from the missing list. For app-specific vars defined outside any CSS
     * the checker can see (injected at runtime, from a third-party stylesheet, …).
     */
    allowlist?: string[];
}
/** Describe a missing theme contract variable and where it was referenced */
export interface ThemeContractMiss {
    /** The undefined custom property, e.g. `--popover`. */
    varName: string;
    /**
     * Where it was referenced: `path/to/file.tsx`, or
     * `path/to/file.tsx (via bg-surface-container-high)` when the reference is a
     * Tailwind utility that resolves to the token rather than a literal var().
     */
    referencedIn: string;
}
/** Describe the result of validating a theme contract including success status and missing items */
export interface ThemeContractResult {
    ok: boolean;
    missing: ThemeContractMiss[];
}
/**
 * Check that every theme token a consumer's source references is actually
 * defined in the CSS that consumer ships. Returns the full missing set; the
 * caller decides how to fail (the bin exits non-zero on any miss).
 */
export declare function checkThemeContract(opts: ThemeContractOptions): ThemeContractResult;
