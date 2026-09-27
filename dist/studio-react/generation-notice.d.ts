/**
 * The one thing a chat-shaped generator has to say about itself: each prompt is
 * a fresh generation, and nothing carries over from the last one.
 *
 * A chat card sets the expectation that the thing on the other side remembers
 * the conversation. This one does not, and the cost of learning that by
 * experiment is a wasted generation. The chip is a soft brand-tinted hint: its
 * primary-tinted surface and primary icon keep it noticeable, while the hard
 * border and shadow read as an alert and were cut after gtm QA (issue #465).
 *
 * The icon is INLINE in the text flow rather than a flex sibling, so a narrow
 * viewport wraps it with the sentence instead of stranding a lone glyph beside
 * a two-line block.
 */
export declare function GenerationNoticeChip({ className }: {
    className?: string;
}): import("react").JSX.Element;
