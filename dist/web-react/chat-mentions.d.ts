/**
 * Transcript-side counterpart to the composer's `@`-mention primitive
 * (sandbox-ui#184). The composer serializes a picked file into the message
 * text as `@<path>`; this module is the exact inverse — it finds those tokens
 * again in a PERSISTED message and splits the text so a renderer can draw a
 * pill where the user typed one and leave the rest as prose.
 *
 * Pure and product-agnostic: no React, no fetch, no DOM. The only input beyond
 * the text is the message's OWN mention parts, so one message can never render
 * a pill for a path another message mentioned.
 *
 * `ChatMentionPart` and the runtime helpers `mentionInputToPart` /
 * `mentionPartsFromMessageParts` are re-exported here from `../chat-store/parts`
 * directly (not the `/chat-store` barrel), so a browser bundle gets the mention
 * vocabulary and its converters without importing `/chat-store`, whose barrel
 * pulls the drizzle peer.
 */
import { mentionInputToPart, mentionPartsFromMessageParts, type ChatMentionKind, type ChatMentionPart } from '../chat-store/parts';
export type { ChatMentionKind, ChatMentionPart };
export { mentionInputToPart, mentionPartsFromMessageParts };
/** One run of a segmented message: literal prose, or a matched mention with
 *  the part that produced it. `text` for a mention segment is the token as it
 *  appears in the message (`@<path>`), so a renderer that ignores `part` still
 *  reproduces the original string exactly. */
export interface MentionTextSegment {
    type: 'text' | 'mention';
    text: string;
    part?: ChatMentionPart;
}
/**
 * Split a message's text into plain-text and mention segments by matching
 * `@<path>` runs against that message's own mention parts.
 *
 * Only a part whose exact `@<path>` token appears in `content`, at a token
 * boundary on both sides, counts as a match; everything else — including
 * unrelated `@` text — passes through as plain text untouched. When two parts'
 * tokens both match at the same position (one path a prefix of another), the
 * LONGEST token wins, so nested-looking paths split at the right boundary.
 *
 * Returns the matched parts alongside the segments: a caller that also renders
 * a fallback chip row can drop the chip for anything now shown inline and keep
 * it only for mentions the text does not actually contain (a restored draft, a
 * queued message whose text was edited).
 */
export declare function segmentMentionContent(content: string, parts: ReadonlyArray<ChatMentionPart>): {
    segments: MentionTextSegment[];
    matched: Set<ChatMentionPart>;
};
