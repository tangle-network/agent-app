import type { LoadedSignoffConfig, SignoffConfig } from './types';
export declare function parseSignoffConfig(value: unknown, where: string): SignoffConfig;
export declare function deriveSignoffConfig(scripts: Readonly<Record<string, string>>): {
    readonly config: SignoffConfig;
    readonly used: readonly string[];
};
export interface LoadSignoffConfigOptions {
    readonly repoRoot: string;
    /** Explicit config path. Missing file is an error, never a silent fallback. */
    readonly configPath?: string;
}
export declare function loadSignoffConfig(options: LoadSignoffConfigOptions): Promise<LoadedSignoffConfig>;
