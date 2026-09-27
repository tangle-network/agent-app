/**
 * Audit where a repository's dependencies COME FROM.
 *
 * `/peer-floors` already answers "is the installed version inside the declared
 * range". This answers the question underneath it — "is the installed package
 * the one the registry publishes at all" — because a version number is not an
 * identity. Two artifacts can carry `0.45.33` and ship different APIs, and every
 * gate that reads a version reads the same number for both.
 *
 * THE MEASURED DEFECT. insurance-agent's `pnpm-workspace.yaml` carried
 *
 *     overrides:
 *       '@tangle-network/agent-app': file:./vendor/agent-app/tangle-network-agent-app-0.45.33.tgz
 *
 * — a 2.6 MB `pnpm pack` of an UNMERGED pull request, committed into the
 * product repo (`insurance-agent` f7d0f51 removed it). It installed cleanly,
 * typechecked green and passed sign-off while the product ran code that existed
 * in no published release. Note where it was NOT: `package.json` still read
 * `"@tangle-network/agent-app": "^0.45.33"`, a perfectly ordinary registry
 * range. A check that reads only the root manifest's `dependencies` sees
 * nothing. The override lane is the one that shipped, so the override lane —
 * `pnpm-workspace.yaml`, `pnpm.overrides`, `resolutions` — is audited first.
 *
 * The second shape is worse because nothing declares it at all: a worktree was
 * found whose installed `agent-app@0.45.29` had `dist/spend/index.d.ts`
 * replaced with a newer version's content by hand. The manifest, the lockfile
 * and the version on disk all agreed; only the bytes disagreed, and the product
 * typechecked green against an API its declared dependency does not ship. See
 * `checkInstalledIntegrity` below for exactly how much of that class is
 * catchable cheaply and exactly how much is not.
 */
/** How a specifier says a dependency should be obtained. */
export type DependencySourceProtocol = 
/** Resolvable from the registry by anyone: `^1.2.3`, `1.2.3`, `npm:x@1`. */
'registry'
/** `workspace:` — another package in this same repo. Reviewable in one diff. */
 | 'workspace'
/** `catalog:` — indirection into `pnpm-workspace.yaml`, which is itself audited. */
 | 'catalog'
/** A local path. Whether it is legitimate depends on WHERE it points. */
 | 'file' | 'link' | 'portal'
/** A path or URL ending in a packed tarball. Opaque bytes; never legitimate. */
 | 'tarball'
/** A git ref or a remote URL that is not the registry. */
 | 'git' | 'remote';
/**
 * Classify one dependency specifier by the SOURCE it names.
 *
 * Pure and exported so a consumer can reuse the vocabulary, and so the rule can
 * be tested without a filesystem. Nothing here decides legitimacy — `file:` on
 * a directory inside the repo is correct and `file:` on a tarball never is, and
 * that distinction needs the disk (`resolveLocalPathSource`).
 */
export declare function classifyDependencySpecifier(specifier: string): DependencySourceProtocol;
/**
 * The legitimate-exception rule, stated once so it is not a path allowlist.
 *
 * agent-app's own `playground/package.json` declares
 * `"@tangle-network/agent-app": "file:.."` and that is CORRECT: the playground
 * depends on the package it lives inside. The property that makes it correct is
 * not its path — it is that the dependency is satisfied by SOURCE ALREADY IN
 * THIS REPOSITORY, under version control, changing only in a diff a reviewer
 * sees. So the rule is:
 *
 *   A `file:` / `link:` / `portal:` specifier is exempt when it resolves to a
 *   DIRECTORY inside this repository holding a `package.json` whose `name` is
 *   the dependency being declared.
 *
 * Every clause is load-bearing. A DIRECTORY, because a `.tgz` is opaque bytes
 * that no diff shows — a packed tarball is never exempt, wherever it sits.
 * INSIDE THIS REPOSITORY, because `file:../../agent-app` is a path on one
 * machine: it resolves for its author and for nobody else, and a sign-off gate
 * that installs into a clean export dies at install. NAME MATCHES, because a
 * path pointing at some other package's source is a mis-wire, not a
 * self-reference.
 */
export type LocalPathSource = 
/** In-repo directory whose package.json names this dependency. Legitimate. */
'in-repo-source'
/** Points outside the repository — reproducible on one machine only. */
 | 'outside-repo'
