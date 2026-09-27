/**
 * ULID — a 26-character Crockford-base32 id: a 48-bit millisecond timestamp
 * followed by 80 bits from `crypto.getRandomValues`.
 *
 * The record store mints ids in application code rather than taking a column
 * default, because an atomic supersede stamps the REPLACEMENT's id onto the
 * outgoing head in the same write — the id has to exist before the insert.
 * Lexicographic order approximates creation order, which keeps a raw table
 * scan readable; strict fold ordering comes from `seq`, never from the id.
 */
/** Mint a ULID. `now` is exposed so a caller can pin time in a test. */
export declare function recordUlid(now?: number): string;
