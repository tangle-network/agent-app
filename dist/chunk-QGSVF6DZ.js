import {
  walkSources
} from "./chunk-EMLGWEHV.js";

// src/theme-contract/index.ts
import { existsSync, readFileSync } from "fs";
import { relative } from "path";
import { fileURLToPath } from "url";
var DANGEROUS_UTILITIES = [
  { suffix: "surface-container-highest", varName: "--secondary" },
  { suffix: "surface-container-high", varName: "--popover" },
  { suffix: "surface-container", varName: "--card" },
  { suffix: "card-foreground", varName: "--card-foreground" },
  { suffix: "popover-foreground", varName: "--popover-foreground" },
  { suffix: "card", varName: "--card" },
  { suffix: "popover", varName: "--popover" }
];
var UTILITY_PREFIXES = "bg|text|border|ring|fill|stroke";
function buildUtilityRe(suffix) {
  return new RegExp(`(?<![\\w-])(?:${UTILITY_PREFIXES})-${suffix}(?![\\w-])`, "g");
}
function definedVars(cssFiles) {
  const defs = /* @__PURE__ */ new Set();
  for (const file of cssFiles) {
    let css;
    try {
      css = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)) if (m[1]) defs.add(m[1]);
  }
  return defs;
}
function defaultTokensCss() {
  const candidates = ["../theme/tokens.css", "./theme/tokens.css"].map(
    (rel) => fileURLToPath(new URL(rel, import.meta.url))
  );
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}
function checkThemeContract(opts) {
  const tokensCss = opts.tokensCss ?? defaultTokensCss();
  const defined = definedVars([tokensCss, ...opts.extraTokensCss ?? []]);
  const allow = new Set(opts.allowlist ?? []);
  const isDefined = (name) => defined.has(name) || allow.has(name);
  const files = opts.srcDirs.flatMap((dir) => walkSources(dir, [".d.ts"]));
  const utilityMatchers = DANGEROUS_UTILITIES.map((u) => ({ ...u, re: buildUtilityRe(u.suffix) }));
  const seenVar = /* @__PURE__ */ new Map();
  const seenUtility = /* @__PURE__ */ new Map();
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const where = displayPath(file);
    for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      const name = m[1];
      if (!name || isDefined(name) || seenVar.has(name)) continue;
      seenVar.set(name, where);
    }
    for (const u of utilityMatchers) {
      if (isDefined(u.varName)) continue;
      const key = `${u.varName}::${u.suffix}`;
      if (seenUtility.has(key)) continue;
      u.re.lastIndex = 0;
      if (u.re.test(text)) seenUtility.set(key, `${where} (via ${firstUtilityHit(text, u.suffix)})`);
    }
  }
  const missing = [
    ...[...seenVar].map(([varName, referencedIn]) => ({ varName, referencedIn })),
    ...[...seenUtility].map(([key, referencedIn]) => ({ varName: key.split("::")[0], referencedIn }))
  ];
  return { ok: missing.length === 0, missing };
}
function firstUtilityHit(text, suffix) {
  const m = buildUtilityRe(suffix).exec(text);
  return m?.[0] ?? `<utility>-${suffix}`;
}
function displayPath(file) {
  const rel = relative(process.cwd(), file);
  return rel && !rel.startsWith("..") ? rel : file;
}

export {
  checkThemeContract
};
//# sourceMappingURL=chunk-QGSVF6DZ.js.map