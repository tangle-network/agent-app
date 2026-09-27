export interface StoreResolution {
    readonly storeDir: string;
    readonly cacheKey: string;
    /** True when a store for this key already had content. */
    readonly hit: boolean;
    /** Repo-relative manifest paths, sorted — the inputs to `cacheKey`. */
    readonly keyedOn: readonly string[];
    /** Store directories removed by the generation cap. */
    readonly pruned: readonly string[];
}
export interface ResolveStoreOptions {
    /** The clean tree whose manifests are hashed. */
    readonly treePath: string;
    readonly cacheDir: string;
    /** Generations to keep. Default 4. */
    readonly generations?: number;
}
/** Every manifest in the tree, repo-relative and sorted. */
export declare function manifestFiles(treePath: string): string[];
/** sha256 over each manifest's path and content — order-independent by sorting. */
export declare function manifestCacheKey(treePath: string, files: readonly string[]): string;
export declare function resolveStore(options: ResolveStoreOptions): StoreResolution;
