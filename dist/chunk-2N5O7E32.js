// src/signoff/proof-record.ts
import { spawnSync as spawnSync2 } from "child_process";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { readFileSync } from "fs";
import { hostname, userInfo } from "os";
import { join as join2 } from "path";
import { z } from "zod";

// src/signoff/proof-git.ts
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
var SignoffGitError = class extends Error {
  args;
  status;
  stderr;
  constructor(args, status, stderr) {
    super(`git ${args.join(" ")} exited ${status ?? "null"}: ${stderr.trim()}`);
    this.name = "SignoffGitError";
    this.args = args;
    this.status = status;
    this.stderr = stderr;
  }
};
function runGit(repoDir, args, options = {}) {
  const result = spawnSync("git", [...args], {
    cwd: repoDir,
    encoding: "utf8",
    input: options.input,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...options.env },
    maxBuffer: 128 * 1024 * 1024
  });
  if (result.error) throw new Error(`git ${args.join(" ")} could not run: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function gitText(repoDir, args, options = {}) {
  const result = runGit(repoDir, args, options);
  if (result.status !== 0) throw new SignoffGitError(args, result.status, result.stderr);
  return result.stdout.replace(/\n$/, "");
}
function gitIsAncestor(repoDir) {
  return (ancestor, descendant) => {
    const result = runGit(repoDir, ["merge-base", "--is-ancestor", ancestor, descendant]);
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw new SignoffGitError(["merge-base", "--is-ancestor", ancestor, descendant], result.status, result.stderr);
  };
}
function resolveCommit(repoDir, rev) {
  return gitText(repoDir, ["rev-parse", "--verify", `${rev}^{commit}`]);
}
function readCommitFacts(repoDir, rev) {
  const commit = resolveCommit(repoDir, rev);
  const record = gitText(repoDir, ["show", "--no-patch", "--format=%T%n%P%n%cI", commit]);
  const [tree, parents, committedAt] = record.split("\n");
  if (tree === void 0 || parents === void 0 || committedAt === void 0) {
    throw new Error(`git show returned an unreadable record for ${commit}: ${JSON.stringify(record)}`);
  }
  return {
    commit,
    commitTree: tree,
    parents: parents.length === 0 ? [] : parents.split(" "),
    committedAt: new Date(committedAt).toISOString()
  };
}
function computeWorktreeTree(repoDir) {
  const scratch = mkdtempSync(join(tmpdir(), "agent-app-signoff-index-"));
  const indexFile = join(scratch, "index");
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    gitText(repoDir, ["add", "-A", "--"], { env });
    return gitText(repoDir, ["write-tree"], { env });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// src/signoff/proof-record.ts
var SIGNOFF_PROOF_VERSION = 1;
var isoString = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, "must be a UTC ISO-8601 timestamp");
var sha1Hex = z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-hex git object id");
var sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "must be a 64-hex sha256 digest");
var SIGNOFF_STEP_STATUSES = ["passed", "failed", "skipped", "cancelled", "blocked"];
var signoffProofStepSchema = z.object({
  /** Stable id a repo's required-step table refers to (`typecheck`, `test`, `knip`, …). */
  id: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1),
  /** How the runner judged the step. Only `passed` can satisfy a requirement. */
  status: z.enum(SIGNOFF_STEP_STATUSES),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  startedAt: isoString,
  /** sha256 of the step's combined stdout+stderr. Logs are not carried; the digest is. */
  outputSha256: sha256Hex
});
var signoffProofPeerSchema = z.object({
  name: z.string().min(1),
  /** `null` when the package is not resolvable on disk — recorded, never guessed. */
  version: z.string().min(1).nullable()
});
var signoffProofSubjectSchema = z.object({
  repo: z.string().min(1),
  commit: sha1Hex,
  /** Tree the checks actually ran against, including uncommitted work. */
  tree: sha1Hex,
  /** Tree the commit itself carries. Equal to `tree` on a clean sign-off. */
  commitTree: sha1Hex,
  parents: z.array(sha1Hex),
  committedAt: isoString
});
var signoffProofBodySchema = z.object({
  proofVersion: z.number().int().positive(),
  subject: signoffProofSubjectSchema,
  signedAt: isoString,
  host: z.object({
    hostname: z.string().min(1),
    platform: z.string().min(1),
    arch: z.string().min(1),
    user: z.string().min(1)
  }),
  tooling: z.object({
    node: z.string().min(1),
    pnpm: z.string().min(1).nullable(),
    peers: z.array(signoffProofPeerSchema)
  }),
  /**
   * Real elapsed time for the whole run. Recorded separately from the steps
   * because the runner schedules them as wide as their dependencies allow, so
   * the sum of step durations is the SERIAL cost and would overstate this.
   */
  wallClockMs: z.number().int().nonnegative(),
  /** Seeds fed to anything non-deterministic, so a reader can reproduce the same run. */
  seeds: z.record(z.string(), z.union([z.string(), z.number()])),
  /** The step ids this run claims were required. The verifier holds the authoritative table. */
  declaredRequired: z.array(z.string().min(1)),
  steps: z.array(signoffProofStepSchema),
  verdict: z.enum(["pass", "fail"])
});
var signoffProofSealSchema = z.object({
  algorithm: z.enum(["sha256", "hmac-sha256"]),
  /** sha256 over the canonical body. Chains the seal to every field, including the commit and tree. */
  bodySha256: sha256Hex,
  /** First 12 hex of sha256(key), so a reader can tell WHICH key sealed this. */
  keyId: z.string().regex(/^[0-9a-f]{12}$/).nullable(),
  mac: sha256Hex.nullable()
});
var signoffProofSchema = z.object({
  body: signoffProofBodySchema,
  seal: signoffProofSealSchema
});
function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`canonicalJson: ${String(value)} is not representable`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value;
  const keys = Object.keys(record).sort();
  const fields = keys.map((key) => {
    const entry = record[key];
    if (entry === void 0) throw new Error(`canonicalJson: field ${JSON.stringify(key)} is undefined`);
    return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
  });
  return `{${fields.join(",")}}`;
}
function canonicalizeProofBody(body) {
  return canonicalJson(body);
}
function hashProofBody(body) {
  return createHash("sha256").update(canonicalizeProofBody(body), "utf8").digest("hex");
}
function hashStepOutput(output) {
  return createHash("sha256").update(output, "utf8").digest("hex");
}
function signoffKeyId(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}
function readSignoffKey(path) {
  const raw = readFileSync(path);
  if (raw.byteLength < 16) throw new Error(`sign-off key at ${path} is ${raw.byteLength} bytes; at least 16 are required`);
  return new Uint8Array(raw);
}
function sealProof(body, key) {
  const canonical = canonicalizeProofBody(body);
  const bodySha256 = createHash("sha256").update(canonical, "utf8").digest("hex");
  if (key === void 0) {
    return { body, seal: { algorithm: "sha256", bodySha256, keyId: null, mac: null } };
  }
  return {
    body,
    seal: {
      algorithm: "hmac-sha256",
      bodySha256,
      keyId: signoffKeyId(key),
      mac: createHmac("sha256", key).update(canonical, "utf8").digest("hex")
    }
  };
}
function macMatches(expected, actual) {
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}
function collectToolingFacts(input) {
  return {
    node: process.version,
    pnpm: readPnpmVersion(input.repoDir),
    peers: input.peerNames.map((name) => ({ name, version: readInstalledVersion(input.repoDir, name) }))
  };
}
function readPnpmVersion(repoDir) {
  const result = spawnSync2("pnpm", ["--version"], { cwd: repoDir, encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}
function readInstalledVersion(repoDir, packageName) {
  try {
    const manifest = JSON.parse(readFileSync(join2(repoDir, "node_modules", packageName, "package.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}
function tangleDependencyNames(repoDir) {
  const manifest = JSON.parse(readFileSync(join2(repoDir, "package.json"), "utf8"));
  const names = /* @__PURE__ */ new Set();
  for (const block of [manifest.dependencies, manifest.peerDependencies, manifest.devDependencies]) {
    for (const name of Object.keys(block ?? {})) {
      if (name.startsWith("@tangle-network/")) names.add(name);
    }
  }
  return [...names].sort();
}
function buildSignoffProof(input) {
  const facts = readCommitFacts(input.repoDir, input.rev ?? "HEAD");
  const body = {
    proofVersion: SIGNOFF_PROOF_VERSION,
    subject: {
      repo: input.repo,
      commit: facts.commit,
      tree: computeWorktreeTree(input.repoDir),
      commitTree: facts.commitTree,
      parents: [...facts.parents],
      committedAt: facts.committedAt
    },
    signedAt: (input.now ?? /* @__PURE__ */ new Date()).toISOString(),
    wallClockMs: Math.max(0, Math.round(input.wallClockMs)),
    host: { hostname: hostname(), platform: process.platform, arch: process.arch, user: userInfo().username },
    tooling: collectToolingFacts({ repoDir: input.repoDir, peerNames: input.peerNames ?? tangleDependencyNames(input.repoDir) }),
    seeds: { ...input.seeds },
    declaredRequired: [...input.declaredRequired],
    steps: input.steps.map((step) => ({ ...step })),
    verdict: input.steps.every((step) => step.status === "passed" && step.exitCode === 0) ? "pass" : "fail"
  };
  return sealProof(signoffProofBodySchema.parse(body), input.key);
}
function parseSignoffProof(json) {
  return signoffProofSchema.parse(JSON.parse(json));
}
function formatDuration(ms) {
  const seconds = Math.round(ms / 1e3);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
function formatSignoffSummary(proof) {
  const { body, seal } = proof;
  const passed = body.steps.filter((step) => step.status === "passed" && step.exitCode === 0).length;
  const serialMs = body.steps.reduce((total, step) => total + step.durationMs, 0);
  const wall = serialMs > body.wallClockMs ? `${formatDuration(body.wallClockMs)} (serial ${formatDuration(serialMs)})` : formatDuration(body.wallClockMs);
  const seeds = Object.entries(body.seeds).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${value}`).join(" ");
  const seal_ = seal.algorithm === "hmac-sha256" ? `sealed ${seal.algorithm} key ${seal.keyId ?? "unknown"}` : `unsealed sha256 ${seal.bodySha256.slice(0, 12)}`;
  const dirty = body.subject.tree === body.subject.commitTree ? "" : " DIRTY-TREE";
  return [
    `signoff ${body.verdict}${dirty}`,
    `${passed}/${body.steps.length} steps`,
    wall,
    `${body.subject.repo}@${body.subject.commit.slice(0, 9)} tree ${body.subject.tree.slice(0, 9)}`,
    seeds.length === 0 ? "seeds none" : `seeds ${seeds}`,
    `node ${body.tooling.node} pnpm ${body.tooling.pnpm ?? "unresolved"}`,
    seal_,
    body.signedAt
  ].join(" \xB7 ");
}

