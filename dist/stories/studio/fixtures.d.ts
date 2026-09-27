import type { FetchGenerationsPage, Generation, GenerationPage } from '../../studio';
/** Tiny browser-native silent WAV used by stories that exercise real playback. */
export declare function silentWavDataUri(seconds: number): string;
export declare const teaserA: Generation;
export declare const storyboardGeneration: Generation;
export declare const videoGeneration: Generation;
export declare const avatarGeneration: Generation;
export declare const speechGeneration: Generation;
export declare const speechGenerationPlayable: Generation;
export declare const transcriptionGeneration: Generation;
export declare const queuedGeneration: Generation;
export declare const runningGeneration: Generation;
export declare const failedGeneration: Generation;
export declare const storageFailedGeneration: Generation;
/** The four-image batch a single "Images: 4" run produces. */
export declare const teaserBatch: Generation[];
/** Populated library: the newest batch first, every type and status represented. */
export declare const libraryGenerations: Generation[];
export declare const libraryTotalCost = 1.87;
/** Large enough to exercise search, filtering, and a second cursor page. */
export declare const historyGenerations: Generation[];
export declare function makeGenerationPage(items: Generation[], nextCursor?: string): GenerationPage;
/** In-memory version of the history endpoint, including abortable latency. */
export declare function fakeFetchGenerationsPage(all: Generation[]): FetchGenerationsPage;
/** Demo story route for opening a persisted generation in the vault. */
export declare const demoVaultHref: (filePath?: string | null) => string;
