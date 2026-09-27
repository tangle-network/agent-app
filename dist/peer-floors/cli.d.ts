#!/usr/bin/env node
interface CliArgs {
    readonly appDir: string;
    readonly exclude: readonly string[];
}
export declare function parsePeerCheckArgs(argv: readonly string[]): CliArgs;
export {};
