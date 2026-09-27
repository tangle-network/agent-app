// src/signoff/config.ts
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import { z } from "zod";
var SIGNOFF_CONFIG_FILES = ["signoff.config.mjs", "signoff.config.js"];
var shuffleSchema = z.object({
  runs: z.number().int().positive().optional(),
  seeds: z.array(z.number().int()).optional(),
  args: z.array(z.string()).optional()
});
var stepSchema = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  needs: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  shuffle: z.union([z.boolean(), shuffleSchema]).optional()
});
var configSchema = z.object({
  install: z.object({
    run: z.string().min(1).optional(),
    storeDirFlag: z.string().nullable().optional(),
    storeEnv: z.string().nullable().optional(),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    env: z.record(z.string(), z.string()).optional()
  }).optional(),
  steps: z.array(stepSchema).min(1),
  maxParallel: z.number().int().positive().optional(),
  env: z.record(z.string(), z.string()).optional(),
  nodeVersion: z.string().min(1).optional(),
  carryFiles: z.array(z.string()).optional(),
  cacheDir: z.string().optional(),
  storeGenerations: z.number().int().positive().optional()
});
function describeIssues(error, where) {
  const lines = error.issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  return `signoff: ${where} is not a valid config:
${lines.join("\n")}`;
}
function parseSignoffConfig(value, where) {
  const result = configSchema.safeParse(value);
  if (!result.success) throw new Error(describeIssues(result.error, where));
  return result.data;
}
var DERIVED_STEPS = [
  { script: "peer-check", name: "peer floors" },
  { script: "typecheck", name: "typecheck" },
  { script: "test:gates", name: "incident-class gates" },
  { script: "test", name: "unit tests", shuffle: true },
  { script: "build", name: "build" },
  { script: "build:check", name: "build + worker checks", supersedes: "build" },
  { script: "test:generated", name: "generated projects", needsBuild: true },
  { script: "knip", name: "dead-surface (knip)" }
];
function deriveSignoffConfig(scripts) {
  const present = DERIVED_STEPS.filter((candidate) => scripts[candidate.script] !== void 0);
  const superseded = new Set(present.map((candidate) => candidate.supersedes).filter((name) => !!name));
  const kept = present.filter((candidate) => !superseded.has(candidate.script));
  const buildStep = kept.find((candidate) => candidate.script === "build" || candidate.script === "build:check");
  const steps = kept.map((candidate) => ({
    name: candidate.name,
    run: `pnpm run ${candidate.script}`,
    ...candidate.shuffle ? { shuffle: true } : {},
    ...candidate.needsBuild && buildStep ? { needs: [buildStep.name] } : {}
  }));
  if (steps.length === 0) {
    throw new Error(
      `signoff: no config and no recognizable scripts. Add a \`signoff.config.mjs\` naming the steps this repo's CI runs, or a package.json "signoff" key. Recognized script names: ${DERIVED_STEPS.map((candidate) => candidate.script).join(", ")}.`
    );
  }
  return { config: { steps }, used: kept.map((candidate) => candidate.script) };
}
async function loadSignoffConfig(options) {
  const { repoRoot, configPath } = options;
  if (configPath !== void 0) {
    const abs = resolve(repoRoot, configPath);
    if (!existsSync(abs)) throw new Error(`signoff: no config at ${abs}`);
    return { config: await importConfig(abs), origin: { kind: "file", path: abs } };
  }
  for (const candidate of SIGNOFF_CONFIG_FILES) {
    const abs = join(repoRoot, candidate);
    if (existsSync(abs)) return { config: await importConfig(abs), origin: { kind: "file", path: abs } };
  }
  const pkgPath = join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`signoff: ${repoRoot} has no package.json, no signoff.config.mjs, and nothing to derive from.`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.signoff !== void 0) {
    return { config: parseSignoffConfig(pkg.signoff, `${pkgPath} "signoff"`), origin: { kind: "package-json", path: pkgPath } };
  }
  const derived = deriveSignoffConfig(pkg.scripts ?? {});
  return { config: derived.config, origin: { kind: "derived", path: pkgPath, scripts: derived.used } };
}
async function importConfig(abs) {
  const mod = await import(pathToFileURL(abs).href);
  const value = mod.default;
  if (value === void 0) throw new Error(`signoff: ${abs} must have a default export`);
  return parseSignoffConfig(value, abs);
}

// src/signoff/run.ts
import { spawnSync as spawnSync2 } from "child_process";
import { existsSync as existsSync6 } from "fs";
import { availableParallelism, homedir } from "os";
import { basename, join as join6, resolve as resolve3 } from "path";

// src/signoff/node-version.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "fs";
import { join as join3 } from "path";

