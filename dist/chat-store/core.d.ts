/**
 * Pure (drizzle-free) pieces of the chat store: thread-title derivation, the
 * bulk-delete bound, and the typed input error. Split from `./schema`/`./store`
 * so the root barrel can re-export them without dragging the optional
 * drizzle-orm peer into every root-entry consumer.
 */
/** Bounds a single bulk-delete request's write set; product surfaces cap
 *  thread lists at far fewer, so a larger batch is a malformed or hostile
 *  request. (Lifted from legal's api.threads.bulk-delete route.) */
export declare const BULK_DELETE_MAX_THREADS = 200;
/** Invalid caller input (missing/oversized ids, empty title). Products map it
 *  to a 400; anything else out of the store is a real failure. */
export declare class ChatStoreInputError extends Error {
    constructor(message: string);
}
/** Thread titles come from the first message — keep the list scannable by
 *  storing only its first non-empty line, capped at 80 chars, never the whole
 *  multi-page prompt. (Lifted verbatim from legal's chat.new route.) */
export declare function threadTitleFromMessage(message: string): string;
