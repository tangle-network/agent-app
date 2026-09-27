/**
 * The node-only recursive source walker `/legibility` and `/theme-contract`
 * both need: collect scannable files under a directory, skipping vendor and
 * generated output. Extracted here because it drifted into two copies one day
 * apart with different skip lists — `/theme-contract`'s was missing
 * `.react-router` / `.wrangler` / `.turbo`, so it descended into and linted
 * framework-generated output the newer list correctly skips.
 *
 * Zero dependencies beyond `node:fs`/`node:path`, so either subpath can import
 * it without pulling in the other's unrelated surface (`/legibility`'s own
 * hand-written lexer, in particular).
 */
/**
 * Recursively collect scannable files under `dir`.
 *
 * `ignore` is matched by substring against the full path — the caller's own
 * exclusions (test files, fixtures, `.d.ts`, generated route types, …) layer
 * on top of the shared `GENERATED_SKIP_DIRS` floor rather than being baked in
 * here, since which files count as "source" is a per-checker policy.
 */
export declare function walkSources(dir: string, ignore?: readonly string[], skipDirs?: ReadonlySet<string>): string[];