// src/signoff/proof-attach.ts
var SIGNOFF_NOTES_REF = "refs/notes/signoff";
var SIGNOFF_NOTES_GIT_CONFIG = [
  `git config --add remote.origin.fetch '+${SIGNOFF_NOTES_REF}:${SIGNOFF_NOTES_REF}'`,
  `git config --add remote.origin.push '${SIGNOFF_NOTES_REF}'`,
  `git config notes.rewriteRef '${SIGNOFF_NOTES_REF}'`,
  "git config notes.rewrite.amend true",
  "git config notes.rewrite.rebase true"
];
function attachSignoffProof(input) {
  const commit = resolveCommit(input.repoDir, input.rev ?? input.proof.body.subject.commit);
  const args = ["notes", `--ref=${SIGNOFF_NOTES_REF}`, "add"];
  if (input.overwrite === true) args.push("-f");
  args.push("-F", "-", commit);
  const result = runGit(input.repoDir, args, { input: `${JSON.stringify(input.proof, null, 2)}
` });
  if (result.status !== 0) throw new SignoffGitError(args, result.status, result.stderr);
  return { commit, ref: SIGNOFF_NOTES_REF };
}
function readSignoffProofNote(repoDir, rev) {
  const commit = resolveCommit(repoDir, rev);
  const result = runGit(repoDir, ["notes", `--ref=${SIGNOFF_NOTES_REF}`, "show", commit]);
  if (result.status !== 0) return { found: false, commit };
  return { found: true, proof: parseSignoffProof(result.stdout), commit, binding: "exact" };
}
function listSignoffProofs(repoDir) {
  const listed = runGit(repoDir, ["notes", `--ref=${SIGNOFF_NOTES_REF}`, "list"]);
  if (listed.status !== 0) return [];
  const out = [];
  for (const line of listed.stdout.split("\n")) {
    const [noteBlob, commit] = line.trim().split(/\s+/);
    if (noteBlob === void 0 || commit === void 0) continue;
    out.push({ commit, proof: parseSignoffProof(gitText(repoDir, ["cat-file", "blob", noteBlob])) });
  }
  return out;
}
function resolveSignoffProof(repoDir, rev) {
  const direct = readSignoffProofNote(repoDir, rev);
  if (direct.found) return direct;
  const facts = readCommitFacts(repoDir, rev);
  for (const entry of listSignoffProofs(repoDir)) {
    if (entry.proof.body.subject.commitTree === facts.commitTree) {
      return { found: true, proof: entry.proof, commit: facts.commit, binding: "tree-equivalent" };
    }
  }
  return { found: false, commit: facts.commit };
}

