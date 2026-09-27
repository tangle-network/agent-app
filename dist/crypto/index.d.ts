/**
 * AES-256-GCM field encryption (for PII at rest — SSN/EIN/ID numbers, secrets).
 * WebCrypto only — runs on Cloudflare Workers, Node, and the browser with no
 * Node `crypto` dependency. The 32-byte key is a PARAMETER (64-char hex); the
 * framework never reads env — the product binds its own `ENCRYPTION_KEY` (this
 * is the concrete impl behind the `KeyCrypto` seam in `../billing`).
 *
 * Wire format: base64(iv ‖ ciphertext ‖ tag) — the 12-byte IV is prepended; the
 * GCM auth tag is appended by WebCrypto inside the ciphertext.
 */
/** Validate + decode a 64-char hex key to 32 bytes. Throws on the wrong shape so
 *  a misconfigured key fails loud, never silently weakens encryption. */
export declare function decodeHexKey(keyHex: string): Uint8Array;
/** Encrypt `plaintext` with AES-256-GCM under `keyHex`. Returns
 *  base64(iv ‖ ciphertext ‖ tag). A fresh random IV per call. */
export declare function encryptAesGcm(plaintext: string, keyHex: string): Promise<string>;
/** Decrypt a base64(iv ‖ ciphertext ‖ tag) string under `keyHex`. Throws if the
 *  tag fails (tamper/wrong key). */
export declare function decryptAesGcm(encrypted: string, keyHex: string): Promise<string>;
/** Build a {@link import('../billing').KeyCrypto}-compatible pair bound to a key
 *  (or a key-resolver, for env-backed keys resolved per call). */
export declare function createFieldCrypto(key: string | (() => string)): {
    encrypt(s: string): Promise<string>;
    decrypt(s: string): Promise<string>;
};
/**
 * --- Passphrase-derived key path (PBKDF2 → AES-256-GCM CryptoKey) ---
 *
 * The `encryptAesGcm`/`decryptAesGcm` path takes a raw 64-char-hex key. Some
 * products instead bind a SECRET STRING (not a hex key) and derive the AES key
 * with PBKDF2 — and need a BINARY path (encrypting document bytes, not just
 * strings). Both are exposed here so a product never hand-rolls WebCrypto.
 *
 * The derivation parameters (salt, iterations) are PARAMETERS — a product pins
 * its own so the derived key bytes stay stable for data already at rest. The
 * defaults are a sensible baseline; any product supplies its own via
 * {@link DeriveKeyOptions}.
 */
export interface DeriveKeyOptions {
    /** PBKDF2 salt. A product MUST pin this — changing it changes the derived key
     *  bytes and orphans every value already encrypted at rest. */
    salt: Uint8Array | string;
    /** PBKDF2 iteration count. Pin it for the same reason as `salt`. */
    iterations: number;
    /** PBKDF2 hash. Default `'SHA-256'`. */
    hash?: 'SHA-256' | 'SHA-384' | 'SHA-512';
}
/** Derive an AES-256-GCM `CryptoKey` from a secret string via PBKDF2. The key is
 *  non-extractable and usable only for encrypt/decrypt. */
export declare function deriveKey(secret: string, opts: DeriveKeyOptions): Promise<CryptoKey>;
/** Encrypt `plaintext` under a derived `CryptoKey`. Returns base64(iv ‖ ct ‖ tag). */
export declare function encryptWithKey(plaintext: string, key: CryptoKey): Promise<string>;
/** Decrypt a base64(iv ‖ ct ‖ tag) string under a derived `CryptoKey`. */
export declare function decryptWithKey(encoded: string, key: CryptoKey): Promise<string>;
/** Encrypt binary data under a derived `CryptoKey`. Returns an ArrayBuffer:
 *  12-byte IV ‖ ciphertext ‖ 16-byte GCM tag (same wire layout as the string
 *  path, raw bytes instead of base64). */
export declare function encryptBytes(data: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer>;
/** Decrypt binary data (IV ‖ ciphertext ‖ tag) under a derived `CryptoKey`. */
export declare function decryptBytes(data: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer>;
