import type { Generation } from '../studio/generation';
import type { VaultSaveResult } from '../studio/ports';
/** Overlay successful save results without waiting for the host's next loader
 *  refresh. Every Studio screen owns a different row source, so this small
 *  id-keyed overlay keeps tiles, viewers, and history batch actions coherent. */
export declare function useVaultSaveState(generations: readonly Generation[]): {
    generations: Generation[];
    applySaveResults: (saved: readonly VaultSaveResult[]) => void;
};
