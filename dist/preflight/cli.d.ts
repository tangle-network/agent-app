#!/usr/bin/env node
import { type PreflightProbe } from './index';
/**
 * Load the probe list from a config module. Fail loud on every miss — a
 * preflight that silently probes nothing and exits 0 is worse than no
 * preflight, because it reports the deploy as verified.
 */
export declare function loadProbes(configPath: string): Promise<PreflightProbe[]>;
/** Run the probes named by `argv` and resolve with the process exit code. */
export declare function runPreflightCli(argv: readonly string[]): Promise<number>;
