// src/peer-floors/check.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, readdirSync as readdirSync2 } from "fs";
import { dirname as dirname2, join as join2 } from "path";

// src/peer-floors/dependency-source.ts
import { createHash } from "crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
var TARBALL = /\.(?:tgz|tar\.gz)$/i;
function classifyDependencySpecifier(specifier) {
  const spec = specifier.trim();
  if (spec.startsWith("workspace:")) return "workspace";
  if (spec.startsWith("catalog:")) return "catalog";
  for (const protocol of ["file:", "link:", "portal:"]) {
    if (spec.startsWith(protocol)) {
      const path = spec.slice(protocol.length);
      if (TARBALL.test(path)) return "tarball";
      return protocol.slice(0, -1);
    }
  }
  if (/^(?:git|git\+ssh|git\+https?|git\+file|ssh):/.test(spec)) return "git";
  if (/^(?:github|gitlab|bitbucket):/.test(spec)) return "git";
  if (/^https?:\/\//.test(spec)) return TARBALL.test(spec.split(/[?#]/)[0] ?? "") ? "tarball" : "remote";
  if (/^[\w.-]+\/[\w.-]+(?:#.+)?$/.test(spec) && !spec.startsWith("@")) return "git";
  return "registry";
}
function isReproducible(protocol) {
  return protocol === "registry" || protocol === "workspace" || protocol === "catalog";
}
function resolveLocalPathSource(args) {
  const root = resolve(args.repoDir);
  const target = isAbsolute(args.path) ? resolve(args.path) : resolve(args.fromDir, args.path);
  if (target !== root && !target.startsWith(root + sep)) return "outside-repo";
  const manifest = join(target, "package.json");
  if (!existsSync(manifest) || !statSync(target).isDirectory()) return "not-a-directory";
  let declared;
  try {
    declared = JSON.parse(readFileSync(manifest, "utf8")).name;
  } catch {
    return "not-a-directory";
  }
  return declared === args.name ? "in-repo-source" : "name-mismatch";
}
var SKIP_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".wrangler",
  ".react-router",
  ".next",
  ".turbo",
  ".cache",
  ".worktrees",
  "storybook-static"
]);
function walkSourceTree(dir, repoDir, exclude, seen) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(repoDir, full).split(sep).join("/");
    if (exclude.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkSourceTree(full, repoDir, exclude, seen);
    } else if (entry.isFile()) {
      if (entry.name === "package.json") seen.manifests.push(full);
      else if (TARBALL.test(entry.name)) seen.tarballs.push(full);
    }
  }
}
function unquote(text) {
  const t = text.trim();
  if (t.startsWith("'") && t.endsWith("'") || t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1);
  }
  return t;
}
function readYamlLines(text) {
  const out = [];
  const stack = [];
  text.split("\n").forEach((raw, index) => {
    if (!raw.trim() || raw.trimStart().startsWith("#")) return;
    const indent = raw.length - raw.trimStart().length;
    const match = /^\s*(?:'((?:[^']|'')*)'|"([^"]*)"|([^\s:#][^:]*?))\s*:(?:\s+(.*))?$/.exec(raw);
    if (!match) return;
    const key = (match[1] ?? match[2] ?? match[3] ?? "").replace(/''/g, "'");
    const rawValue = (match[4] ?? "").split(" #")[0] ?? "";
    const depth = Math.floor(indent / 2);
    stack.length = depth;
    const path = [...stack];
    stack[depth] = key;
    out.push({ indent, key, value: unquote(rawValue), path, lineNumber: index + 1 });
  });
  return out;
}
function sectionOf(line) {
  return line.indent === 0 ? line.key : line.path[0];
}
var DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
function judge(args) {
  const protocol = classifyDependencySpecifier(args.specifier);
  if (isReproducible(protocol)) return null;
  const base = { check: args.check, name: args.name, specifier: args.specifier, protocol, where: args.where };
  if (protocol === "tarball") {
    return {
      ...base,
      detail: "resolves a PACKED TARBALL, not a published release. A .tgz is opaque bytes that no diff shows and no registry can reproduce: the version inside it can collide with a real release and ship a different API. Publish the change and pin the published range."
    };
  }
  if (protocol === "git" || protocol === "remote") {
    return {
      ...base,
      detail: `resolves from ${protocol === "git" ? "a git ref" : "a remote URL"} rather than the registry, so what installs depends on what that ref points at today. Publish the change and pin the published range.`
    };
  }
  const path = args.specifier.slice(args.specifier.indexOf(":") + 1);
  const source = resolveLocalPathSource({ fromDir: args.fromDir, repoDir: args.repoDir, path, name: args.name });
  if (source === "in-repo-source") return null;
  const why = {
    "outside-repo": "points OUTSIDE this repository, so it resolves on one machine and nowhere else \u2014 a clean checkout, a CI runner and a sign-off gate that installs into an exported tree all get a different answer or fail at install.",
    "not-a-directory": "does not resolve to a package directory in this repository. A local specifier is only legitimate when it points at in-repo SOURCE a reviewer sees in the diff.",
    "name-mismatch": `resolves to an in-repo directory that declares a DIFFERENT package name, so the dependency ${args.name} is being satisfied by something else entirely.`
  };
  return { ...base, detail: `${why[source]} (${source})` };
}
function scanManifest(file, repoDir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const fromDir = dirname(file);
  const where = relative(repoDir, file).split(sep).join("/") || "package.json";
  const findings = [];
  for (const field of DEP_FIELDS) {
    const block = manifest[field];
    if (!block || typeof block !== "object") continue;
    for (const [name, specifier] of Object.entries(block)) {
      if (typeof specifier !== "string") continue;
      const finding = judge({ check: "declared", name, specifier, where: `${where} \u2192 ${field}`, fromDir, repoDir });
      if (finding) findings.push(finding);
    }
  }
  const overrideBlocks = [
    ["pnpm.overrides", manifest.pnpm?.overrides],
    ["resolutions", manifest.resolutions]
  ];
  for (const [label, block] of overrideBlocks) {
    if (!block || typeof block !== "object") continue;
    for (const [name, specifier] of Object.entries(block)) {
      if (typeof specifier !== "string") continue;
      const finding = judge({
        check: "override",
        // An override key can carry a range suffix (`foo@1 > bar`); the package
        // name is the leading segment.
        name: overrideKeyName(name),
        specifier,
        where: `${where} \u2192 ${label}['${name}']`,
        fromDir,
        repoDir
      });
      if (finding) findings.push(finding);
    }
  }
  return findings;
}
function overrideKeyName(key) {
  const head = (key.split(">").pop() ?? key).trim();
  const at = head.lastIndexOf("@");
  return at > 0 ? head.slice(0, at) : head;
}
function scanWorkspaceYaml(file, repoDir) {
  const findings = [];
  const where = relative(repoDir, file).split(sep).join("/");
  for (const line of readYamlLines(readFileSync(file, "utf8"))) {
    const section = sectionOf(line);
    if (section !== "overrides" && section !== "catalog" && section !== "catalogs") continue;
    if (line.indent === 0 || !line.value) continue;
    const finding = judge({
      check: "override",
      name: overrideKeyName(line.key),
      specifier: line.value,
      where: `${where}:${line.lineNumber} \u2192 ${[...line.path, line.key].join(".")}`,
      fromDir: dirname(file),
      repoDir
    });
    if (finding) findings.push(finding);
  }
  return findings;
}
function scanLockfile(file, repoDir) {
  const findings = [];
  const where = relative(repoDir, file).split(sep).join("/");
  const fromDir = dirname(file);
  const seen = /* @__PURE__ */ new Set();
  const push = (finding) => {
    if (!finding) return;
    const key = `${finding.name}|${finding.specifier}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };
  for (const line of readYamlLines(readFileSync(file, "utf8"))) {
    const section = sectionOf(line);
    if (section === "overrides" && line.indent > 0 && line.value) {
      push(judge({
        check: "lockfile",
        name: overrideKeyName(line.key),
        specifier: line.value,
        where: `${where}:${line.lineNumber} \u2192 overrides`,
        fromDir,
        repoDir
      }));
      continue;
    }
    if (section === "importers" && line.key === "specifier" && line.value) {
      push(judge({
        check: "lockfile",
        name: line.path[line.path.length - 1] ?? "(unknown)",
        specifier: line.value,
        where: `${where}:${line.lineNumber} \u2192 importers`,
        fromDir,
        repoDir
      }));
      continue;
    }
    if ((section === "packages" || section === "snapshots") && line.indent === 2 && !line.value) {
      const parsed = parsePackageKey(line.key);
      if (!parsed) continue;
      push(judge({
        check: "lockfile",
        name: parsed.name,
        specifier: parsed.reference,
        where: `${where}:${line.lineNumber} \u2192 ${section}`,
        fromDir,
        repoDir
      }));
    }
  }
  return findings;
}
function parsePackageKey(key) {
  const withoutPeers = key.replace(/\(.*\)$/, "");
  const at = withoutPeers.lastIndexOf("@");
  if (at <= 0) return null;
  return { name: withoutPeers.slice(0, at), reference: withoutPeers.slice(at + 1) };
}
function scanVirtualStore(repoDir, modulesDir) {
  const store = join(repoDir, modulesDir, ".pnpm");
  if (!existsSync(store)) return [];
  const findings = [];
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === modulesDir) continue;
    const protocolMatch = /^(file|link|portal|git|https?)\+/.exec(entry.name);
    if (!protocolMatch) continue;
    const protocol = protocolMatch[1];
    const encoded = entry.name.slice(protocol.length + 1);
    const name = installedPackageName(join(store, entry.name), modulesDir);
    const where = `${modulesDir}/.pnpm/${entry.name}`;
    if (protocol === "file" || protocol === "link" || protocol === "portal") {
      const path = encoded.split("+").join("/");
      const specifier = `${protocol}:${path}`;
      const finding = judge({
        check: "installed",
        name: name ?? path,
        specifier,
        where,
        // A virtual-store path is written relative to the install root.
        fromDir: repoDir,
        repoDir
      });
      if (finding) findings.push(finding);
      continue;
    }
    findings.push({
      check: "installed",
      name,
      specifier: encoded.split("+++").join("://").split("+").join("/"),
      protocol: protocol === "git" ? "git" : "remote",
      where,
      detail: "is INSTALLED from a git ref or remote URL rather than the registry. The manifests may read clean \u2014 this is what the tree on disk actually holds. Reinstall from a published range."
    });
  }
  return findings;
}
function installedPackageName(entryDir, modulesDir) {
  const nested = join(entryDir, modulesDir);
  if (!existsSync(nested)) return null;
  for (const child of readdirSync(nested, { withFileTypes: true })) {
    if (child.name === ".bin" || child.isSymbolicLink()) continue;
    if (!child.isDirectory()) continue;
    if (child.name.startsWith("@")) {
      const scopeDir = join(nested, child.name);
      for (const scoped of readdirSync(scopeDir, { withFileTypes: true })) {
        if (scoped.isSymbolicLink() || !scoped.isDirectory()) continue;
        if (existsSync(join(scopeDir, scoped.name, "package.json"))) return `${child.name}/${scoped.name}`;
      }
      continue;
    }
    if (existsSync(join(nested, child.name, "package.json"))) return child.name;
  }
  return null;
}
function locateStoreCas(repoDir, modulesDir) {
  const modulesState = join(repoDir, modulesDir, ".modules.yaml");
  if (!existsSync(modulesState)) return [];
  let configured;
  try {
    const text = readFileSync(modulesState, "utf8");
    configured = (/"storeDir"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? /^storeDir:\s*(.+)$/m.exec(text)?.[1])?.trim();
  } catch {
    return [];
  }
  if (!configured) return [];
  const root = unquote(configured.replace(/\\\\/g, "\\"));
  const candidates = /* @__PURE__ */ new Set([root, dirname(root)]);
  for (const base of [root, dirname(root)]) {
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && /^v\d+$/.test(entry.name)) candidates.add(join(base, entry.name));
      }
    } catch {
    }
  }
  return [...candidates].map((dir) => join(dir, "files")).filter((dir) => existsSync(dir));
}
function collectFiles(dir, modulesDir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === modulesDir) continue;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) collectFiles(full, modulesDir, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
function storeHolds(casDirs, bytes) {
  const hex = createHash("sha512").update(bytes).digest("hex");
  const tail = join(hex.slice(0, 2), hex.slice(2));
  return casDirs.some((dir) => existsSync(join(dir, tail)) || existsSync(join(dir, `${tail}-exec`)));
}
function checkInstalledIntegrity(args) {
  const virtualStore = join(args.repoDir, args.modulesDir, ".pnpm");
  const casDirs = locateStoreCas(args.repoDir, args.modulesDir);
  const findings = [];
  let packagesExamined = 0;
  let filesExamined = 0;
  let filesHashed = 0;
  if (casDirs.length > 0 && existsSync(virtualStore)) {
    for (const entry of readdirSync(virtualStore, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === args.modulesDir) continue;
      const entryDir = join(virtualStore, entry.name);
      const name = installedPackageName(entryDir, args.modulesDir);
      if (!name || !name.startsWith(args.scope)) continue;
      const packageDir = join(entryDir, args.modulesDir, name);
      if (!existsSync(packageDir)) continue;
      const files = collectFiles(packageDir, args.modulesDir);
      if (files.length === 0) continue;
      packagesExamined += 1;
      filesExamined += files.length;
      const foreign = [];
      for (const file of files) {
        try {
          if (lstatSync(file).nlink > 1) continue;
          filesHashed += 1;
          if (storeHolds(casDirs, readFileSync(file))) continue;
          foreign.push(relative(packageDir, file).split(sep).join("/"));
        } catch {
        }
      }
      if (foreign.length === 0) continue;
      const shown = foreign.slice(0, 5);
      findings.push({
        check: "installed",
        name,
        specifier: null,
        protocol: null,
        where: `${args.modulesDir}/.pnpm/${entry.name} \u2192 ${shown.join(", ")}${foreign.length > shown.length ? ` (+${foreign.length - shown.length} more)` : ""}`,
        detail: `holds ${foreign.length} file(s) whose bytes this pnpm store has never contained \u2014 the shape of a package HAND-PATCHED after install. The version on disk, the manifest and the lockfile all still agree; only the bytes do not, which is how a product typechecks green against an API its declared dependency does not ship. Delete the tree and reinstall (\`rm -rf ${args.modulesDir} && pnpm install --frozen-lockfile\`), then publish whatever change made the patch look necessary.`
      });
    }
  }
  return {
    coverage: {
      basis: "store-cas",
      storeLocated: casDirs.length > 0,
      packagesExamined,
      filesExamined,
      filesHashed
    },
    findings
  };
}
function checkDependencySources(options) {
  const repoDir = resolve(options.repoDir);
  const { scope = "@tangle-network/", modulesDir = "node_modules", exclude = [] } = options;
  const seen = { manifests: [], tarballs: [] };
  walkSourceTree(repoDir, repoDir, exclude, seen);
  const findings = [];
  for (const manifest of seen.manifests) findings.push(...scanManifest(manifest, repoDir));
  const workspaceYaml = join(repoDir, "pnpm-workspace.yaml");
  if (existsSync(workspaceYaml)) findings.push(...scanWorkspaceYaml(workspaceYaml, repoDir));
  const lockfile = join(repoDir, "pnpm-lock.yaml");
  const lockfileScanned = existsSync(lockfile);
  if (lockfileScanned) findings.push(...scanLockfile(lockfile, repoDir));
  for (const tarball of seen.tarballs) {
    findings.push({
      check: "vendored-tarball",
      name: null,
      specifier: null,
      protocol: "tarball",
      where: relative(repoDir, tarball).split(sep).join("/"),
      detail: `is a PACKED TARBALL committed into the source tree. Even when nothing points at it today, it is a build nobody can reproduce from the registry sitting one \`file:\` line away from shipping. Delete it; if ${basename(tarball)} is genuinely test data, move it under a path passed to \`--exclude\`.`
    });
  }
  findings.push(...scanVirtualStore(repoDir, modulesDir));
  const integrity = checkInstalledIntegrity({ repoDir, modulesDir, scope });
  findings.push(...integrity.findings);
  return {
    repoDir,
    manifestsScanned: seen.manifests.length,
    lockfileScanned,
    integrity: integrity.coverage,
    findings,
    ok: findings.length === 0
  };
}
var CHECK_LABEL = {
  declared: "DECLARED",
  override: "OVERRIDE",
  lockfile: "LOCKFILE",
  "vendored-tarball": "TARBALL",
  installed: "INSTALLED"
};
function describeDependencySourceFinding(finding) {
  const subject = finding.name ? `${finding.name}${finding.specifier ? ` (${finding.specifier})` : ""}` : finding.where;
  return `DEPENDENCY SOURCE: ${subject} ${finding.detail}
    at ${finding.where}`;
}
function formatDependencySourceReport(report) {
  const { integrity } = report;
  const integrityLine = integrity.storeLocated ? `  integrity (${integrity.basis}): ${integrity.packagesExamined} package(s), ${integrity.filesExamined} file(s), ${integrity.filesHashed} hashed against the store` : `  integrity (${integrity.basis}): NOT VERIFIED \u2014 no pnpm content-addressed store is reachable from this tree, so no installed bytes were checked against anything`;
  const lines = [
    "dependency sources",
    "",
    `  scanned ${report.manifestsScanned} manifest(s), ${report.lockfileScanned ? "pnpm-lock.yaml" : "no lockfile"}`,
    integrityLine,
    ""
  ];
  if (report.ok) {
    lines.push(
      integrity.storeLocated && integrity.packagesExamined > 0 ? "  ok  every declared source is the registry, and every installed byte came from the store" : "  ok  every declared source is the registry \u2014 installed bytes UNVERIFIED (see above)"
    );
  } else {
    for (const finding of report.findings) {
      lines.push(`  FAIL [${CHECK_LABEL[finding.check]}] ${describeDependencySourceFinding(finding)}`, "");
    }
  }
  return lines.join("\n");
}

