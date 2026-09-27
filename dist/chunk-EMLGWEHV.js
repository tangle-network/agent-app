// src/legibility/walk-sources.ts
import { readdirSync } from "fs";
import { join } from "path";
var SOURCE_FILE_RE = /\.(tsx?|jsx?|mjs|cjs)$/;
var GENERATED_SKIP_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".react-router",
  "coverage",
  ".wrangler",
  ".turbo"
]);
function walkSources(dir, ignore = [], skipDirs = GENERATED_SKIP_DIRS) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return skipDirs.has(entry.name) ? [] : walkSources(full, ignore, skipDirs);
    return SOURCE_FILE_RE.test(entry.name) ? [full] : [];
  }).filter((file) => !ignore.some((needle) => file.includes(needle)));
}

export {
  walkSources
};
//# sourceMappingURL=chunk-EMLGWEHV.js.map