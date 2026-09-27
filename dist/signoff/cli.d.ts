#!/usr/bin/env node
import { type RunSignoffOptions } from './run';
interface ParsedArgs extends RunSignoffOptions {
    readonly jsonPath?: string;
    readonly quiet?: boolean;
}
export declare function parseArgs(argv: readonly string[]): ParsedArgs;
export declare function runSignoffCli(argv: readonly string[]): Promise<number>;
export {};