// src/signoff/proof-verify.ts
import { readFileSync as readFileSync2 } from "fs";
import { createHmac as createHmac2 } from "crypto";
var SIGNOFF_REQUIRED_STEPS = {
  "agent-app": ["install", "typecheck", "test:gates", "test", "build", "test:generated", "knip"],
  "tax-agent": ["install", "peer-check", "typecheck", "test", "toolkit-deps", "toolkit-test", "build", "worker-startup"],
  "legal-agent": ["install", "peer-check", "typegen", "typecheck", "test", "build:check"]
};
function verifySignoffProof(proof, options) {
  const failures = [];
  const { body, seal } = proof;
  const target = options.target;
  if (body.proofVersion !== SIGNOFF_PROOF_VERSION) {
    failures.push({ code: "unsupported-version", detail: `proof declares version ${body.proofVersion}; this verifier reads ${SIGNOFF_PROOF_VERSION}` });
  }
  const recomputed = hashProofBody(body);
  if (recomputed !== seal.bodySha256) {
    failures.push({ code: "body-tampered", detail: `seal claims body sha256 ${seal.bodySha256}; the body hashes to ${recomputed}` });
  }
  let macChecked = false;
  if (options.key !== void 0) {
    if (seal.mac === null) {
      failures.push({ code: "mac-missing", detail: "a key was supplied but the proof carries no mac; it was produced unsealed" });
    } else {
      const expected = createHmac2("sha256", options.key).update(canonicalizeProofBody(body), "utf8").digest("hex");
      if (macMatches(expected, seal.mac)) macChecked = true;
      else failures.push({ code: "mac-invalid", detail: `mac does not verify under the supplied key (proof keyId ${seal.keyId ?? "none"})` });
    }
  }
  if (options.expectRepo !== void 0 && options.expectRepo !== body.subject.repo) {
    failures.push({ code: "repo-mismatch", detail: `proof is for repo ${body.subject.repo}; ${options.expectRepo} was requested` });
  }
  let requiredSteps = options.requiredSteps ?? [];
  if (options.requiredSteps === void 0) {
    const known = SIGNOFF_REQUIRED_STEPS[body.subject.repo];
    if (known === void 0) {
      failures.push({ code: "unknown-repo", detail: `no required-step table for ${body.subject.repo}; a repo with no declared bar cannot be signed off` });
    } else {
      requiredSteps = known;
    }
  }
  const seen = /* @__PURE__ */ new Map();
  for (const step of body.steps) seen.set(step.id, (seen.get(step.id) ?? 0) + 1);
  for (const [id, count] of seen) {
    if (count > 1) failures.push({ code: "duplicate-step", detail: `step ${id} appears ${count} times; a repeated id makes coverage ambiguous` });
  }
  const missing = requiredSteps.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    failures.push({ code: "missing-required-step", detail: `required step(s) never ran: ${missing.join(", ")}` });
  }
  const declared = new Set(body.declaredRequired);
  const understated = requiredSteps.filter((id) => !declared.has(id));
  if (understated.length > 0) {
    failures.push({ code: "lowered-bar", detail: `proof declares a smaller required set than ${body.subject.repo}'s table; missing: ${understated.join(", ")}` });
  }
  for (const step of body.steps) {
    if (step.status !== "passed") {
      failures.push({ code: "step-failed", detail: `step ${step.id} is ${step.status}, not passed (exit ${step.exitCode}, ${step.command})` });
    } else if (step.exitCode !== 0) {
      failures.push({ code: "step-failed", detail: `step ${step.id} claims status passed but exited ${step.exitCode} (${step.command})` });
    }
  }
  if (body.verdict !== "pass") {
    failures.push({ code: "verdict-fail", detail: `the run recorded verdict ${body.verdict}` });
  }
  if (body.subject.tree !== body.subject.commitTree) {
    failures.push({
      code: "dirty-worktree",
      detail: `checks ran against tree ${body.subject.tree} while the commit carries ${body.subject.commitTree}; uncommitted work was in the tree`
    });
  }
  if (body.subject.commitTree !== target.commitTree) {
    failures.push({ code: "tree-mismatch", detail: `proof covers tree ${body.subject.commitTree}; ${target.commit} carries ${target.commitTree}` });
  }
  const commitBinding = body.subject.commit === target.commit ? "exact" : body.subject.commitTree === target.commitTree ? "tree-equivalent" : "none";
  if (commitBinding === "none") {
    failures.push({ code: "commit-unbound", detail: `proof names commit ${body.subject.commit}, which is neither ${target.commit} nor its content` });
  }
  const signedAt = Date.parse(body.signedAt);
  if (signedAt < Date.parse(body.subject.committedAt)) {
    failures.push({ code: "stale-proof", detail: `signed at ${body.signedAt}, before the commit it names was written at ${body.subject.committedAt}` });
  }
  if (commitBinding === "tree-equivalent" && options.isAncestor(body.subject.commit, target.commit)) {
    failures.push({
      code: "stale-proof",
      detail: `${body.subject.commit} is an ancestor of ${target.commit}; the tree matches only because later work was undone, and that work was never signed off`
    });
  }
  return { ok: failures.length === 0, commitBinding, macChecked, failures, proof, target, requiredSteps };
}
function verifySignoffAtRev(input) {
  const lookup = resolveSignoffProof(input.repoDir, input.rev);
  const target = readCommitFacts(input.repoDir, input.rev);
  if (!lookup.found) return { found: false, commit: lookup.commit, hint: SIGNOFF_NOTES_GIT_CONFIG };
  return {
    found: true,
    ...verifySignoffProof(lookup.proof, {
      target,
      isAncestor: gitIsAncestor(input.repoDir),
      key: input.key,
      requiredSteps: input.requiredSteps,
      expectRepo: input.expectRepo
    })
  };
}
function verifySignoffProofFile(input) {
  const proof = parseSignoffProof(readFileSync2(input.file, "utf8"));
  const target = readCommitFacts(input.repoDir, input.rev);
  return verifySignoffProof(proof, {
    target,
    isAncestor: gitIsAncestor(input.repoDir),
    key: input.key,
    requiredSteps: input.requiredSteps,
    expectRepo: input.expectRepo
  });
}
function formatSignoffVerification(result) {
  const head = result.ok ? `VERIFIED ${result.proof.body.subject.repo}@${result.target.commit.slice(0, 9)} binding=${result.commitBinding} mac=${result.macChecked ? "checked" : "unchecked"}` : `REJECTED ${result.proof.body.subject.repo}@${result.target.commit.slice(0, 9)} binding=${result.commitBinding} (${result.failures.length} failure${result.failures.length === 1 ? "" : "s"})`;
  return [head, ...result.failures.map((failure) => `  ${failure.code}: ${failure.detail}`)].join("\n");
}

export {
  readCommitFacts,
  hashStepOutput,
  readSignoffKey,
  buildSignoffProof,
  parseSignoffProof,
  formatSignoffSummary,
  attachSignoffProof,
  verifySignoffProof,
  verifySignoffAtRev,
  verifySignoffProofFile,
  formatSignoffVerification
};
//# sourceMappingURL=chunk-2N5O7E32.js.map