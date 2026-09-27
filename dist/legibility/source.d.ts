/**
 * A purpose-built TS/TSX scanner: the one place this subpath decides what part
 * of a file is CODE and what part is COPY A HUMAN READS.
 *
 * Every legibility check needs the same distinction, and getting it from
 * per-check regexes is what makes a lint gate imprecise enough to be turned off.
 * `grep -i artifact` over one product's `apps/web/src` returns 11 hits and every
 * single one is an import specifier, a prop name, or a doc comment — zero are on
 * screen. A checker that reports those 11 is deleted within a week, and then it
 * guards nothing.
 *
 * So this module lexes instead: one pass produces (a) classified SEGMENTS —
 * comments, string literals, template chunks, JSX text, JSX attribute values —
 * and (b) a JSX ELEMENT TREE with spans, attributes, and the enclosing
 * expression container. Checks read those, never the raw bytes.
 *
 * It is a lexer, not a type-aware parser, and that boundary is deliberate: this
 * package ships one runtime dependency and adding `typescript` to every
 * consumer's install to lint copy is the wrong trade. What a lexer cannot do —
 * resolve a string through a variable, follow a component's props to its render
 * — is out of scope by construction and documented per check.
 *
 * Node-agnostic: pure string in, data out. The `fs` walking lives in `scan.ts`.
 */
/** What a stretch of source is, once the lexer has decided. */
export type SegmentKind = 
/** `//…` or `/*…*​/` — never user-visible; every check skips these. */
'comment'
/** A `'…'` / `"…"` literal in code position. Visible only in some contexts. */
 | 'string'
/** One literal chunk of a template literal (the `${…}` holes are code). */
 | 'template'
/** Text between JSX tags. The highest-confidence user-visible signal there is. */
 | 'jsx-text'
/** A `name="…"` attribute value on a JSX element. */
 | 'jsx-attribute';
/** One classified stretch of source. */
export interface SourceSegment {
    readonly kind: SegmentKind;
    /** Offset of the first character of the segment's VALUE (inside the quotes). */
    readonly start: number;
    /** Offset just past the segment's value. */
    readonly end: number;
    /** The value text, quotes stripped, escapes left as written. */
    readonly value: string;
    /** For `jsx-attribute`: the attribute name. For `jsx-text`: absent. */
    readonly attribute?: string;
    /** For `jsx-attribute` / `jsx-text`: the owning element's tag name. */
    readonly tag?: string;
}
/** One attribute on a JSX element. */
export interface JsxAttribute {
    readonly name: string;
    readonly start: number;
    /** The literal value when written `name="…"`; null when `name={…}` or bare. */
    readonly value: string | null;
    /** True when written `name={…}` — the value is code, not copy. */
    readonly expression: boolean;
}
/** One JSX element, with the span every subtree question needs. */
export interface JsxElement {
    /** Tag as written (`div`, `Button`, `Card.Header`); `''` for a fragment. */
    readonly tag: string;
    readonly attributes: JsxAttribute[];
    readonly children: JsxElement[];
    parent: JsxElement | null;
    /** Offset of the opening `<`. */
    readonly start: number;
    /** Offset just past the opening tag's `>`. */
    openEnd: number;
    /** Offset just past the element's end (`/>` or `</tag>`). */
    end: number;
    /**
     * Offset of the `{` of the nearest enclosing JSX expression container, or
     * null at the top of a return/assignment. This is what scopes an empty state
     * to its own conditional branch instead of to the whole page.
     */
    readonly containerStart: number | null;
}
/** Everything one pass over a file produces. */
export interface ScannedSource {
    readonly text: string;
    readonly segments: readonly SourceSegment[];
    /** Every element, in document (open-tag) order. */
    readonly elements: readonly JsxElement[];
    /**
     * `text` with every comment, string body and template body replaced by
     * spaces, offsets preserved. Structural regexes (catch bodies, fetch calls)
     * run over this so a `catch` inside a string can never be a finding.
     */
    readonly masked: string;
}
/** 1-based line/column for a byte offset. */
export interface SourcePosition {
    readonly line: number;
    readonly column: number;
}
/**
 * Lex one TS/TSX source.
 *
 * The loop keeps a frame stack. A code frame pops back to its JSX parent when
 * an unmatched `}` closes the expression container that opened it; a JSX tag
 * frame becomes a children frame at `>` and pops at `/>`.
 */
export declare function scanSource(text: string): ScannedSource;
/** Line-start offsets, for `positionAt`. */
export declare function lineIndex(text: string): number[];
/** 1-based line/column of `offset`, given a `lineIndex` result. */
export declare function positionAt(starts: readonly number[], offset: number): SourcePosition;
/** The innermost element whose span contains `offset`. */
export declare function elementAt(elements: readonly JsxElement[], offset: number): JsxElement | null;
/**
 * The nearest enclosing FUNCTION body containing `offset`, over MASKED text.
 *
 * Walks outward from the innermost block until one is introduced by `)` +
 * optional `=>`, `function …`, or a method head — the scope a handler occupies.
 * This is what keeps a check from joining a request in one handler to a success
 * message in another, which is the difference between a report worth reading
 * and one that gets the gate switched off.
 */
export declare function enclosingFunctionBlock(masked: string, offset: number): {
    start: number;
    end: number;
} | null;
/**
 * The innermost `{ … }` block containing `offset`, over MASKED text.
 * Returns null when `offset` sits at top level.
 */
export declare function enclosingBlock(masked: string, offset: number): {
    start: number;
    end: number;
} | null;
