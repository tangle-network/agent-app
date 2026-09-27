/**
 * Round-trip between the mention editor's document and the composer's plain
 * `value` string. A mention node serializes to `@<id>`; parsing restores a
 * pill only for ids the session already knows (fetched, inserted, or
 * restored), so unknown `@…` runs stay literal text.
 *
 * The document shape is kept structural (no TipTap import) so this round-trip
 * is unit-testable on its own and never pulls the editor chunk into a bundle.
 */
import type { MentionItem } from './use-file-mentions';
/**
 * The subset of a TipTap/ProseMirror JSON document the mention editor
 * produces: a `doc` of paragraphs, each holding text, hard breaks, and atomic
 * mention nodes.
 */
export interface MentionDocNode {
    type: string;
    text?: string;
    attrs?: {
        id?: string | null;
        label?: string | null;
        kind?: string | null;
    };
    content?: MentionDocNode[];
}
/**
 * Plain-text serialization of the editor document. Paragraphs join with a
 * newline, hard breaks become a newline, and a mention node becomes `@<id>` —
 * the stable text form the controlled `value` carries.
 */
export declare function serializeMentionDoc(doc: MentionDocNode): string;
/** Every mention node in the document, in order, as `MentionItem`s. */
export declare function collectMentions(doc: MentionDocNode): MentionItem[];
/**
 * Parse a controlled `value` string back into an editor document. `@<id>`
 * runs that match a currently-known mention restore as atomic mention nodes;
 * every other `@…` stays literal text. Each line becomes a paragraph — a
 * deliberate asymmetry with `serializeMentionDoc`, which also flattens an
 * in-paragraph `hardBreak` to `\n`: the string round-trips byte-identically,
 * but a restored Shift+Enter comes back as a paragraph break. The two render
 * identically under the composer's styling (no paragraph margins), so the
 * plain-text `value` contract stays the source of truth.
 */
export declare function parseMentionValue(value: string, known: Map<string, MentionItem>): MentionDocNode;
