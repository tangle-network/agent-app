import type { KeyCrypto } from './index';
/** Prove the at-rest crypto seam before a remote key is minted. */
export declare function assertWorkspaceKeyCryptoUsable(crypto: KeyCrypto): Promise<void>;