// src/signoff/workflow-pin.ts
import { existsSync as existsSync2, readdirSync, readFileSync as readFileSync2 } from "fs";
import { join as join2 } from "path";
var WORKFLOW_DIR = join2(".github", "workflows");
function scalarValue(raw) {
  const withoutComment = raw.replace(/\s+#.*$/, "").trim();
  const quoted = /^(['"])(.*)\1$/.exec(withoutComment);
  return (quoted?.[2] ?? withoutComment).trim();
}
function indentOf(line) {
  return line.length - line.trimStart().length;
}
function isBlank(line) {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith("#");
}
function triggersOnPullRequest(source) {
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const header = /^(?:on|"on"|'on')\s*:(.*)$/.exec(line);
    if (!header) continue;
    const inline = scalarValue(header[1] ?? "");
    if (inline.length > 0) {
      return inline.replace(/^\[|\]$/g, "").split(",").map((token) => token.trim()).includes("pull_request");
    }
    let nesting = null;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const body = lines[cursor];
      if (isBlank(body)) continue;
      const bodyIndent = indentOf(body);
      if (bodyIndent === 0) break;
      if (nesting === null) nesting = bodyIndent;
      if (bodyIndent !== nesting) continue;
      const key = /^\s*(?:-\s*)?([A-Za-z_][\w-]*)\s*:?\s*$/.exec(body);
      if (key?.[1] === "pull_request") return true;
    }
    return false;
  }
  return false;
}
function pinsInWorkflow(repoRoot, file, source) {
  const pins = [];
  for (const line of source.split("\n")) {
    const match = /^\s*(node-version|node-version-file)\s*:\s*(\S.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = scalarValue(match[2]);
    if (value.includes("${{")) continue;
    if (key === "node-version") {
      pins.push({ file, value, via: "node-version" });
      continue;
    }
    const target = join2(repoRoot, value);
    if (!existsSync2(target)) {
      throw new Error(
        `signoff: ${file} reads its Node pin from "${value}" (node-version-file) and that file does not exist. The workflow this gate replaces cannot itself run, so there is nothing to verify against.`
      );
    }
    const declared = readFileSync2(target, "utf8").split("\n").map((entry) => entry.trim()).find((entry) => entry.length > 0 && !entry.startsWith("#"));
    if (declared !== void 0) pins.push({ file, value: declared, via: `node-version-file ${value}` });
  }
  return pins;
}
function scanMergeGateNodePins(repoRoot) {
  const dir = join2(repoRoot, WORKFLOW_DIR);
  if (!existsSync2(dir)) return [];
  const pins = [];
  const files = readdirSync(dir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml")).sort();
  for (const name of files) {
    const source = readFileSync2(join2(dir, name), "utf8");
    if (!triggersOnPullRequest(source)) continue;
    pins.push(...pinsInWorkflow(repoRoot, `${WORKFLOW_DIR}/${name}`, source));
  }
  return pins;
}
function resolveWorkflowNodePin(repoRoot, majorOf2) {
  const pins = scanMergeGateNodePins(repoRoot);
  if (pins.length === 0) return null;
  const byMajor = /* @__PURE__ */ new Map();
  for (const pin of pins) {
    const major2 = majorOf2(pin.value);
    if (major2 === null) continue;
    const bucket = byMajor.get(major2);
    if (bucket) bucket.push(pin);
    else byMajor.set(major2, [pin]);
  }
  if (byMajor.size === 0) return null;
  if (byMajor.size > 1) {
    const detail = [...byMajor.values()].flat().map((pin) => `  ${pin.file} (${pin.via}): ${pin.value}`).join("\n");
    throw new Error(
      `signoff: the workflows that gate a merge here pin different Node majors, so there is no single runtime to verify:
${detail}
Declare \`nodeVersion\` in the signoff config to say which one a sign-off means.`
    );
  }
  const [entry] = [...byMajor.entries()];
  if (entry === void 0) return null;
  const [major, matched] = entry;
  const first = matched[0];
  const files = [...new Set(matched.map((pin) => pin.file))].join(", ");
  return { major, declared: first.value, source: `${files} (${first.via})` };
}

// src/signoff/node-version.ts
function majorOf(raw) {
  const match = /^v?(\d+)(?:\.|$)/.exec(raw.trim());
  return match?.[1] === void 0 ? null : Number.parseInt(match[1], 10);
}
function resolveNodeRequirement(repoRoot, configured) {
  if (configured !== void 0) {
    const major = majorOf(configured);
    if (major === null) {
      throw new Error(
        `signoff: nodeVersion "${configured}" does not start with a major version. Declare a pin like "22" or "22.22.3".`
      );
    }
    return { major, declared: configured.trim(), source: "signoff config `nodeVersion`" };
  }
  let fromNvmrc = null;
  const nvmrc = join3(repoRoot, ".nvmrc");
  if (existsSync3(nvmrc)) {
    const raw = readFileSync3(nvmrc, "utf8").trim();
    const major = majorOf(raw);
    if (major !== null) fromNvmrc = { major, declared: raw, source: ".nvmrc" };
  }
  const fromWorkflow = resolveWorkflowNodePin(repoRoot, majorOf);
  if (fromNvmrc && fromWorkflow && fromNvmrc.major !== fromWorkflow.major) {
    throw new Error(
      `signoff: .nvmrc pins Node ${fromNvmrc.declared} and ${fromWorkflow.source} pins ${fromWorkflow.declared}. A sign-off that replaces CI cannot verify two runtimes, and picking one silently would sign off a runtime the other half of the repo says is wrong. Make them agree, or declare \`nodeVersion\` in the signoff config.`
    );
  }
  if (fromNvmrc) return fromNvmrc;
  if (fromWorkflow) return { ...fromWorkflow, source: fromWorkflow.source };
  return null;
}
function assertNodeVersion(requirement, running = process.version) {
  if (!requirement) return;
  const runningMajor = majorOf(running);
  if (runningMajor === requirement.major) return;
  throw new Error(
    `signoff: this repo pins Node ${requirement.declared} (${requirement.source}) and you are running ${running}. A sign-off that replaces CI has to verify the runtime the product ships, so this refuses rather than reporting a pass it did not earn. Switch with \`nvm use ${requirement.major}\`, or change the pin if the product really has moved.`
  );
}
function assertNodeTypesVersion(repoRoot, requirement) {
  if (!requirement) return;
  const packagePath = join3(repoRoot, "package.json");
  if (!existsSync3(packagePath)) return;
  const manifest = JSON.parse(readFileSync3(packagePath, "utf8"));
  const declared = manifest.devDependencies?.["@types/node"] ?? manifest.dependencies?.["@types/node"] ?? manifest.optionalDependencies?.["@types/node"];
  if (!declared) return;
  const declaredMajor = /^[~^]?v?(\d+)(?:\.|$)/.exec(declared.trim())?.[1];
  if (declaredMajor !== void 0 && Number.parseInt(declaredMajor, 10) !== requirement.major) {
    throw new Error(
      `signoff: this repo pins Node ${requirement.declared} but declares @types/node ${declared}. Use the latest @types/node ${requirement.major}.x release.`
    );
  }
  const installedPath = join3(repoRoot, "node_modules", "@types", "node", "package.json");
  if (!existsSync3(installedPath)) {
    throw new Error(`signoff: @types/node is declared but missing after install in ${repoRoot}.`);
  }
  const installed = JSON.parse(readFileSync3(installedPath, "utf8"));
  const installedMajor = majorOf(installed.version ?? "");
  if (installedMajor !== requirement.major) {
    throw new Error(
      `signoff: this repo pins Node ${requirement.declared} but installed @types/node@${installed.version ?? "unknown"}. Use the latest @types/node ${requirement.major}.x release.`
    );
  }
}

// src/signoff/exec.ts
import { spawn } from "child_process";
var DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
var DEFAULT_KILL_GRACE_MS = 5e3;
var HEAD_SHARE = 0.25;
var BoundedOutput = class {
  constructor(budget) {
    this.budget = budget;
    this.headBudget = Math.floor(budget * HEAD_SHARE);
    this.tailBudget = budget - this.headBudget;
  }
  budget;
  head = "";
  tail = "";
  total = 0;
  headBudget;
  tailBudget;
  push(chunk) {
    this.total += chunk.length;
    if (this.head.length < this.headBudget) {
      const room = this.headBudget - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
      if (chunk.length === 0) return;
    }
    this.tail = (this.tail + chunk).slice(-this.tailBudget);
  }
  get truncated() {
    return this.total > this.budget;
  }
  text() {
    if (!this.truncated) return this.head + this.tail;
    const elided = this.total - this.head.length - this.tail.length;
    return `${this.head}

[signoff] ${elided} bytes elided (output exceeded ${this.budget} bytes)

${this.tail}`;
  }
};
function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if (err.code !== "ESRCH") throw err;
  }
}
function runCommand(options) {
  const {
    command,
    cwd,
    env,
    timeoutMs,
    signal,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    onData
  } = options;
  return new Promise((resolve4, reject) => {
    const startedAt = Date.now();
    const buffer = new BoundedOutput(maxOutputBytes);
    let timedOut = false;
    let killTimer;
    let graceTimer;
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      // Group leader: lets one signal reach `sh` and everything it spawned.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const pid = child.pid;
    const terminate = () => {
      if (pid === void 0 || child.exitCode !== null || child.signalCode !== null) return;
      killGroup(pid, "SIGTERM");
      graceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) killGroup(pid, "SIGKILL");
      }, killGraceMs);
      graceTimer.unref();
    };
    const onAbort = () => terminate();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== void 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      killTimer.unref();
    }
    const collect = (chunk) => {
      const text = chunk.toString("utf8");
      buffer.push(text);
      onData?.(text);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (err) => {
      cleanup();
      reject(new Error(`signoff: could not start \`${command}\` in ${cwd}: ${err.message}`));
    });
    child.on("close", (code, sig) => {
      cleanup();
      resolve4({
        command,
        cwd,
        // A signalled process reports code `null`; 128+n is the shell's own
        // convention and keeps the field a number a caller can compare.
        exitCode: code ?? (sig === "SIGKILL" ? 137 : 143),
        signal: sig,
        durationMs: Date.now() - startedAt,
        output: buffer.text(),
        truncated: buffer.truncated,
        timedOut
      });
    });
  });
}

