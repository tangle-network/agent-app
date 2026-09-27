// src/crypto/index.ts
var IV_LENGTH = 12;
var TAG_LENGTH = 16;
var ALGORITHM = "AES-GCM";
function decodeHexKey(keyHex) {
  if (keyHex.length !== 64) throw new Error("encryption key must be a 64-char hex string (32 bytes)");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 64; i += 2) bytes[i / 2] = parseInt(keyHex.substring(i, i + 2), 16);
  return bytes;
}
async function importKey(keyHex) {
  const raw = decodeHexKey(keyHex);
  return crypto.subtle.importKey("raw", raw.buffer, { name: ALGORITHM }, false, ["encrypt", "decrypt"]);
}
function toBase64(data) {
  let binary = "";
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  return btoa(binary);
}
function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function encryptAesGcm(plaintext, keyHex) {
  const key = await importKey(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv, tagLength: TAG_LENGTH * 8 }, key, new TextEncoder().encode(plaintext));
  const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), IV_LENGTH);
  return toBase64(result);
}
async function decryptAesGcm(encrypted, keyHex) {
  const key = await importKey(keyHex);
  const data = fromBase64(encrypted);
  const iv = data.slice(0, IV_LENGTH);
  const ciphertext = data.slice(IV_LENGTH);
  const plain = await crypto.subtle.decrypt({ name: ALGORITHM, iv, tagLength: TAG_LENGTH * 8 }, key, ciphertext);
  return new TextDecoder().decode(plain);
}
function createFieldCrypto(key) {
  const resolve = typeof key === "function" ? key : () => key;
  return {
    encrypt: (s) => encryptAesGcm(s, resolve()),
    decrypt: (s) => decryptAesGcm(s, resolve())
  };
}
async function deriveKey(secret, opts) {
  const salt = typeof opts.salt === "string" ? new TextEncoder().encode(opts.salt) : opts.salt;
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: opts.iterations, hash: opts.hash ?? "SHA-256" },
    keyMaterial,
    { name: ALGORITHM, length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function encryptWithKey(plaintext, key) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, new TextEncoder().encode(plaintext));
  const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), IV_LENGTH);
  return toBase64(out);
}
async function decryptWithKey(encoded, key) {
  const raw = fromBase64(encoded);
  const iv = raw.slice(0, IV_LENGTH);
  const ciphertext = raw.slice(IV_LENGTH);
  const plain = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext);
  return new TextDecoder().decode(plain);
}
async function encryptBytes(data, key) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, data);
  const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), IV_LENGTH);
  return out.buffer;
}
async function decryptBytes(data, key) {
  const raw = new Uint8Array(data);
  const iv = raw.slice(0, IV_LENGTH);
  const ciphertext = raw.slice(IV_LENGTH);
  return crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext);
}

export {
  decodeHexKey,
  encryptAesGcm,
  decryptAesGcm,
  createFieldCrypto,
  deriveKey,
  encryptWithKey,
  decryptWithKey,
  encryptBytes,
  decryptBytes
};
//# sourceMappingURL=chunk-TA5Q4I2K.js.map