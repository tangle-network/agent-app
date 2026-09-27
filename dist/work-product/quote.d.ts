/**
 * Verbatim quote verification — the lineage gate.
 *
 * An evidence `locator.quote` is the reviewer's click target: it must land on
 * text that is actually in the document the entry names. Nothing here is
 * fuzzy. The only latitude is representational — the same characters written
 * differently by a PDF extractor, a text transcription, or a model repeating
 * what it read: Unicode compatibility forms, curly quotes, the several dash
 * codepoints, non-breaking spaces, and run-length whitespace. A quote that
 * still does not occur after that is not a formatting difference; it is text
 * the document does not contain.
 *
 * Deliberately NOT tolerated, because each one re-opens the hole this closes:
 * case (a quote is a quote), token subsets, edit distance, word-overlap
 * scoring, and "the numbers match" heuristics. A fabricated quote and a real
 * one differ by exactly the thing a fuzzy matcher forgives.
 */
/**
 * Fold a string to the form both sides of a quote comparison are measured in.
 * Composition and presentation only: NFKC, one dash, one apostrophe, one
 * double quote, runs of any whitespace to a single space, trimmed. Case is
 * PRESERVED — lowercasing would let "Box 1" match "box 1", and a citation
 * that cannot reproduce capitalization did not read the document.
 */
export declare function normalizeQuoteText(value: string): string;
/**
 * Does `quote` occur in `sourceText`? Exact substring first (the common case,
 * and free); the normalized comparison second, for the representational
 * differences above. Nothing else.
 *
 * An empty or whitespace-only quote is NOT a match — it would otherwise be a
 * substring of every document and pass the gate vacuously.
 */
export declare function sourceContainsQuote(sourceText: string, quote: string): boolean;
/**
 * Slice a citation out of the source text by character offset — the reason
 * this module exists in its stronger form.
 *
 * Verification above is a REJECTION gate: the model retypes a quote and the
 * shell refuses it when the characters do not occur. That gate is correct and
 * it works, but a model that reproduces a line character-for-character only
 * some of the time cannot USE it — every miss is a refusal, and the package
 * ends up with no lineage at all rather than false lineage. A measured 9 of 59
 * on the live tax surface is what "some of the time" meant in practice.
 *
 * A span inverts it. The model names two integers into text it just read; the
 * PLATFORM produces the quote from the bytes it already holds. There is no
 * retyping step to get wrong, so a fabricated quote is not rejected — it is
 * unrepresentable. `sourceContainsQuote(text, sliceSourceSpan(text, span))` is
 * true for every span this function returns, by construction.
 *
 * Offsets index the SAME string the product's document-reading tool pages
 * with an offset, which is the same string its `readSourceText` seam returns.
 * That is the one contract a product must keep; violate it and spans point at
 * the wrong characters (still real characters of that document — never
 * invented text, but the wrong line).
 *
 * Half-open `[start, end)`, matching `String.prototype.slice` and the
 * `offset`/`offset + text.length` window a paged read already reports.
 */
export type SourceSpanFailure = {
    reason: 'not_integer';
    field: 'start' | 'end';
} | {
    reason: 'negative';
    field: 'start' | 'end';
} | {
    reason: 'inverted';
} | {
    reason: 'out_of_range';
    totalChars: number;
} | {
    reason: 'blank';
};
export type SourceSpanResult = {
    ok: true;
    quote: string;
} | {
    ok: false;
    failure: SourceSpanFailure;
};
/**
 * Locate the line containing `value` and return it as a span — the citation
 * form for a model that cannot count characters.
 *
 * Measured on production (tax session 135b7cc3, gpt-4.1-mini): given the
 * document text and told exactly which line to cite, the model produced
 * offsets that landed on the WRONG line four times out of four, then missed
 * again on a second attempt after being shown the text its offsets had
 * selected. Character arithmetic is not something this model class does.
 *
 * What it DOES do reliably is read the value: all four `claim` fields in that
 * same run were correct to the cent. So the model names the value it read and
 * the PLATFORM finds it. Both failure modes close at once —
 *
 *  - the quote cannot be invented, because the platform slices it;
 *  - the span cannot be mis-addressed, because the platform computed it from
 *    a needle it PROVED occurs in the text.
 *
 * A needle that is not in the document is refused, which is the same fail-loud
 * posture as a quote that does not occur — and correctly so: the model is
 * asserting the document says something it does not.
 *
 * The cited span is the whole LINE, not the needle: "128,450.00" alone is not
 * a click target a reviewer can judge, whereas the line it sits on says what
 * the number IS. Number-only needles are common and deliberately supported.
 */
export type SourceFindFailure = {
    reason: 'blank_needle';
} | {
    reason: 'not_found';
} | {
    reason: 'occurrence_out_of_range';
    found: number;
} | {
    reason: 'not_distinctive';
    needle: string;
    found: number;
};
export type SourceFindResult = {
    ok: true;
    span: {
        start: number;
        end: number;
    };
    quote: string;
    occurrences: number;
} | {
    ok: false;
    failure: SourceFindFailure;
};
export declare function findSourceLine(sourceText: string, needle: string, occurrence?: number): SourceFindResult;
/** Resolve `[start, end)` against `sourceText`. Every rejection is a caller
 *  mistake the model can correct from the paged read it already has, so each
 *  carries the discriminator a tool layer turns into a specific message. */
export declare function sliceSourceSpan(sourceText: string, span: {
    start: number;
    end: number;
}): SourceSpanResult;