// src/signoff/schedule.ts
function validateGraph(nodes) {
  const seen = /* @__PURE__ */ new Set();
  for (const node of nodes) {
    if (seen.has(node.name)) throw new Error(`signoff: two steps are both named "${node.name}"; names must be unique`);
    seen.add(node.name);
  }
  for (const node of nodes) {
    for (const need of node.needs ?? []) {
      if (!seen.has(need)) {
        throw new Error(`signoff: step "${node.name}" needs "${need}", which is not a step in this config`);
      }
    }
  }
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const state = /* @__PURE__ */ new Map();
  const walk = (name, path) => {
    const status = state.get(name);
    if (status === "done") return;
    if (status === "visiting") {
      const cycle = [...path.slice(path.indexOf(name)), name].join(" -> ");
      throw new Error(`signoff: dependency cycle among steps: ${cycle}`);
    }
    state.set(name, "visiting");
    for (const need of byName.get(name)?.needs ?? []) walk(need, [...path, name]);
    state.set(name, "done");
  };
  for (const node of nodes) walk(node.name, []);
}
async function runGraph(options) {
  const { nodes, maxParallel, keepGoing, run, now = () => Date.now() } = options;
  validateGraph(nodes);
  const origin = now();
  const outcomes = /* @__PURE__ */ new Map();
  const pending = new Map(nodes.map((node) => [node.name, node]));
  const running = /* @__PURE__ */ new Map();
  let aborted = false;
  const failedNames = /* @__PURE__ */ new Set();
  const passedNames = /* @__PURE__ */ new Set();
  const blockedBy = (node) => (node.needs ?? []).some((need) => failedNames.has(need));
  const ready = (node) => (node.needs ?? []).every((need) => passedNames.has(need));
  const settle = (name, outcome) => {
    outcomes.set(name, outcome);
    if (outcome.status === "passed") passedNames.add(name);
    else failedNames.add(name);
  };
  const start = (node) => {
    pending.delete(node.name);
    const controller = new AbortController();
    const startedAtMs = now() - origin;
    const promise = run(node, controller.signal).then((result) => {
      const finishedAtMs = now() - origin;
      const cancelled = controller.signal.aborted && !result.ok;
      settle(node.name, {
        name: node.name,
        status: cancelled ? "cancelled" : result.ok ? "passed" : "failed",
        value: result.value,
        startedAtMs,
        finishedAtMs
      });
      running.delete(node.name);
    });
    running.set(node.name, { promise, controller });
  };
  for (; ; ) {
    if (!aborted) {
      for (const node of [...pending.values()]) {
        if (running.size >= maxParallel) break;
        if (blockedBy(node)) {
          pending.delete(node.name);
          settle(node.name, { name: node.name, status: "blocked", value: null, startedAtMs: null, finishedAtMs: null });
          continue;
        }
        if (ready(node)) start(node);
      }
    }
    if (running.size === 0) {
      if (pending.size === 0) break;
      if (aborted) break;
      const progressed = [...pending.values()].some((node) => ready(node) || blockedBy(node));
      if (!progressed) break;
      continue;
    }
    await Promise.race([...running.values()].map((entry) => entry.promise));
    if (!keepGoing && failedNames.size > 0 && !aborted) {
      aborted = true;
      for (const entry of running.values()) entry.controller.abort();
    }
  }
  for (const node of pending.values()) {
    settle(node.name, {
      name: node.name,
      status: blockedBy(node) ? "blocked" : "skipped",
      value: null,
      startedAtMs: null,
      finishedAtMs: null
    });
  }
  return nodes.map((node) => {
    const outcome = outcomes.get(node.name);
    if (!outcome) throw new Error(`signoff: step "${node.name}" produced no outcome \u2014 scheduler bug`);
    return outcome;
  });
}