/** Nothing there, or not a directory (a packed tarball lands here too). */
 | 'not-a-directory'
/** An in-repo directory, but it is a different package. */
 | 'name-mismatch';
export declare function resolveLocalPathSource(args: {
    /** Directory of the manifest that made the declaration. */
    fromDir: string;
    /** Root of the repository the declaration must stay inside. */
    repoDir: string;
    /** The path part of the specifier, protocol already stripped. */
    path: string;
    /** The dependency name the path is claimed to satisfy. */
    name: string;
}): LocalPathSource;
/** Which of the five scans produced a finding. Kept on the row because the fix
 *  differs: a declaration is edited, an installed tree is reinstalled. */
export type DependencySourceCheck = 
/** A `dependencies`-family field in some `package.json`. */
'declared'
/** `pnpm.overrides` / `resolutions` / `pnpm-workspace.yaml` — the lane that shipped. */
 | 'override'
/** `pnpm-lock.yaml` — what actually resolved, whatever the manifests now say. */
 | 'lockfile'
/** A packed tarball sitting in the source tree. */
 | 'vendored-tarball'
/** The installed tree on disk. */
 | 'installed';
export interface DependencySourceFinding {
    readonly check: DependencySourceCheck;
    /** Dependency name, or `null` for a stray tarball that names no dependency. */
    readonly name: string | null;
    readonly specifier: string | null;
    readonly protocol: DependencySourceProtocol | null;
    /** Repo-relative location, with the key or line that carries it. */
    readonly where: string;
    /** Why this is a finding, and what to do about it. */
    readonly detail: string;
}
/**
 * What the on-disk integrity pass was able to examine — reported on EVERY run,
 * clean or not, because "checked nothing" and "checked everything and found
 * nothing" render identically otherwise. This module's own doctrine: an
 * unchecked contract is never a pass it did not earn.
 */
export interface InstalledIntegrityCoverage {
    /** The only basis implemented. See `checkInstalledIntegrity`'s limits. */
    readonly basis: 'store-cas';
    /** False for npm, yarn, a pruned CI cache, or a store on another machine.
     *  Nothing was verified, and the report says so rather than reading clean. */
    readonly storeLocated: boolean;
    readonly packagesExamined: number;
    readonly filesExamined: number;
    /** Files settled by reading their bytes rather than by a shared inode. */
    readonly filesHashed: number;
}
export interface DependencySourceReport {
    readonly repoDir: string;
    readonly manifestsScanned: number;
    readonly lockfileScanned: boolean;
    readonly integrity: InstalledIntegrityCoverage;
    readonly findings: readonly DependencySourceFinding[];
    readonly ok: boolean;
}
export interface CheckDependencySourcesOptions {
    /** Repository root to audit. */
    repoDir: string;
    /** Scope filter for the on-disk integrity pass. `''` examines every package. */
    scope?: string;
    /** Directory name holding the installed tree. Overridable so a committed
     *  fixture can use `fixture_modules` — `node_modules` is gitignored
     *  everywhere, and a calibration proof that is not committed stops running. */
    modulesDir?: string;
    /** Repo-relative path prefixes the source-tree walk skips. The escape hatch
     *  for a repo that genuinely carries a tarball as test data — and for this
     *  package's own calibration fixtures, whose purpose is to CONTAIN the
     *  violation. */
    exclude?: readonly string[];
}
/**
 * Check each installed package under `scope` against the content-addressed
 * store it was installed from. Returns coverage alongside findings, because a
 * pass that verified nothing must not render like a pass that verified
 * everything.
 */
export declare function checkInstalledIntegrity(args: {
    repoDir: string;
    modulesDir: string;
    scope: string;
}): {
    coverage: InstalledIntegrityCoverage;
    findings: DependencySourceFinding[];
};
/** Audit one repository for dependencies whose source is not the registry. */
export declare function checkDependencySources(options: CheckDependencySourcesOptions): DependencySourceReport;
/** One finding rendered as the failure a reader has to act on. */
export declare function describeDependencySourceFinding(finding: DependencySourceFinding): string;
export declare function formatDependencySourceReport(report: DependencySourceReport): string;
