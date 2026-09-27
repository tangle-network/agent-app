import { type SignoffProofStep } from './proof-record';
export interface TempRepo {
    readonly dir: string;
    write(relativePath: string, contents: string): void;
    commit(message: string): string;
    git(args: readonly string[]): string;
    cleanup(): void;
}
export declare function createTempRepo(options?: {
    readonly name?: string;
}): TempRepo;
/** Steps that all succeeded, one per id, with plausible timings. */
export declare function passingSteps(ids: readonly string[]): SignoffProofStep[];