// src/signoff/seeds.ts
import { createHash, randomInt } from "crypto";
var DEFAULT_SHUFFLE_ARGS = [
  "--sequence.shuffle.files=true",
  "--sequence.seed={seed}"
];
var DEFAULT_SHUFFLE_RUNS = 2;
function newSeedBase() {
  return randomInt(0, 2 ** 31 - 1);
}
function deriveSeed(base, stepName, index) {
  const digest = createHash("sha256").update(`${base}:${stepName}:${index}`).digest();
  return digest.readUInt32BE(0) % 2 ** 31;
}
function assertShuffleArgsReachTheRunner(steps) {
  for (const step of steps) {
    if (!normalizeShuffle(step.shuffle)) continue;
    const tokens = step.run.split(/\s+/).filter((token) => token.length > 0);
    const pnpmAt = tokens.findIndex((token) => token === "pnpm" || token.endsWith("/pnpm"));
    if (pnpmAt === -1) continue;
    if (tokens.slice(pnpmAt + 1).some((token) => token === "run" || token === "exec" || token === "dlx")) continue;
    throw new Error(
      `signoff: step "${step.name}" runs \`${step.run}\` and is shuffled, but pnpm only forwards appended arguments to a script through \`run\`, \`exec\` or \`dlx\`. In the shorthand form pnpm 9 errors and pnpm 10 exits 0 having run nothing, which would report a passing suite that never executed. Write it as \`${step.run.replace(/\s(\S+)$/, " run $1")}\`.`
    );
  }
}
function normalizeShuffle(shuffle) {
  if (shuffle === void 0 || shuffle === false) return null;
  return shuffle === true ? {} : shuffle;
}
function planAttempts(step, seedBase, overrideRuns) {
  const spec = normalizeShuffle(step.shuffle);
  if (!spec) return [{ command: step.run, seed: null }];
  const args = spec.args ?? DEFAULT_SHUFFLE_ARGS;
  const seeds = spec.seeds && spec.seeds.length > 0 ? [...spec.seeds] : Array.from(
    { length: overrideRuns ?? spec.runs ?? DEFAULT_SHUFFLE_RUNS },
    (_unused, index) => deriveSeed(seedBase, step.name, index)
  );
  return seeds.map((seed) => ({
    command: `${step.run} ${args.map((arg) => arg.replaceAll("{seed}", String(seed))).join(" ")}`,
    seed
  }));
}

