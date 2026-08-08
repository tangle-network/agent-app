# The dependency-source gate

A version number is not an identity.

`/peer-floors` already answers *"is the installed version inside the range the shell declares"*.
This is the question underneath it: *"is the installed package the one the registry publishes at all"*.
Two artifacts can both carry `0.45.33` and ship different APIs, and every gate that reads a version reads the same number for both.

It ships in the same module, on the same `./peer-floors` subpath, behind the same `agent-app-peer-check` bin.
There is no second checker and no second binary — a consumer that already runs the peer-floor gate gets this one by upgrading.

```bash
agent-app-peer-check                    # audits the current directory
agent-app-peer-check ./apps/web         # or a named repo root
agent-app-peer-check --exclude fixtures # skip a path in the source-tree walk
```

Exit code 1 on any violation from either half; 0 otherwise.

## The two defects it was built from

**A vendored tarball, measured.**
insurance-agent's `pnpm-workspace.yaml` carried

```yaml
overrides:
  '@tangle-network/agent-app': file:./vendor/agent-app/tangle-network-agent-app-0.45.33.tgz
```

— a 2.6 MB `pnpm pack` of an unmerged pull request, committed into the product repo.
It installed cleanly, typechecked green and passed its own sign-off gate while the product ran code that existed in no published release and that nobody could reproduce from the registry.
The commit that removed it is `insurance-agent` `f7d0f51`, and the fixture in `src/peer-floors/fixtures/vendored-tarball/` is that tree.

Note where the pin was **not**: `package.json` read `"@tangle-network/agent-app": "^0.45.33"` throughout — an ordinary registry range.
A checker that reads only the root manifest's `dependencies` sees a clean repo.
**The override lane is the one that shipped**, so the override lane is audited first and separately.

**A hand-patched `node_modules`, measured.**
A worktree was found whose installed `agent-app@0.45.29` had `dist/spend/index.d.ts` replaced with a newer version's content — proven against the published tarball, which has zero occurrences of the newer symbol where that copy had four.
The manifest, the lockfile and the version on disk all agreed.
Only the bytes did not, and the product typechecked green against an API its declared dependency does not ship.

## What it detects, and where

Five independent scans. They overlap deliberately: a manifest can be tidied while the lockfile still resolves a tarball, and both can be tidied while the installed tree is untouched.

| Scan | Reads | Catches |
| --- | --- | --- |
| `declared` | every `package.json` in the source tree — `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies` | a non-registry specifier declared outright |
| `override` | `pnpm.overrides` and `resolutions` in every `package.json`, plus `overrides` / `catalog` / `catalogs` in `pnpm-workspace.yaml` | the insurance shape — the lane that outranks every range above it |
| `lockfile` | `pnpm-lock.yaml`'s `overrides`, `importers[].specifier`, and the `packages` / `snapshots` keys | what actually resolved, whatever the manifests now say |
| `vendored-tarball` | the source tree, skipping `node_modules` and build output | a committed `.tgz` — even with nothing pointing at it today |
| `installed` | `node_modules/.pnpm` directory names, and the bytes inside each in-scope package | a tree installed from a tarball or a git ref; a package hand-patched after install |

A specifier is a violation when its protocol is not reproducible: `file:`, `link:`, `portal:`, a path or URL ending in `.tgz` / `.tar.gz`, `git+…`, `github:owner/repo`, the bare `owner/repo` shorthand, or a non-registry `https://` URL.
`workspace:` and `catalog:` are reproducible — `catalog:` is indirection into `pnpm-workspace.yaml`, which this gate audits directly.

## The legitimate exception, as a rule

agent-app's own `playground/package.json` declares `"@tangle-network/agent-app": "file:.."` and that is **correct**: the playground depends on the package it lives inside.

The property that makes it correct is not its path.
It is that the dependency is satisfied by **source already in this repository** — under version control, changing only in a diff a reviewer sees.
So the rule is expressible rather than an allowlist:

