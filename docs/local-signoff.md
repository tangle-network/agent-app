# Local sign-off: replacing CI as the merge gate

CI is slow enough that it has stopped being a useful merge gate.
The answer is not to skip verification — it is to make the local run strictly better than CI, and faster, and to leave a proof behind.

This is the doctrine and the measured evidence for `@tangle-network/agent-app/signoff` (`runSignoff`, the `agent-app-signoff` bin).

## Calibration: the two failures that were credited to CI

A gate that cannot catch the failures that actually happened is theater, so both were replayed against it at the real commits.
The first is caught. The second is not, and the reason it is not turned out to be more useful than the reason the first is.

### 1. `Cannot bundle Node.js built-in "node:sqlite"` — CAUGHT, and not for the expected reason

legal-agent `4c0d688` was red in CI on `tests/unit/deadline-calculator.test.ts` and `tests/unit/work-inbox-surface.test.ts`.
The first sign-off run against that exact commit — hermetic tree, clean `--frozen-lockfile` install, two shuffled suite orders — reported **SIGN-OFF PASSED**, 179/179 files green.
A false pass on a commit CI correctly rejected.

The whole difference is the **Node major**, isolated in one installed tree, same bytes, same `node_modules`, running only the two files:

| Node | result |
|---|---|
| v24.13.0 | `Test Files 2 passed (2)`, `Tests 24 passed` |
| v22.23.1 | `Test Files 2 failed (2)`, `Cannot bundle Node.js built-in "node:sqlite" imported from "tests/support/sqlite-d1.ts"` |

CI pins `node-version: 22`. This host runs 24. The observable difference at the Node level is `module.builtinModules`: Node 24 lists `node:sqlite` (72 entries, 4 prefixed), Node 22.23 lists neither `sqlite` nor `node:sqlite` (68 entries, 0 prefixed).

Run under the pinned runtime, the gate reproduces CI **character for character** — same two files, same message, `2 failed | 177 passed (179)` against CI's `2 failed | 177 passed (179)`.

**Suite-order randomization is not what catches this, and believing it did would have been the more expensive error.** Measured at the broken commit:

| runtime | seeds | result |
|---|---|---|
| Node 22 (the pin) | 797775463, 523123045, 407072087, 1636905156 | **4/4 red**, first attempt every time |
| Node 24 (this host's default) | 1022826376, 542962772, 1427235282, 663502913, 799076735, 954458987 | **6/6 green** |
| Node 22, fixed commit `7b5ced4` | 623653136, 547168412, 860652654, 301641746, 2053916066, 1173090525 | **6/6 green** |

Zero extra runs are needed on the right runtime, and no number of runs helps on the wrong one.
So the gap was not determinism. It was that the gate read the Node pin from `signoff.config.mjs` and `.nvmrc`, and **none of tax-agent, legal-agent or agent-app has a `.nvmrc`** — all three pin `node-version: 22` in the workflow being replaced.
The pin was sitting in the file the gate replaces, unread.
`workflow-pin.ts` now reads it (see Decision 5), and on this host the gate refuses legal-agent outright with exit 2 rather than signing off a runtime nobody ships.

### 2. The `buildProductEgressPolicy` breakage — NOT caught, and the stated cause is wrong

legal-agent `main` went red at `b132667`, and the fix commit was `fix(deps): raise the agent-app floor to the version providing buildProductEgressPolicy`.
Three checks, all against the real artifacts:

- **0.45.21 does export it.** `npm pack @tangle-network/agent-app@0.45.21`, then importing `dist/sandbox/index.js` directly: `buildProductEgressPolicy: function`. Present in the JS and in the `.d.ts`.
- **CI's own `peer floors` step passed on the red commit** — `all 9 floors satisfied`, printed in the job log above the failure. `/peer-floors` compares the floors the installed shell declares against the engines resolved on disk; a missing export of agent-app *itself* is not in its domain, and no wording of that check would have caught this.
- **What actually failed** was one test: `tests/unit/sandbox-provision.test.ts > workspace harness pinning > accepts the harness used to compose the prompt`, `Test timed out in 20000ms`, on an `await import()` of the heavy server module graph.

That is a latency failure on a loaded shared runner, not a contract violation.
The gate passes at `b132667` — 180/180 files, twice — because on this host that test takes **6.06 s inside the full suite against a 20 s budget**, a 3.3x margin.
Starving it does not help: pinned to 4 CPUs the same test runs *faster* (1.54 s), because the cost is concurrent cold imports, not CPU share.
This class is in [What this does not claim](#what-this-does-not-claim) and it is not closable locally.

## What the gate does that CI does not

| | CI | local sign-off |
|---|---|---|
| dependency tree | clean install, isolated store | clean `git worktree`, store keyed on the lockfile |
| suite order | one arbitrary order | randomized file order, ≥2 seeds, every seed recorded |
| step order | serial, as written in YAML | dependency graph, run as wide as the graph allows |
| runtime | pinned by the workflow | **read from that same workflow** and refused on a mismatch |
| failure output | one red line inside a long log | named step, command, exit code, seed, captured output |
| reproducibility | re-run the job and hope | one command, printed with the verdict |

## Decision 1 — the clean tree is a `git worktree`, not a filtered copy

Measured on this host, both repos, same moment:

| repo | `git worktree add --detach` | `rsync -a --exclude node_modules --exclude .git` |
|---|---|---|
| agent-app (931 tracked files) | **0.04 s / 11 MB** | 0.12 s / 25 MB |
| legal-agent (753 tracked files) | **0.06 s / 24 MB** | **3.97 s / 2.7 GB** |

The 2.7 GB is the argument, and the contents are worse than the size: the copy carried `build/`, `.react-router/` and `.wrangler/`.
An exclude list is a hand-maintained enumeration of things to leave behind and it is never complete — and a leaked framework cache is *exactly* what made the `node:sqlite` failure invisible locally.
`git` already knows what is source; `.gitignore` is that list, maintained by the repo.

`source: 'working-tree'` (default) overlays `git diff HEAD` as a patch plus untracked non-ignored files — what you are about to commit.
`source: 'head'` verifies exactly the commit that would merge.

## Decision 2 — reuse the store, never the module graph

`node_modules` and every framework cache are recreated per run.
The **store** is reused, keyed on the sha256 of every manifest in the tree: the lockfile, the workspace file, every `package.json`, `.npmrc`.

This is safe because a pnpm store is content-addressed — an entry is named by the hash of what is in it, so a reused entry cannot be a version the lockfile did not ask for.
Reusing it skips downloads, not resolution.
Any manifest byte that could change what gets installed changes the key, and a changed key means an empty store and an honest cold install.
Four generations are kept, so moving between a branch and `main` finds both warm.

Measured, install wall clock, same commit either side:

| repo | cold store (first run on a lockfile) | warm store (unchanged lockfile) |
|---|---|---|
| legal-agent (5 manifest files) | 5.9 s | **1.1 s** |
| tax-agent (12 manifest files) | 8.2 s | **1.2 s** |
| agent-app (15 manifest files) | 70.2 s | **68.3 s** |

agent-app is the caveat on this decision, not a counterexample to it: its install runs `tsup` through the root `prepare`, so ~67 s of both columns is a compile the store cache cannot skip.
The lever is real where the install is dominated by fetching, which is the ordinary case.

## Decision 3 — randomized file order, with the seeds written down

CI runs one arbitrary order, so a scheduling-dependent failure is a coin flip.
Each shuffled step runs twice by default, each time with a seed derived from a base seed that the report prints; passing that base back with `--seed` reproduces every order in the run.

**The flags carry no `--` separator, and that is measured, not assumed.**
The reflex is `pnpm run test -- --flag`, and it silently breaks this. pnpm forwards script arguments verbatim, so the `--` reaches vitest, whose CLI treats it as end-of-options and discards everything after it. Four files, `--reporter=verbose`:

| invocation | seed 1 file order | seed 2 file order |
|---|---|---|
| `vitest run -- --sequence.shuffle.files=true --sequence.seed=N` | schedule, store, seeds, config | schedule, store, seeds, config |
| `vitest run --sequence.shuffle.files=true --sequence.seed=N` | schedule, config, store, seeds | seeds, schedule, config, store |

The first row is a gate reporting two orders while running one fixed order twice — the exact class of failure this module exists to stop, found in the module itself.

Files are shuffled; tests *within* a file are not. Within-file order mostly finds intentional ordering in a `describe`, and an unsatisfiable gate gets waived rather than fixed.

## Decision 4 — steps come from the repo, and run as a graph

The step list is declared (`signoff.config.mjs`, a package.json `signoff` key, or derived from the repo's own scripts with the origin stamped into the proof).
It has to be: the three fleet workflows do not share a shape.

Only real artifact dependencies are declared, so everything else overlaps — and an omitted edge is a correctness bug the YAML's serial order was hiding.
agent-app is the measured proof: `tests/create-agent-app.test.ts` and `tests/create-agent-app-chat.test.ts` `cpSync` the whole `dist/` tree into a generated project, `tsup` is configured `clean: true`, and running the suite alongside the build fails as `dist/ not built — run pnpm build` on one seed and passes on the next.
The suite therefore declares `needs: ['build']`. It costs the overlap between the two longest steps, and the alternative is a gate that intermittently reports a defect it invented.
Fail-fast kills in-flight work through the **process group** — steps run via `sh -c`, so killing the shell alone orphans vitest's forks and tsup's dts worker.
`--keep-going` runs everything and reports a step whose dependency failed as `blocked`: never as passed, never silently omitted.
A failed install marks every step unjudged rather than reporting zero failures.

### agent-app (`.github/workflows/ci.yml`)

Lives at the repo root as [`signoff.config.mjs`](../signoff.config.mjs).
`NODE_OPTIONS` is config-level because `prepare` runs `tsup` during install: the dts worker needs the heap before any step exists.

### legal-agent (`.github/workflows/deploy.yml`, job `ci`)

```js
export default {
  install: { run: 'pnpm install --frozen-lockfile' },
  maxParallel: 4,
  steps: [
    { name: 'peer floors', run: 'pnpm run peer-check' },
    { name: 'route typegen', run: 'pnpm exec react-router typegen' },
    { name: 'typecheck', run: 'pnpm run typecheck', needs: ['route typegen'] },
    { name: 'unit tests', run: 'pnpm run test', needs: ['route typegen'], shuffle: true },
    { name: 'build + worker checks', run: 'pnpm run build:check', needs: ['route typegen'] },
  ],
}
```

The graph makes explicit something the YAML line hid: `react-router typegen` writes the route types that **both** typecheck and the suite read.
Serially that ordering was accidental. Run concurrently it has to be a declared edge, or the two steps race the generator.

### tax-agent (`.github/workflows/deploy.yml`, job `ci`)

```js
export default {
  install: { run: 'pnpm install --frozen-lockfile --filter web...' },
  maxParallel: 4,
  steps: [
    { name: 'peer floors', run: 'pnpm --filter web peer-check' },
    { name: 'typecheck web', run: 'pnpm --filter web typecheck' },
    { name: 'unit tests web', run: 'pnpm --filter web test', shuffle: true },
    { name: 'tax toolkit deps', run: 'python3 -m pip install --quiet -r packages/tax-toolkit/requirements-dev.txt' },
    { name: 'tax toolkit tests', run: "python3 -m unittest discover -s packages/tax-toolkit -p 'test_*.py'", needs: ['tax toolkit deps'] },
    { name: 'build web', run: 'pnpm --filter web build' },
  ],
}
```

Two shapes neither other repo has, and the reason the step list is the repo's rather than the gate's: a **filtered** install (`server/` depends on a sibling repo by `file:` and cannot install in a clean checkout) and two **Python** steps.

## Measured: the whole gate, on all three repos

Every number below is wall clock of the `agent-app-signoff` process on Node 22 — the runtime all three workflows pin — on this host: 32 cores, 121 GB, Linux x86_64, glibc 2.39, ext4, Python 3.12.3.
CI totals include **queue**, because a job that runs 2m40s after waiting 4m costs 6m40s.

| repo | cold store | warm store | CI over 12 runs (median total) | warm vs CI median |
|---|---|---|---|---|
| legal-agent @ `d50a1f4` | 34.0 s | **28.5 s** | 218 s | **7.6x** |
| tax-agent @ `a782779` | 42.3 s | **27.7 s** | 255 s | **9.2x** |
| agent-app @ `2b0bd86` + branch | not measured under this install | **390.1 s** | 433 s | **1.11x** |

Per-step, warm, and what the graph buys:

| repo | install warm | serial sum → wall clock | parallel win | suite orders |
|---|---|---|---|---|
| legal-agent | **1.1 s** | 63.4 s → 28.5 s | 2.22x, peak 3 | 2 |
| tax-agent | **1.2 s** | 75.1 s → 27.7 s | 2.71x, peak 4 | 2 |
| agent-app | **68.3 s** | 442.2 s → 390.1 s | 1.13x, peak 4 | 2 |

**agent-app's two numbers are the honest cost of getting it right, and they are worth reading before quoting the others.**
Its install is 68 s warm rather than a second because `--ignore-scripts=false` lets the root `prepare` run `tsup` during the install, exactly as CI does — the store cache cannot make a compile disappear.
Its parallel win is 1.13x rather than 2x because the suite now waits on the build (Decision 4), which removes the overlap between the two longest steps.
Against a CI median of 433 s that is a 1.11x improvement, not a 5x one. The speed argument for this gate is legal-agent and tax-agent; the agent-app argument is the queue tail and the determinism, not the median.

**Where CI actually loses is the tail, not the median.** Over the last 12 `pull_request` runs per repo:

| repo | runner | queue median | queue max | total median | total max |
|---|---|---|---|---|---|
| legal-agent | self-hosted `ci-linux` | 63 s | 349 s | 218 s | 429 s |
| tax-agent | self-hosted `ci-linux` | 50 s | **4564 s** | 255 s | **5225 s** |
| agent-app | GitHub-hosted `ubuntu-latest` | 4 s | 10 s | 420 s | 487 s |

tax-agent's worst run waited 76 minutes to start. That is the number the local gate replaces, and no amount of CI tuning touches it.

**Two honest deductions from the speedup.**
Part of it is method — the store cache and the dependency graph, both measured above and both machine-independent — and part is hardware, since this host has 32 cores and neither runner publishes its own.
Neither runner's specification appears in its job log, so every comparison here mixes the two effects in a proportion this measurement cannot separate.
The parallel-win and install columns are the parts that are method; the rest is not attributed.

### The install has to defeat the host's npmrc, and that is what unblocked agent-app

An agent-app run reports **FAILED**: 212 tests fail, 210 of them `Could not locate the bindings file` for `better-sqlite3` — a failure CI does not have.

The cause is one line in `~/.npmrc`: `ignore-scripts=true`. pnpm honours it, so no local install ever runs a dependency's build script, and `better-sqlite3` links with no compiled binding. A CI runner has no such file. The ordinary warm checkout fails the same tests, so the gate did not cause it — it inherited it, which is worse: the gate was verifying a **different dependency tree** than the one that ships, and reporting the result as if it were CI's.

Three measurements settle it, same commit, same lockfile, fresh store each time:

| install | binding on disk | install wall | agent-app suite |
|---|---|---|---|
| `pnpm install --frozen-lockfile` | absent | 4.3 s | 212 failed / 4,708 passed |
| `NPM_CONFIG_IGNORE_SCRIPTS=false pnpm install …` | absent | 4.3 s | — |
| `pnpm install --frozen-lockfile --ignore-scripts=false` | `build/Release/better_sqlite3.node` | 20.4 s | 1 failed / 4,925 passed |

The middle row is the trap: the environment variable is silently ignored by pnpm 11.17 in both its upper- and lower-case spellings, so an env-level fix looks applied and changes nothing. The flag has to be on the command line, which means it belongs in the repo's declared `install.run`.

It does not widen what may build — `allowBuilds` in `pnpm-workspace.yaml` still decides that, and it names `better-sqlite3`. It stops a host setting from silently narrowing it.

The one remaining failure was real and was not a host difference: `tests/codemap-fresh.test.ts`, because a new subpath's generated docs had never been regenerated. That is the gate doing its job.

## Decision 7 — the bin must actually run when a consumer invokes it

A package manager installs a bin as a shim that spells the entry through symlinked directories:

```
argv[1]          …/node_modules/.bin/../@scope/pkg/dist/cli.js
import.meta.url  …/node_modules/.pnpm/pkg@1.2.3/node_modules/@scope/pkg/dist/cli.js
```

Node resolves a module's realpath; `process.argv[1]` is the path as spelled. The usual `import.meta.url === pathToFileURL(process.argv[1]).href` self-invocation check is therefore false for every packaged install, and false in the silent direction — the CLI decides it was imported, runs nothing, and **exits 0**.

Measured through a real shim: `pnpm signoff` printed the script banner and exited 0 in under a second, having verified nothing. Not even `--help` produced output.

`invokedAsScript` resolves the entry's realpath before comparing, and its test builds a real symlinked package directory rather than a pair of strings — the defect is precisely that two strings naming one file are unequal, so a string fixture can only encode the assumption that broke.

## Decision 5 — refuse to sign off on a runtime the product does not ship

All three workflows pin `node-version: 22`. A developer shell does not; this host runs 24.
A gate that inherits whatever is on `PATH` verifies a runtime nobody deploys and reports it as the runtime that ships.

So the pin is read from the repo and enforced on the major version; a mismatch refuses the run, exit 2, and names the fix.
Three sources, in order:

1. `nodeVersion` in the signoff config — the explicit declaration.
2. `.nvmrc` — the pin a repo already keeps for humans.
3. the `node-version` of every workflow that triggers on `pull_request` — the pin CI itself runs on.

**The third source exists because the first two were empty on the entire fleet, and that produced a measured false pass** (calibration 1 above).
No `.nvmrc` exists in tax-agent, legal-agent or agent-app; all three pin `node-version: 22` in the workflow the gate replaces.
Reading it is the difference between refusing legal-agent `4c0d688` and signing it off green.

Scope is deliberate: only `pull_request` workflows, because those are the merge gate.
agent-app's `publish.yml` runs Node 24.18.0 for its release jobs and triggers on push; reading it would put the gate in permanent conflict with `ci.yml`'s Node 22.

Nothing in that path guesses.
A `${{ matrix.node }}` expression is not a version, a `node-version-file` that does not exist is an error rather than a shrug, `lts/*` is reported as no pin, and two merge-gate workflows on different majors is a refusal naming both files.
A `.nvmrc` that disagrees with the workflow is also a refusal, not a preference — it means the local gate and CI verify different runtimes, which is exactly the defect this decision exists to prevent.

`engines.node` is deliberately **not** read — it is a floor (`">=18"`), not a pin, and reading it as one would refuse every version above the floor.
When a repo pins nothing anywhere, the report still says `node UNPINNED by this repo` rather than implying a guarantee it does not have.

## Decision 6 — a shuffled step must be able to receive the flags

pnpm forwards extra arguments to a script through `run`, `exec` and `dlx`.
In the shorthand form its own option parser sits in front of them, and what happens next is a version lottery.
Measured on this host, appending `--sequence.shuffle.files=true --sequence.seed=7` to a script that prints its `process.argv`:

| command | pnpm 9.15.9 | pnpm 10.22.0 |
|---|---|---|
| `pnpm run t <flags>` | forwarded, exit 0 | forwarded, exit 0 |
| `pnpm exec node probe.mjs <flags>` | forwarded, exit 0 | forwarded, exit 0 |
| `pnpm t <flags>` | `Unknown options`, exit 1 | exit 254, script never ran |
| `pnpm --filter web t <flags>` | `Unknown options`, exit 1 | **exit 0, script never ran** |

The last cell is why this is a refusal rather than a note.
tax-agent's CI line is `pnpm --filter web test`, and its sign-off config copied it verbatim.
On tax-agent's pinned pnpm 9 that failed loudly and was caught in calibration; on pnpm 10 the same config reports a **green `unit tests web` step that executed zero tests**.
A gate reporting safety it does not provide is the failure class this module exists to prevent, and the shorthand makes it silent.

`assertShuffleArgsReachTheRunner` refuses any shuffled step whose command invokes pnpm without `run`, `exec` or `dlx`, and names the corrected command.

## Reading the proof

```
agent-app-signoff                     # this repo, working tree, default config
agent-app-signoff --source head       # exactly the commit that would merge
agent-app-signoff --seed 12345        # reproduce a previous run's orders
agent-app-signoff --keep-going        # run every step, full picture
agent-app-signoff --json proof.json   # machine-readable record
```

Exit 0 means every declared step passed in a pristine tree.
Exit 1 is a real failure. Exit 2 is a usage or config error, so a script can tell "your code is broken" from "your gate is misconfigured".

The report names the bytes verified (commit + patch digest + untracked file count), the environment (clean tree path, store warm/cold, host, node pin), every step with its seeds and its start→finish window, wall clock against the serial sum, and the command that reproduces the run.

## The engine's own tests were each proven able to fail

86 tests across eight files, and per this repo's rule the green run is not the claim — the mutation is.
Every load-bearing property was broken on purpose, the guarding test was required to go red, and the source was restored and re-diffed:

| mutation | test that went red |
|---|---|
| clean tree enumerates ignored files | leaves the warm cache behind |
| `source: 'head'` applies the working-tree patch anyway | verifies exactly the commit that would merge |
| a missing `carryFiles` entry is skipped | fails loud on a carryFiles entry |
| cache key hashes paths but not content | changes when the lockfile changes |
| manifest walk descends into `node_modules` | never descends into node_modules |
| store prune evicts the newest generation | keeps N generations |
| scheduler forced to one step at a time | overlaps independent steps |
| fail-fast waits instead of aborting | kills what is in flight |
| a blocked step reported as passed | refuses to judge a blocked step |
| seed derivation collapses to the base | separates steps and indices |
| shuffle broadened to `--sequence.shuffle` | shuffles FILES only |
| explicit seeds ignored | explicit seeds win |
| derived config drops the build edge | only the artifact consumer waits |
| `build:check` no longer supersedes `build` | drops `build` because build:check |
| a failed install reports the run as passing | a failed install fails the run |
| step timeout never fires | runs past its timeout |
| seeds not recorded on the attempt | records every seed in the proof |
| patch digest never recorded | names the bytes verified |
| node version check downgraded to a no-op | REFUSES a run on a different major |
| `engines.node` read as a pin | ignores engines.node |
| `.nvmrc` alias guessed instead of reported absent | alias it cannot resolve |
| output head window dropped | keeps BOTH ends of a long log |
| elision marker removed | keeps BOTH ends of a long log |
| kill signals the shell, not the group | kills the whole process GROUP |

24 mutations, 24 red. Two earlier attempts stayed green and both were fixed rather than excused: one test asserted the *absence* of a broader flag instead of the presence of the exact one, and one "mutation" was semantically a no-op.

The calibration work added 15 more, each broken on purpose and watched go red before being restored:

| mutation | test that went red |
|---|---|
| the merge-gate workflow is never consulted for a pin | reads the merge-gate workflow when no .nvmrc exists |
| a `.nvmrc`/workflow disagreement resolved by preference | REFUSES when .nvmrc and the merge-gate workflow name different runtimes |
| an explicit config no longer settles a disagreement | still lets an explicit config declaration settle a disagreement |
| `triggersOnPullRequest` always true | is false for a push-only workflow |
| the scan reads every workflow, not just merge gates | IGNORES a push-only workflow |
| trigger nesting level ignored | does not mistake a trigger OPTION for a trigger |
| a `${{ }}` expression accepted as a version | skips a matrix expression |
| a missing `node-version-file` skipped silently | fails loud on a node-version-file that does not exist |
| trailing comment kept in the value | drops a trailing comment and surrounding quotes |
| no refusal when two merge gates pin different majors | REFUSES when two merge-gate workflows pin different majors |
| the shuffle-forwarding guard downgraded to a no-op | REFUSES the filtered shorthand |
| the guard accepts any token, not just `run`/`exec`/`dlx` | REFUSES the filtered shorthand |
| the guard fires on unshuffled steps too | leaves UNSHUFFLED steps alone |
| the guard fires on non-pnpm commands | says nothing about a command that does not invoke pnpm |
| the fix hint stops naming the corrected command | names the exact command to write instead |

One earlier attempt stayed green and the **test** was fixed rather than the mutation excused: the trigger-option fixture used `pull_request: [opened]`, which the key regex already rejected on its own, so it proved nothing about the nesting check. Replaced with `types:\n  - pull_request`, which only the nesting level can distinguish.

## What this does not claim

Four classes of failure a remote runner can see and this cannot. Each says plainly whether the gate **closes**, **mitigates**, or **cannot** cover it.

**1. A machine-specific pass or fail — MITIGATED one way, CANNOT the other.**
The clean tree carries only what git tracks, so a stray file in the checkout cannot leak in. Everything *outside* the tree is the host's: `PATH`, system libraries, the C toolchain, the Python interpreter and its site-packages.
Both directions are measured. The host **lacking** what a runner has is loud — `better-sqlite3` linked with no compiled binding and 210 agent-app tests went red that CI passes. That one is root-caused to a host `~/.npmrc` (`ignore-scripts=true`) that no runner has, and closed by putting `--ignore-scripts=false` on the declared install command.
The host **having** what a runner lacks is silent, and there is no general check for it. tax-agent's toolkit step ran `python3 -m pip install -r requirements-dev.txt` into the host interpreter with no virtualenv; a package already present here and absent on a fresh runner produces a green step that would be red in CI. **That one is now closed** — the two toolkit steps build a venv per run — but the class is not: `python3` itself, its version, the C toolchain and every system library remain the host's.

**2. A file that was never committed — CLOSED, but only in `--source head`.**
Measured directly: with an untracked, non-ignored `src/lib/UNCOMMITTED-MODULE.ts` in the repo, `source: 'working-tree'` copies it into the verified tree (`untracked carried: 1`) and `source: 'head'` does not (`untracked carried: 0`).
The default is `working-tree`, and that default **cannot** catch a forgotten `git add` — by design, since its job is to verify what you are about to commit.
**A sign-off that authorizes a merge must be `--source head`.** That is the mode whose proof binds to a commit hash somebody else can check out.

**3. Platform differences — CANNOT.**
This host is Linux x86_64, glibc 2.39, ext4, 32 cores, 121 GB. agent-app's CI is GitHub-hosted `ubuntu-latest` (image `ubuntu24/20260720.247`, read from the job log); legal-agent's and tax-agent's is a self-hosted `ci-linux` pool. Neither runner's core count or memory appears in the logs, so the hardware gap is known to exist and is not quantified here.
Node major is now pinned and enforced, which removes the one platform variable that had already cost a day. Architecture, libc, filesystem semantics, core count and memory are not pinned and cannot be from inside one machine.
This is not theoretical: **calibration 2 is exactly this class**. legal-agent `b132667` died on a 20 s test timeout that takes 6.06 s here — a 3.3x margin the gate has no way to consume, and constraining CPU makes it *wider*, not narrower (1.54 s pinned to 4 cores, because the cost is concurrent cold imports). A slow-runner timeout is not reproducible on a fast box, full stop.
The honest mitigation is not a gate feature: raise or remove per-test timeouts that encode machine speed, so the suite stops failing on load.

**4. Secrets and permissions — CANNOT, and one of them matters more than the rest.**
The gate holds no secrets, so every credentialed step is simply absent from the sign-off list.
For tax-agent that includes `wrangler versions upload`, and the workflow's own comment explains why that is not a small omission: `--dry-run` only bundles and never executes the Worker's module scope, so `versions upload` is *the only pre-merge check that proves the Worker actually boots*. An agent-app 0.44 peer-floor bump already passed a green dry-run and then broke every deploy for hours.
Nothing local replaces it. The step needs a real Cloudflare token and a real upload.
`/preflight` covers secret liveness at deploy time; it does not cover this, because this is a build artifact executing in the real runtime.

**Also true, and smaller:**

- **It cannot see what no step checks.** It runs the repo's steps hermetically; it does not invent coverage.
- **A derived config is a weaker claim than a declared one**, which is why the origin is in the proof.
- **The store cache is a speed lever, not a correctness one.** Correctness comes from `--frozen-lockfile` into a fresh `node_modules`; the cache only decides whether the bytes are already on disk.
- **"Cold" here is store-cold, not network-cold in the CI sense.** Measured on legal-agent: a fresh store with the host's pnpm cache intact installs in 5.93 s, and a fresh store with a fresh `XDG_CACHE_HOME` in 6.07 s — 963 MB either way, on this host's link. On a slower connection the cold column grows and the warm column does not.

### The verdict this section supports

Local sign-off can replace CI as the **merge** gate for all three repos — legal-agent, tax-agent and agent-app — run as `--source head`, on the pinned Node, with `--ignore-scripts=false` on the install.
For tax-agent it does not replace `wrangler versions upload`, which has to keep running somewhere with credentials; that check now runs post-merge, so a Worker that throws while initializing is caught after the merge rather than before it.