// src/signoff/store.ts
import { createHash as createHash2 } from "crypto";
import { existsSync as existsSync4, mkdirSync, readFileSync as readFileSync4, readdirSync as readdirSync2, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { join as join4, relative, sep } from "path";
var MANIFEST_FILES = [
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package.json",
  ".npmrc",
  ".nvmrc",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock"
];
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", ".next", ".wrangler", ".react-router"]);
function collectManifests(dir, root, out) {
  for (const entry of readdirSync2(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectManifests(join4(dir, entry.name), root, out);
    } else if (MANIFEST_FILES.includes(entry.name)) {
      out.push(relative(root, join4(dir, entry.name)).split(sep).join("/"));
    }
  }
}
function manifestFiles(treePath) {
  const found = [];
  collectManifests(treePath, treePath, found);
  return found.sort();
}
function manifestCacheKey(treePath, files) {
  const hash = createHash2("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(createHash2("sha256").update(readFileSync4(join4(treePath, rel))).digest("hex"));
    hash.update("\n");
  }
  return hash.digest("hex");
}
function pruneStores(storesRoot, keep) {
  if (!existsSync4(storesRoot)) return [];
  const entries = readdirSync2(storesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const full = join4(storesRoot, entry.name);
    return { full, mtimeMs: statSync(full).mtimeMs };
  }).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const pruned = [];
  for (const stale of entries.slice(keep)) {
    rmSync(stale.full, { recursive: true, force: true });
    pruned.push(stale.full);
  }
  return pruned;
}
function resolveStore(options) {
  const { treePath, cacheDir, generations = 4 } = options;
  const files = manifestFiles(treePath);
  if (files.length === 0) {
    throw new Error(
      `signoff: no package manifest under ${treePath}. A sign-off run installs from a lockfile; there is nothing here to install.`
    );
  }
  const cacheKey = manifestCacheKey(treePath, files);
  const storesRoot = join4(cacheDir, "stores");
  const storeDir = join4(storesRoot, cacheKey);
  const marker = join4(storeDir, ".signoff-store.json");
  const hit = existsSync4(storeDir) && readdirSync2(storeDir).some((entry) => entry !== ".signoff-store.json");
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(marker, `${JSON.stringify({ cacheKey, keyedOn: files, usedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2)}
`);
  const now = /* @__PURE__ */ new Date();
  utimesSync(storeDir, now, now);
  return { storeDir, cacheKey, hit, keyedOn: files, pruned: pruneStores(storesRoot, generations) };
}