> A `file:` / `link:` / `portal:` specifier is exempt when it resolves to a **directory** inside this repository holding a `package.json` whose `name` is the dependency being declared.

Every clause carries weight:

- **a directory** — a `.tgz` is opaque bytes that no diff shows. A packed tarball is never exempt, wherever it sits.
- **inside this repository** — `file:../../agent-app` is a path on one machine. It resolves for its author and nobody else; a clean checkout, a CI runner and a sign-off gate that installs into an exported tree each get a different answer or die at install. (insurance's own vendor README said exactly this, which is why the tarball was committed in-repo rather than pointed at a sibling checkout.)
- **name matches** — a path pointing at some other package's source is a mis-wire, not a self-reference.

Verified against the fleet: tax-agent's `link:../../packages/state-tax-toolkit` (an in-repo monorepo package) passes, and agent-app's `playground` passes, with no path ever named in the checker.

`resolveLocalPathSource` is exported so the four outcomes — `in-repo-source`, `outside-repo`, `not-a-directory`, `name-mismatch` — can be asserted directly.

## Installed-byte integrity: exactly what it proves

This is the honest part, and it is the reason the section exists rather than a green line.

**Full verification is not affordable and is not attempted.**
Comparing installed bytes to the *published* tarball needs the tarball.
`pnpm-lock.yaml` records that tarball's `integrity` (`sha512-…`) and nothing about its contents.
pnpm keeps per-file digests in a store **index** whose format changes between majors — pnpm 10 writes JSON under `store/v10/index/`, pnpm 11 writes a single SQLite database (measured on a real machine: `~/.local/share/pnpm/store/v11/index.db`, 57 MB).
Reading it means a SQLite dependency plus a coupling to store internals, inside a package that ships zero runtime dependencies; re-fetching the tarball means network access inside a gate that must run offline in seconds.

**What is affordable is the content-addressed store.**
A file's bytes live at `<store>/files/<first 2 hex>/<rest>` of their own sha512 — a layout that survived v3 → v10 → v11 while the index format changed twice.
So a file can be asked one question with no dependency and no network: *has this store ever held these bytes?*
Bytes that came out of a package pnpm installed are there by construction.
Bytes typed in afterwards are not.

Two steps, so a run does not hash 30,000 files:

1. `nlink > 1` — the file shares an inode, so it **is** a store blob. One `lstat`, no read. This settles ~99% of files.
2. Everything else is read, hashed, and looked up in every reachable store `files/` directory.

The store is located from `node_modules/.modules.yaml`'s `storeDir` — pure `fs`, no `pnpm store path` subprocess.
Several store majors coexist on a long-lived machine and an existing tree can be linked from an older one, so sibling `v*` directories are searched too (measured on legal-agent: one file resolves in `store/v10/files`, another in `store/v10/v11/files`).

### The hard-link count alone is not the signal

An earlier cut of this check reported any package holding both linked and unlinked files as tampered.
Measured across five real fleet repos it fired once — on legal-agent's `@tangle-network/agent-interface@0.32.0`, whose `dist/environment-provider.js` is `nlink == 1` — and the finding was **false**: `npm pack @tangle-network/agent-interface@0.32.0` yields the identical 11-byte `export {};`.
pnpm simply wrote that copy instead of linking it.

A 1-in-5-repos false alarm is a gate people switch off.
The store lookup is what tells the two apart, and an unlinked file is a reason to **read** the file, never a verdict.

### Scope, and why it is not cosmetic

The integrity pass audits packages under `scope` (default `@tangle-network/`) — the packages whose wire contract this shell owns.
It also keeps native build output out of the pass by construction: `better-sqlite3` compiles `better_sqlite3.node` into its own installed directory after install, and those bytes are correctly absent from the store.
A consumer that widens `scope` to `''` should expect findings on every package with a build step, and should treat that as the pass telling the truth rather than as a false positive.

### Measured

| Repo | Packages | Files | Hashed | Findings |
| --- | --- | --- | --- | --- |
| legal-agent | 44 | 5,909 | 94 | 0 |
| tax-agent | 20 | 2,550 | 0 | 0 |
| gtm-agent | 16 | 1,543 | 0 | 0 |
| workcomp-agent | 17 | 2,107 | 0 | 0 |
| insurance-agent | 26 | 3,718 | 2 | 0 |
| agent-app | 13 | 1,173 | 0 | 0 |

Zero false positives; 35 ms – 1.0 s per repo.
Proven able to fail on a real tree, not only a fixture: replacing `dist/index.d.ts` inside this repo's installed `@tangle-network/agent-interface@0.43.0` produced one `INSTALLED` finding naming that file, and a clean reinstall returned the run to green.

### What it cannot catch

Do not read a clean integrity line as more than this.

1. **A patch whose content came from another package or version already in this store.**
   CAS membership proves *"this store has held these bytes"*, not *"these bytes belong to this package at this version"*.
   The motivating defect — a `.d.ts` overwritten with a newer release's copy — is caught only when that newer release was never installed on the machine.
   This is the real ceiling; closing it needs the per-file index, which is the SQLite coupling rejected above.
2. **An edit that preserves the inode** (`> file`, `cp` onto it).
   The hard link survives and the **store** copy is corrupted along with the installed one, so both agree and nothing local disagrees.
3. **A tampered store.** Everything resolves, everything agrees, all wrong.
4. **Anything at all when no store is reachable** — npm, yarn, a store on another machine, a pruned CI cache.

Case 4 is reported as `integrity (store-cas): NOT VERIFIED …` and the clean line reads `installed bytes UNVERIFIED (see above)`, never a plain pass.
It is deliberately **not** a finding: failing every non-pnpm consumer for ever is how a gate gets deleted rather than adopted.
The declared-source scans still fail normally, and they are the half that catches the insurance shape.

Limits 1 and 2 are pinned by tests named `CANNOT catch …`, so the ceiling cannot move quietly.

## Suppression

There is one escape hatch and it is a path, not a package: `--exclude <repo-relative-prefix>` (repeatable) removes a directory from the **source-tree walk**, which is what a repo carrying a `.tgz` as genuine test data needs.

Excluding a directory is not a way to approve a dependency.
The override, lockfile and installed-tree scans are unaffected by it — `src/peer-floors/dependency-source.test.ts` pins that a `--exclude vendor` run still fails the insurance fixture on the other three lanes.

This package's own self-audit passes `exclude: ['src/peer-floors/fixtures']`, for a stated reason: those trees exist to *contain* the violation, and a calibration tree that also had to be clean could not calibrate anything.

## Calibration fixtures

Committed trees under `src/peer-floors/fixtures/`, whose module directory is `fixture_modules` rather than `node_modules` — every repo gitignores that name, so a fixture using it could not be committed, and a calibration proof that is not committed is a proof that stops running.

pnpm's virtual store nests a *second* module directory inside the first (`node_modules/.pnpm/<key>/node_modules/<pkg>`), so `modulesDir` is threaded through **both** levels rather than hardcoded at the inner one.
In a real install both are `node_modules` and nothing changes; hardcoding the inner one put the fixture's install evidence back behind the gitignore rule the convention exists to dodge, where it would have vanished on a fresh clone and quietly degraded the scan.
`dependency-source.test.ts` asserts that file's existence directly, so the trap cannot recur silently.

- `vendored-tarball/` — insurance's defect, reproduced from `f7d0f51`: a clean `package.json`, the `pnpm-workspace.yaml` override, all three lockfile shapes, the committed pack, and the `file+vendor+agent-app+…tgz` virtual-store directory it installed as. Four findings across four lanes.
- `in-repo-source/` — the exception's reference shape: a playground on `file:..`, a `link:` to an in-repo package, `workspace:*` and `catalog:`. Zero findings.