// src/peer-floors/check.ts
function installedPackageNames(appDir, modulesDir, scope) {
  const modulesRoot = join2(appDir, modulesDir);
  if (!existsSync2(modulesRoot)) return [];
  if (scope !== "") {
    const scopeDir = join2(modulesRoot, scope.slice(0, -1));
    return existsSync2(scopeDir) ? readdirSync2(scopeDir).sort().map((name) => `${scope}${name}`) : [];
  }
  return readdirSync2(modulesRoot).filter((name) => !name.startsWith(".")).flatMap((name) => name.startsWith("@") ? readdirSync2(join2(modulesRoot, name)).map((child) => `${name}/${child}`) : [name]).sort();
}
function readInstalledManifest(name, fromDir, modulesDir) {
  let dir = fromDir;
  for (; ; ) {
    const manifest = join2(dir, modulesDir, name, "package.json");
    if (existsSync2(manifest)) {
      return JSON.parse(readFileSync2(manifest, "utf8"));
    }
    if (existsSync2(join2(dir, ".git"))) return null;
    const parent = dirname2(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function parseVersion(version) {
  const [core] = version.split(/[-+]/);
  const parts = (core ?? "").split(".").map((p) => Number.parseInt(p, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}
function compare(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (va[i] !== vb[i]) return va[i] < vb[i] ? -1 : 1;
  }
  return 0;
}
function satisfiesComparator(version, comparator) {
  const trimmed = comparator.trim();
  if (!trimmed || trimmed === "*" || trimmed === "x") return true;
  const match = /^(>=|<=|>|<|=|\^|~)?\s*v?(.+)$/.exec(trimmed);
  if (!match) return false;
  const [, op = "=", target = ""] = match;
  const cmp = compare(version, target);
  switch (op) {
    case ">=":
      return cmp >= 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case "<":
      return cmp < 0;
    case "=":
      return cmp === 0;
    case "~": {
      const [major, minor] = parseVersion(target);
      const [vMajor, vMinor] = parseVersion(version);
      return cmp >= 0 && vMajor === major && vMinor === minor;
    }
    case "^": {
      const [major, minor] = parseVersion(target);
      const [vMajor, vMinor] = parseVersion(version);
      if (cmp < 0) return false;
      if (major > 0) return vMajor === major;
      if (minor > 0) return vMajor === 0 && vMinor === minor;
      return vMajor === 0 && vMinor === 0;
    }
    default:
      return false;
  }
}
function satisfiesRange(version, range) {
  return range.split("||").some(
    (alternative) => alternative.trim().split(/\s+/).filter(Boolean).every((c) => satisfiesComparator(version, c))
  );
}
function checkPeerFloors(options) {
  const {
    appDir,
    shell = "@tangle-network/agent-app",
    scope = "@tangle-network/",
    modulesDir = "node_modules"
  } = options;
  const shellManifest = options.shellManifest ?? readInstalledManifest(shell, appDir, modulesDir);
  if (!shellManifest) throw new Error(`${shell} is not installed under ${appDir}`);
  const appManifest = JSON.parse(readFileSync2(join2(appDir, "package.json"), "utf8"));
  const declared = {
    ...appManifest.dependencies,
    ...appManifest.devDependencies,
    ...appManifest.optionalDependencies
  };
  const floors = Object.entries(shellManifest.peerDependencies ?? {}).filter(([name]) => name.startsWith(scope));
  const rows = floors.map(([name, range]) => {
    const installed = readInstalledManifest(name, appDir, modulesDir)?.version ?? null;
    if (installed === null) {
      return { name, range, installed, verdict: declared[name] ? "absent-but-declared" : "absent-unused" };
    }
    return {
      name,
      range,
      installed,
      verdict: satisfiesRange(installed, range) ? "satisfied" : "below-floor"
    };
  });
  const violations = rows.filter((row) => row.verdict === "below-floor" || row.verdict === "absent-but-declared");
  return {
    shell,
    shellVersion: shellManifest.version ?? "unknown",
    rows,
    violations,
    ok: violations.length === 0
  };
}
function checkAllPeerFloors(options) {
  const {
    appDir,
    modulesDir = "node_modules",
    scope = "@tangle-network/"
  } = options;
  const normalizedScope = scope === "" ? "" : scope.endsWith("/") ? scope : `${scope}/`;
  const shells = installedPackageNames(appDir, modulesDir, normalizedScope).filter((name) => {
    const manifest = readInstalledManifest(name, appDir, modulesDir);
    return Object.keys(manifest?.peerDependencies ?? {}).some((peer) => peer.startsWith(normalizedScope));
  });
  if (shells.length === 0) {
    const label = normalizedScope || "package";
    throw new Error(`no installed ${label} package declares a ${label} peer under ${appDir}`);
  }
  return shells.map((shell) => checkPeerFloors({
    appDir,
    modulesDir,
    scope: normalizedScope,
    shell
  }));
}
function describePeerFloorViolation(row, shellVersion, shell = "@tangle-network/agent-app") {
  if (row.verdict === "below-floor") {
    return `PEER FLOOR VIOLATED: ${shell}@${shellVersion} requires ${row.name}@${row.range}, but ${row.installed} is installed. A peer floor encodes a wire contract \u2014 bump the dependency, do not widen the floor. A caret on a 0.x version is minor-locked (^0.36.0 can never resolve to 0.38.0), so reinstalling alone will not fix this: change the pin, in EVERY place it appears including pnpm.overrides.`;
  }
  return `${row.name} is a declared dependency of this app, but no installed version could be read, so its peer floor ${row.range} went UNCHECKED. Failing loudly rather than reporting a pass this guard did not earn.`;
}
function formatPeerFloorReport(report, shell = report.shell) {
  const width = Math.max(...report.rows.map((r) => r.name.length), 4);
  const lines = [
    `${shell}@${report.shellVersion} \u2014 peer floors`,
    "",
    ...report.rows.map((row) => `  ${row.verdict === "satisfied" ? "ok  " : row.verdict.startsWith("absent") ? "--  " : "FAIL"} ${row.name.padEnd(width)}  installed ${(row.installed ?? "(none)").padEnd(10)} floor ${row.range}`),
    "",
    report.ok ? `all ${report.rows.length} floors satisfied` : report.violations.map((row) => describePeerFloorViolation(row, report.shellVersion, shell)).join("\n\n")
  ];
  return lines.join("\n");
}

export {
  classifyDependencySpecifier,
  resolveLocalPathSource,
  checkInstalledIntegrity,
  checkDependencySources,
  describeDependencySourceFinding,
  formatDependencySourceReport,
  satisfiesRange,
  checkPeerFloors,
  checkAllPeerFloors,
  describePeerFloorViolation,
  formatPeerFloorReport
};
//# sourceMappingURL=chunk-BOQ4HVVH.js.map