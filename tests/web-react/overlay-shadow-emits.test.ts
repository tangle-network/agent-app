/**
 * The overlay elevation has to survive a host that did not build with this
 * package's Tailwind preset.
 *
 * `shadow-overlay` is a preset utility: it exists only where
 * `src/theme/tailwind-preset.ts` is part of the host's Tailwind build. Hosts
 * that take their tokens as precompiled CSS do not have it. The Tangle apps
 * reach the token through `@tangle-network/sandbox-ui`, which inlines brand's
 * tokens and ships them with no `@theme` block surviving the compile — so
 * `--shadow-overlay` arrives as a plain custom property, no `shadow-overlay`
 * utility can be generated from it, and every surface authored that way renders
 * flat. It is silent: the class is simply absent from the stylesheet, so
 * nothing errors and the elevation just disappears.
 *
 * `shadow-[var(--shadow-overlay)]` is an arbitrary value. Tailwind emits it
 * from the class alone, so it works in both kinds of host and reads the same
 * token in both.
 *
 * This gate is class-level rather than a list of the surfaces that exist today.
 * The popover cluster shipped the flat version once already; what stops the
 * next one is the bare form being unrepresentable anywhere in the package.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sourceRoot = join(packageRoot, "src");

/**
 * The preset is where the utility is DEFINED, which is the one legitimate
 * mention of the bare name. Everything else is a usage.
 */
const DEFINITION = join("src", "theme", "tailwind-preset.ts");

/**
 * Every shipped `.ts`/`.tsx` under `src`, tests and stories excluded.
 *
 * Only `fixtures` is skipped, and only because those files are inputs to other
 * suites rather than package source. Helpers and mocks are deliberately NOT
 * exempt: a bare class in one of them is still a bare class someone will copy,
 * and none of the usual folder names for them exists under `src` today, so an
 * exclusion for them would be untested surface guarding nothing.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "fixtures" || entry === "__fixtures__") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.(test|stories)\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Whether a file writes the bare utility anywhere.
 *
 * Subtraction rather than a lookbehind: the two legitimate ways the name
 * appears are removed by their full literal text, so whatever is left is a bare
 * class by construction. A lookbehind that excluded the arbitrary form would
 * have to encode the exact characters preceding the name, which is a detail of
 * how the value happens to be spelled rather than of what is being excluded.
 */
function usesBareUtility(source: string): boolean {
  const code = source
    // Comments name the utility while explaining it; only code counts.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*/g, "")
    // The arbitrary form — the thing this gate wants callers to write.
    .replace(/shadow-\[var\(--shadow-overlay\)\]/g, "")
    // The CSS custom property, which shares the name minus the dashes.
    .replace(/--shadow-overlay/g, "");
  return /\bshadow-overlay\b/.test(code);
}

const offenders = sourceFiles(sourceRoot)
  .filter((file) => relative(packageRoot, file) !== DEFINITION)
  .filter((file) => usesBareUtility(readFileSync(file, "utf8")))
  .map((file) => relative(packageRoot, file));

describe("overlay elevation survives a host without this package's preset", () => {
  it("scans a real set of source files", () => {
    // A path or extension slip that matched nothing would let the assertion
    // below pass while checking nothing at all.
    expect(sourceFiles(sourceRoot).length).toBeGreaterThan(50);
  });

  it("no source uses the bare `shadow-overlay` utility", () => {
    expect(offenders).toEqual([]);
  });
});