// src/signoff/workspace.ts
import { spawnSync } from "child_process";
import { createHash as createHash3 } from "crypto";
import { copyFileSync, existsSync as existsSync5, mkdirSync as mkdirSync2, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "fs";
import { dirname, isAbsolute, join as join5, resolve as resolve2 } from "path";
function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw new Error(`signoff: git ${args.join(" ")} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`signoff: git ${args.join(" ")} exited ${result.status}
${result.stderr.trim()}`);
  }
  return result.stdout;
}
function zsplit(out) {
  return out.split("\0").filter((entry) => entry.length > 0);
}
function repoRootOf(dir) {
  return git(["rev-parse", "--show-toplevel"], dir).trim();
}
function materializeCleanTree(options) {
  const { repoDir, dest, source, carryFiles = [] } = options;
  const root = repoRootOf(repoDir);
  const head = git(["rev-parse", "HEAD"], root).trim();
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], root).trim();
  git(["worktree", "prune"], root);
  mkdirSync2(dirname(dest), { recursive: true });
  if (existsSync5(dest)) rmSync2(dest, { recursive: true, force: true });
  git(["worktree", "add", "--detach", "--quiet", dest, head], root);
  let diffSha256 = null;
  let untrackedFiles = [];
  if (source === "working-tree") {
    const patch = git(["diff", "HEAD", "--binary", "--no-color", "--no-ext-diff"], root);
    if (patch.length > 0) {
      diffSha256 = createHash3("sha256").update(patch).digest("hex");
      const patchFile = join5(dirname(dest), `${dest.split("/").pop() ?? "tree"}.patch`);
      writeFileSync2(patchFile, patch);
      git(["apply", "--binary", "--whitespace=nowarn", patchFile], dest);
      rmSync2(patchFile, { force: true });
    }
    untrackedFiles = zsplit(git(["ls-files", "--others", "--exclude-standard", "-z"], root));
    for (const rel of untrackedFiles) {
      const target = join5(dest, rel);
      mkdirSync2(dirname(target), { recursive: true });
      copyFileSync(join5(root, rel), target);
    }
  }
  const carried = [];
  for (const rel of carryFiles) {
    if (isAbsolute(rel)) throw new Error(`signoff: carryFiles must be repo-relative; got "${rel}"`);
    const from = resolve2(root, rel);
    if (!existsSync5(from)) {
      throw new Error(
        `signoff: carryFiles names "${rel}", which does not exist at ${from}. Remove it from the config or create the file \u2014 installing without it would resolve against a different registry than the one you think you are verifying.`
      );
    }
    const target = join5(dest, rel);
    mkdirSync2(dirname(target), { recursive: true });
    copyFileSync(from, target);
    carried.push(rel);
  }
  return {
    path: dest,
    root,
    head,
    branch,
    source,
    dirty: diffSha256 !== null || untrackedFiles.length > 0,
    diffSha256,
    untrackedFiles,
    carriedFiles: carried
  };
}
function removeCleanTree(tree) {
  git(["worktree", "remove", "--force", tree.path], tree.root);
}

// src/signoff/run.ts
var DEFAULT_CACHE_DIR = join6(homedir(), ".cache", "agent-app-signoff");
function hostFacts(treePath, requirement) {
  const pm = spawnSync2("pnpm", ["--version"], { cwd: treePath, encoding: "utf8" });
  return {
    node: process.version,
    nodePinned: requirement?.declared ?? null,
    nodePinSource: requirement?.source ?? null,
    packageManager: pm.status === 0 ? `pnpm ${pm.stdout.trim()}` : "pnpm (not resolvable)",
    platform: process.platform,
    arch: process.arch,
    cpus: availableParallelism()
  };
}
var SUCCESS_OUTPUT_TAIL = 4e3;
function toAttempt(result, seed, ok) {
  return {
    command: result.command,
    seed,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    output: ok ? result.output.slice(-SUCCESS_OUTPUT_TAIL) : result.output,
    outputTruncated: result.truncated || ok && result.output.length > SUCCESS_OUTPUT_TAIL
  };
}
function buildEnv(base, layers) {
  const env = { ...base };
  for (const layer of layers) {
    if (layer) Object.assign(env, layer);
  }
  return env;
}
function withStoreDir(command, flag, storeDir) {
  if (flag === null) return command;
  return `${command} ${flag ?? "--store-dir"} ${JSON.stringify(storeDir)}`;
}
async function runSignoff(options = {}) {
  const startedAt = /* @__PURE__ */ new Date();
  const wallStart = Date.now();
  const repoDir = resolve3(options.repoDir ?? process.cwd());
  const repoRoot = repoRootOf(repoDir);
  const source = options.source ?? "working-tree";
  let cacheDir = resolve3(options.cacheDir ?? DEFAULT_CACHE_DIR);
  const treePath = () => join6(cacheDir, "trees", `${basename(repoRoot)}-${process.pid}`);
  let tree = null;
  try {
    tree = materializeCleanTree({ repoDir: repoRoot, dest: treePath(), source });
    let loaded = await loadSignoffConfig({ repoRoot: tree.path, configPath: options.configPath });
    cacheDir = resolve3(options.cacheDir ?? loaded.config.cacheDir ?? DEFAULT_CACHE_DIR);
    if (tree.path !== treePath() || (loaded.config.carryFiles?.length ?? 0) > 0) {
      removeCleanTree(tree);
      tree = materializeCleanTree({ repoDir: repoRoot, dest: treePath(), source, carryFiles: loaded.config.carryFiles });
      loaded = await loadSignoffConfig({ repoRoot: tree.path, configPath: options.configPath });
    }
    const { config, origin } = loaded;
    validateGraph(config.steps.map((step) => ({ name: step.name, needs: step.needs })));
    assertShuffleArgsReachTheRunner(config.steps);
    const nodeRequirement = resolveNodeRequirement(tree.path, config.nodeVersion);
    assertNodeVersion(nodeRequirement);
    options.onEvent?.({ kind: "tree", path: tree.path, head: tree.head, dirty: tree.dirty });
    const store = resolveStore({ treePath: tree.path, cacheDir, generations: config.storeGenerations });
    options.onEvent?.({ kind: "store", storeDir: store.storeDir, cacheHit: store.hit, cacheKey: store.cacheKey });
    const installSpec = config.install ?? {};
    const installCwd = join6(tree.path, installSpec.cwd ?? ".");
    const installCommand = withStoreDir(
      installSpec.run ?? "pnpm install --frozen-lockfile",
      installSpec.storeDirFlag,
      store.storeDir
    );
    const storeEnvName = installSpec.storeEnv === null ? null : installSpec.storeEnv ?? "NPM_CONFIG_STORE_DIR";
    const sharedEnv = buildEnv(process.env, [
      // Parity with CI: a runner that behaves differently under `CI` (vitest's
      // reporter, wrangler's prompts) must behave that way here too.
      { CI: "true" },
      config.env,
      storeEnvName === null ? void 0 : { [storeEnvName]: store.storeDir }
    ]);
    options.onEvent?.({ kind: "install-start", command: installCommand });
    const installResult = await runCommand({
      command: installCommand,
      cwd: installCwd,
      env: buildEnv(sharedEnv, [installSpec.env]),
      timeoutMs: installSpec.timeoutMs
    });
    options.onEvent?.({ kind: "install-end", exitCode: installResult.exitCode, durationMs: installResult.durationMs });
    const install = {
      command: installCommand,
      storeDir: store.storeDir,
      cacheKey: store.cacheKey,
      cacheHit: store.hit,
      keyedOn: store.keyedOn,
      exitCode: installResult.exitCode,
      durationMs: installResult.durationMs,
      output: installResult.exitCode === 0 ? installResult.output.slice(-SUCCESS_OUTPUT_TAIL) : installResult.output,
      outputTruncated: installResult.truncated
    };
    const host = hostFacts(tree.path, nodeRequirement);
    const seedBase = options.seed ?? newSeedBase();
    if (installResult.exitCode !== 0) {
      return finish({
        ok: false,
        startedAt,
        wallStart,
        tree,
        origin,
        host,
        install,
        steps: config.steps.map(
          (step) => ({
            name: step.name,
            status: "skipped",
            attempts: [],
            durationMs: 0,
            startedAtMs: null,
            finishedAtMs: null
          })
        ),
        seedBase,
        keepGoing: options.keepGoing ?? false,
        workspaceRetained: options.keepWorkspace ?? false,
        source,
        options
      });
    }
    assertNodeTypesVersion(tree.path, nodeRequirement);
    const treeRoot = tree.path;
    const outcomes = await runGraph({
      nodes: config.steps,
      maxParallel: options.maxParallel ?? config.maxParallel ?? availableParallelism(),
      keepGoing: options.keepGoing ?? false,
      run: async (step, signal) => {
        const attempts = [];
        for (const plan of planAttempts(step, seedBase, options.shuffleRuns)) {
          options.onEvent?.({ kind: "step-start", name: step.name, command: plan.command, seed: plan.seed });
          const result = await runCommand({
            command: plan.command,
            cwd: join6(treeRoot, step.cwd ?? "."),
            env: buildEnv(sharedEnv, [step.env]),
            timeoutMs: step.timeoutMs,
            signal
          });
          const ok = result.exitCode === 0;
          attempts.push(toAttempt(result, plan.seed, ok));
          if (!ok) {
            emitStepEnd(options, step.name, "failed", attempts);
            return { ok: false, value: attempts };
          }
        }
        emitStepEnd(options, step.name, "passed", attempts);
        return { ok: true, value: attempts };
      }
    });
    const steps = outcomes.map(toStepResult);
    return finish({
      ok: steps.every((step) => step.status === "passed"),
      startedAt,
      wallStart,
      tree,
      origin,
      host,
      install,
      steps,
      seedBase,
      keepGoing: options.keepGoing ?? false,
      workspaceRetained: options.keepWorkspace ?? false,
      source,
      options
    });
  } finally {
    if (tree && !options.keepWorkspace && existsSync6(tree.path)) removeCleanTree(tree);
  }
}
function emitStepEnd(options, name, status, attempts) {
  options.onEvent?.({
    kind: "step-end",
    name,
    status,
    durationMs: attempts.reduce((total, attempt) => total + attempt.durationMs, 0)
  });
}
function toStepResult(outcome) {
  const attempts = outcome.value ?? [];
  const durationMs = attempts.reduce((total, attempt) => total + attempt.durationMs, 0);
  return {
    name: outcome.name,
    status: outcome.status,
    attempts,
    durationMs,
    startedAtMs: outcome.startedAtMs,
    finishedAtMs: outcome.finishedAtMs
  };
}
function finish(input) {
  const serialMs = input.install.durationMs + input.steps.reduce((total, step) => total + step.durationMs, 0);
  const flags = [
    `--source ${input.source}`,
    `--seed ${input.seedBase}`,
    ...input.keepGoing ? ["--keep-going"] : []
  ];
  return {
    ok: input.ok,
    startedAt: input.startedAt.toISOString(),
    repo: {
      root: input.tree.root,
      head: input.tree.head,
      branch: input.tree.branch,
      source: input.source,
      dirty: input.tree.dirty,
      diffSha256: input.tree.diffSha256,
      untrackedFiles: input.tree.untrackedFiles,
      carriedFiles: input.tree.carriedFiles
    },
    configOrigin: input.origin,
    workspace: input.tree.path,
    workspaceRetained: input.workspaceRetained,
    host: input.host,
    install: input.install,
    steps: input.steps,
    seedBase: input.seedBase,
    wallClockMs: Date.now() - input.wallStart,
    serialMs,
    keepGoing: input.keepGoing,
    reproduce: `agent-app-signoff ${input.tree.root} ${flags.join(" ")}`
  };
}

// src/signoff/report.ts
var BAR = "\u2500".repeat(72);
function ms(value) {
  return value >= 1e4 ? `${(value / 1e3).toFixed(1)}s` : `${value}ms`;
}
function statusMark(status) {
  switch (status) {
    case "passed":
      return "ok  ";
    case "failed":
      return "FAIL";
    case "cancelled":
      return "kill";
    case "blocked":
      return "blkd";
    case "skipped":
      return "--  ";
  }
}
function seedList(step) {
  const seeds = step.attempts.map((attempt) => attempt.seed).filter((seed) => seed !== null);
  return seeds.length === 0 ? "" : `  seeds ${seeds.join(", ")}`;
}
function peakConcurrency(steps) {
  const events = [];
  for (const step of steps) {
    if (step.startedAtMs === null || step.finishedAtMs === null) continue;
    events.push({ at: step.startedAtMs, delta: 1 }, { at: step.finishedAtMs, delta: -1 });
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}
function formatSignoffReport(report) {
  const lines = [];
  const verdict = report.ok ? "SIGN-OFF PASSED" : "SIGN-OFF FAILED";
  lines.push(BAR, `${verdict} \u2014 ${report.repo.branch} @ ${report.repo.head.slice(0, 12)}`, BAR, "");
  lines.push("subject");
  lines.push(`  repo        ${report.repo.root}`);
  lines.push(`  source      ${report.repo.source}${report.repo.dirty ? " (working tree carries uncommitted work)" : ""}`);
  if (report.repo.diffSha256) lines.push(`  patch       sha256:${report.repo.diffSha256.slice(0, 16)}`);
  if (report.repo.untrackedFiles.length > 0) {
    lines.push(`  untracked   ${report.repo.untrackedFiles.length} file(s) copied in`);
  }
  if (report.repo.carriedFiles.length > 0) lines.push(`  carried     ${report.repo.carriedFiles.join(", ")}`);
  lines.push("");
  lines.push("environment");
  lines.push(`  clean tree  ${report.workspace}${report.workspaceRetained ? " (retained)" : " (removed)"}`);
  lines.push(`  install     ${report.install.command}`);
  lines.push(
    `  store       ${report.install.cacheHit ? "warm" : "cold"} \u2014 ${report.install.cacheKey.slice(0, 16)} (keyed on ${report.install.keyedOn.length} manifest file(s))`
  );
  lines.push(
    `  host        ${report.host.node} \xB7 ${report.host.packageManager} \xB7 ${report.host.cpus} cpus` + (report.host.nodePinned === null ? " \xB7 node UNPINNED by this repo" : ` \xB7 pinned ${report.host.nodePinned} (${report.host.nodePinSource})`)
  );
  lines.push(
    `  config      ${report.configOrigin.kind === "derived" ? `derived from scripts: ${report.configOrigin.scripts.join(", ")}` : report.configOrigin.path}`
  );
  lines.push("");
  const width = Math.max(...report.steps.map((step) => step.name.length), "install".length);
  lines.push("steps");
  lines.push(
    `  ${report.install.exitCode === 0 ? "ok  " : "FAIL"} ${"install".padEnd(width)}  ${ms(report.install.durationMs).padStart(8)}`
  );
  for (const step of report.steps) {
    const window = step.startedAtMs === null || step.finishedAtMs === null ? "" : `  [${ms(step.startedAtMs)} \u2192 ${ms(step.finishedAtMs)}]`;
    lines.push(
      `  ${statusMark(step.status)} ${step.name.padEnd(width)}  ${ms(step.durationMs).padStart(8)}  ${step.attempts.length} run(s)${window}${seedList(step)}`
    );
  }
  lines.push("");
  const peak = peakConcurrency(report.steps);
  const saved = report.serialMs - report.wallClockMs;
  lines.push("timing");
  lines.push(`  wall clock  ${ms(report.wallClockMs)}`);
  lines.push(`  serial sum  ${ms(report.serialMs)} (install + every step, one after another)`);
  lines.push(
    `  parallel    peak ${peak} step(s) at once \u2014 ` + (saved > 0 ? `${ms(saved)} saved, ${(report.serialMs / report.wallClockMs).toFixed(2)}x` : "no overlap available")
  );
  lines.push("");
  const failures = report.steps.filter((step) => step.status === "failed" || step.status === "cancelled");
  if (report.install.exitCode !== 0) {
    lines.push(BAR, "install FAILED \u2014 no step could run", BAR, report.install.output.trimEnd(), "");
  }
  for (const step of failures) {
    const last = step.attempts[step.attempts.length - 1];
    lines.push(BAR);
    lines.push(`${step.status === "cancelled" ? "CANCELLED" : "FAILED"}: ${step.name}`);
    if (last) {
      lines.push(`  command   ${last.command}`);
      lines.push(`  exit      ${last.exitCode}${last.signal ? ` (${last.signal})` : ""}${last.timedOut ? " \u2014 TIMED OUT" : ""}`);
      if (last.seed !== null) {
        lines.push(`  seed      ${last.seed} \u2014 replay this order alone with the same seed`);
      }
      lines.push(BAR, last.output.trimEnd(), "");
    }
  }
  const blocked = report.steps.filter((step) => step.status === "blocked" || step.status === "skipped");
  if (blocked.length > 0) {
    lines.push(`not judged: ${blocked.map((step) => `${step.name} (${step.status})`).join(", ")}`);
    lines.push("");
  }
  lines.push(`reproduce: ${report.reproduce}`);
  return lines.join("\n");
}
function formatSignoffLine(report) {
  const passed = report.steps.filter((step) => step.status === "passed").length;
  return `${report.ok ? "signoff PASS" : "signoff FAIL"} ${report.repo.head.slice(0, 12)} \u2014 ${passed}/${report.steps.length} steps, ${ms(report.wallClockMs)} wall (${ms(report.serialMs)} serial), seed ${report.seedBase}, ${report.install.cacheHit ? "warm" : "cold"} store, clean install`;
}

export {
  loadSignoffConfig,
  runSignoff,
  formatSignoffReport,
  formatSignoffLine
};
//# sourceMappingURL=chunk-35TMEOFA.js.map