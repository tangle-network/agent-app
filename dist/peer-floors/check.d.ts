/**
 * The second half of this gate lives in `./dependency-source` and ships on the
 * SAME subpath and the SAME `agent-app-peer-check` bin, because it answers the
 * question underneath this one: a floor comparison reads a version, and a
 * version is not an identity — a vendored `pnpm pack` of an unmerged branch
 * carries the same `0.45.33` a real release does.
 */
export * from './dependency-source';
/**
 * Audit a consumer's installed tree against the peer floors this package
 * declares.
 *
 * A peer floor is not documentation — it encodes a WIRE CONTRACT, and breaking
 * one is invisible to every other gate. `pnpm` only WARNS on an unmet peer when
 * the package is also a direct dependency, and says nothing at all for an unmet
 * OPTIONAL peer, which is how most of the substrate is declared here. So a
 * product can sit below a floor with a clean install, a clean typecheck, a green
 * suite and a successful deploy, and fail only on a live wire call:
 *
 *   `@tangle-network/sandbox` 0.15.0 → 0.15.1 changed the sidecar spawn body
 *   from `{ command }` to `{ executable, args }`. Below the floor, every
 *   `box.exec()` on a live sandbox returns 400 `Unrecognized key: "command"`.
 *
 *   `@tangle-network/agent-interface` 0.38.0 changed MCP config values from
 *   plain strings to tagged public/secret-ref objects. Below the floor, this
 *   package fails at MODULE LOAD with "does not provide an export named
 *   defineAgentProfilePublicConfig" — while `tsc` reports zero errors, because
 *   the types resolve and only the runtime export is missing.
 *
 * That second shape is why this exists as its own gate: typecheck cannot see it,
 * and a suite only sees it as dozens of unrelated-looking import failures.
 */
/** Installed, and inside the declared range. */
export type PeerFloorVerdict = 'satisfied'
/** Installed and BELOW the floor — the silent case this module exists for. */
 | 'below-floor'
/** Not installed and never asked for. A legitimate answer for an optional peer. */
 | 'absent-unused'
/** Declared by the app, yet no version could be read, so the floor went
 *  UNCHECKED. Reported as a failure rather than a pass this did not earn. */
 | 'absent-but-declared';
export interface PeerFloorRow {
    readonly name: string;
    readonly range: string;
    readonly installed: string | null;
    readonly verdict: PeerFloorVerdict;
}
export interface PeerFloorReport {
    readonly shell: string;
    readonly shellVersion: string;
    readonly rows: readonly PeerFloorRow[];
    readonly violations: readonly PeerFloorRow[];
    readonly ok: boolean;
}
export interface CheckPeerFloorsOptions {
    /** Directory of the app under audit — the one whose `package.json` and
     *  installed tree are read. */
    appDir: string;
    /** Package whose peer floors are the contract. Defaults to this shell. */
    shell?: string;
    /** Only audit peers under this scope. Third-party peers (react, drizzle) are
     *  the app's own business, not part of the Tangle wire contract. Pass `''` to
     *  audit every peer. */
    scope?: string;
    /** Floors to audit against, when the shell is not resolvable from `appDir` —
     *  the package auditing ITSELF, which has no copy of itself in its own
     *  `node_modules`. Without this a package cannot check that the contract it
     *  publishes is one its own dev install satisfies. */
    shellManifest?: {
        version?: string;
        peerDependencies?: Record<string, string>;
    };
    /** Directory name to walk for installed packages. Overridable so a test can
     *  point at a committed fixture tree — `node_modules` is gitignored
     *  everywhere, so a fixture using that name could not be committed, and a
     *  calibration proof that is not committed is a proof that stops running. */
    modulesDir?: string;
}
export type CheckAllPeerFloorsOptions = Pick<CheckPeerFloorsOptions, 'appDir' | 'modulesDir' | 'scope'>;
export declare function satisfiesRange(version: string, range: string): boolean;
/** Audit one app directory against the shell's declared peer floors. */
export declare function checkPeerFloors(options: CheckPeerFloorsOptions): PeerFloorReport;
/** Audit every installed package in `scope` that constrains another package in
 * that scope. This is the complete stack check the CLI runs for consumers. */
export declare function checkAllPeerFloors(options: CheckAllPeerFloorsOptions): readonly PeerFloorReport[];
/** The failure message for one violating row. Split out so a caller can raise
 *  it from a test and a CLI can print it identically. */
export declare function describePeerFloorViolation(row: PeerFloorRow, shellVersion: string, shell?: string): string;
export declare function formatPeerFloorReport(report: PeerFloorReport, shell?: string): string;
