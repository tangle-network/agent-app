# Sign-off — the merge gate for agent-app

**The merge gate is `pnpm signoff`, run locally. CI is not the merge gate.**
A merge whose commit has no valid sign-off proof is a defect, in the same sense a merge with a failing test is a defect — regardless of who merged it or how urgent it was.

This repo also *ships* the gate (`/signoff`, the `agent-app-signoff` bin). The doctrine, the measured comparison against CI, and the calibration against the two failures it replaced are in [`local-signoff.md`](./local-signoff.md); this file is how to use it here.

## Run it

```bash
nvm use            # reads .nvmrc — Node 24.18.0, and the gate REFUSES another major
pnpm signoff --source head
```

`--source head` is the mode that authorizes a merge: it verifies exactly the commit that would land, so the proof binds to a hash somebody else can check out.
The default (`--source working-tree`) verifies HEAD plus your uncommitted work, which is the right mode while you are still writing, and the wrong one for a sign-off — it cannot catch a file you forgot to `git add`.

Useful flags:

| flag | what it is for |
|---|---|
| `--keep-going` | run every step instead of stopping at the first failure |
| `--seed <n>` | replay a previous run's suite orders exactly |
| `--json proof.json` | the machine-readable record |
| `--keep-workspace` | leave the clean tree on disk to inspect |

Exit 0 means every step passed. Exit 1 is a real failure. Exit 2 is a usage or config error, so "your code is broken" and "your gate is misconfigured" are distinguishable.

Attach the proof — the report block, or the one-line `signoff PASS <sha> …` summary — to the pull request that merges the commit.

## What a green run proves

The same source checks `.github/workflows/publish.yml` runs, in a clean `git worktree` with a `--frozen-lockfile` install into a pristine store:

| step | command |
|---|---|
| typecheck | `pnpm run typecheck` |
| incident-class gates | `pnpm run test:gates` |
| unit tests | `pnpm run test`, twice, under randomized file order |
| build | `pnpm run build` |
| generated projects | `pnpm run test:generated` (waits on `build` — the only real artifact edge) |
| dead-surface (knip) | `pnpm run knip` |

Four things it does that CI does not:

- **the runtime is pinned and enforced.** `.nvmrc` says 24.18.0; a different major refuses the run rather than reporting a pass it did not earn.
- **the suite runs under randomized file order**, at least twice, with every seed recorded and a base seed that replays the whole run.
- **the steps run as a dependency graph**, so typecheck, the suite, the build and knip overlap instead of queueing.
- **the failure names itself** — step, command, exit code, seed, captured output, and the exact command that reproduces the run.

`--ignore-scripts=false` is on the install command because a developer machine can carry `ignore-scripts=true` in `~/.npmrc` and a CI runner cannot. Without it `better-sqlite3` links with no compiled binding and 210 tests go red here that CI passes — the gate verifying a different dependency tree than the one that ships. It does not widen what may build; `allowBuilds` in `pnpm-workspace.yaml` still decides that.

`NODE_OPTIONS=--max-old-space-size=4096` is config-level rather than per-step because `prepare` runs the build during the install, before any step exists. It also pins the ceiling: V8 derives its default old-space limit from system RAM, so an unpinned gate is a different gate on a different host.

## What it cannot prove

This list is the calibration's, not a summary of it. Do not soften it when you copy it forward.

**1. A machine-specific pass or fail — MITIGATED one way, CANNOT the other.**
The clean tree carries only what git tracks, so a stray file in the checkout cannot leak in. Everything *outside* the tree is the host's: `PATH`, system libraries, the C toolchain, the Python interpreter and its site-packages.
Both directions are measured. The host **lacking** what a runner has is loud — a missing `better-sqlite3` binding took 210 tests red that CI passes, and the root cause was a host `~/.npmrc` setting that no runner has, closed by putting `--ignore-scripts=false` on the install command.
The host **having** what a runner lacks is silent, and there is no general check for it.

**2. A file that was never committed — CLOSED, but only in `--source head`.**
Measured directly: with an untracked, non-ignored `src/lib/UNCOMMITTED-MODULE.ts` in the repo, `source: 'working-tree'` copies it into the verified tree (`untracked carried: 1`) and `source: 'head'` does not (`untracked carried: 0`).
The default is `working-tree`, and that default **cannot** catch a forgotten `git add` — by design, since its job is to verify what you are about to commit.
**A sign-off that authorizes a merge must be `--source head`.** That is the mode whose proof binds to a commit hash somebody else can check out.

**3. Platform differences — CANNOT.**
The signing host is Linux x86_64, glibc 2.39, ext4, 32 cores, 121 GB. This repo's CI is GitHub-hosted `ubuntu-latest`, whose core count and memory do not appear in the job log, so the hardware gap is known to exist and is not quantified here.
Node major is now pinned and enforced, which removes the one platform variable that had already cost a day. Architecture, libc, filesystem semantics, core count and memory are not pinned and cannot be from inside one machine.
A per-test timeout that encodes machine speed is the live example of this class: a fleet repo has already lost a CI run to a 20 s budget the same test clears with a 3.3x margin locally, and constraining CPU makes the margin *wider*, not narrower, because the cost is concurrent cold imports. A slow-runner timeout is not reproducible on a fast box, full stop.
The honest mitigation is not a gate feature: raise or remove per-test timeouts that encode machine speed.

**4. Secrets and permissions — CANNOT.**
The gate holds no secrets, so every credentialed step is simply absent from the sign-off list. For this repo that is the whole of `publish.yml` — the npm release, its provenance, and the tag. Sign-off says the commit verifies; it says nothing about whether publishing it will succeed.

**Also true, and smaller:**

- **It cannot see what no step checks.** It runs the repo's steps hermetically; it does not invent coverage.
- **A derived config is a weaker claim than a declared one**, which is why the origin is printed in the proof. This repo declares `signoff.config.mjs`.
- **The store cache is a speed lever, not a correctness one.** Correctness comes from `--frozen-lockfile` into a fresh `node_modules`; the cache only decides whether the bytes are already on disk.
- **"Cold" is store-cold, not network-cold in the CI sense.** On a slower connection the cold column grows and the warm column does not.

## What the post-merge workflow does

`.github/workflows/publish.yml` runs the source checks on Node 24.18.0 and repeats them on a clean Node 22 runner before release work.
A failure updates the rolling *Post-merge safety net is red on main* issue.
A passing run builds and uploads the exact release tarballs.
The release tag starts a second, short path that verifies and publishes those same bytes.
It does not install dependencies, rebuild, or repeat the source checks.

The source check list and `signoff.config.mjs` must stay identical.
**Adding a check to one without the other makes the sign-off proof weaker than it reads.**
