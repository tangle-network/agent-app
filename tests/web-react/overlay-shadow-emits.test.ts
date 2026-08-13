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

/** Comments name the utility while explaining it; only code counts. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
}

/** The bare utility — not the arbitrary form, and not the CSS variable. */
const BARE = /(?<!\[var\(-)(?<!-)\bshadow-overlay\b/;

const offenders = sourceFiles(sourceRoot)
  .filter((file) => relative(packageRoot, file) !== DEFINITION)
  .filter((file) => BARE.test(withoutComments(readFileSync(file, "utf8"))))
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
