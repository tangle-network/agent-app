/**
 * `ProvenanceValue` — one value rendered so its origin is discoverable without
 * navigating away, and openable when there is something to open.
 *
 * This is the affordance three verticals each rebuilt: tax renders a source
 * quote under an expanded return line, legal renders authorities under a
 * finding, the record grid renders a per-cell marker. Same product promise,
 * three vocabularies, three sets of gaps.
 *
 * What the primitive holds that a hand-rolled caption does not:
 *
 * 1. The four bases render differently — a person's entry and a model's
 *    assertion are never the same pixels. Each carries its own glyph AND its
 *    own words, so the distinction survives greyscale and a screen reader.
 * 2. It COMPOSES. A computed value's provenance is its inputs, and each input
 *    is itself a `ProvenanceValue` with its own disclosure.
 * 3. Confidence renders as the next move ("Check the source"), never as a
 *    percentage a reader cannot act on.
 * 4. The disclosure is a real button — keyboard reachable, `aria-expanded`,
 *    Escape closes and returns focus, a click outside dismisses, and opening
 *    one trail closes the one the reader left. Nothing here discloses on hover,
 *    and no fact lives only in a `title` attribute.
 * 5. A source that is loading, unopenable, or absent SAYS so. There is no path
 *    through this component that renders a bare number.
 *
 * Layout: an inline-block block-level element, so put it in a table cell, a
 * list item, or a card — not inside a `<p>`. Sandbox-ui-free, like the rest of
 * `/web-react`; the model in `./provenance-model` is React-free.
 */
import { type ProvenanceBasis, type ProvenanceConfidencePolicy, type ProvenanceRecord, type ProvenanceSource } from './provenance-model';
export * from './provenance-model';
/** Properties for one provenanced value and its disclosure. */
export interface ProvenanceValueProps {
    /** The value and where it came from. */
    record: ProvenanceRecord;
    /**
     * Open one source in the product's own way (a document pane at the right
     * page, a drawer, a route). Takes precedence over `href` when both are
     * present, because a product that routes wants its router — a source with
     * neither is named but not openable, which is a legitimate state and is
     * rendered as such.
     */
    onOpenSource?: (source: ProvenanceSource, record: ProvenanceRecord) => void;
    /** Retry resolving an `unavailable` source. Absent → the failure is stated
     *  without a retry control, never swallowed. */
    onRetrySource?: (source: ProvenanceSource, record: ProvenanceRecord) => void;
    /** Where this product draws its confidence lines. */
    confidencePolicy?: ProvenanceConfidencePolicy;
    /**
     * How many levels of composed inputs stay expandable. Past it an input still
     * renders its value, its basis and its origin sentence — it just stops
     * carrying its own disclosure, so a deep tree cannot run away and a record
     * that reaches itself cannot recurse forever. Default 2.
     */
    maxDepth?: number;
    /** Open the disclosure on first render — for a review surface where the
     *  trail is the point. Several of these coexist: only a reader opening a
     *  trail closes another one. */
    defaultOpen?: boolean;
    /** What an empty `display` renders as. A blank cell is the defect this
     *  component exists to remove. */
    missingValueLabel?: string;
    className?: string;
}
/**
 * A value, its origin marker, and the disclosure that shows where it came
 * from. The marker states the basis in words and, whenever there is something
 * to do about the value, the next move — so the standing is legible at rest
 * and does not depend on anyone opening the panel.
 */
export declare function ProvenanceValue({ record, onOpenSource, onRetrySource, confidencePolicy, maxDepth, defaultOpen, missingValueLabel, className, }: ProvenanceValueProps): import("react").JSX.Element;
/** Properties for the basis legend. */
export interface ProvenanceLegendProps {
    /** Only the bases present on screen. Passing all four when only two appear
     *  teaches distinctions the reader cannot use. */
    bases: readonly ProvenanceBasis[];
    className?: string;
}
/** The marker key for a surface that renders several bases at once — a review
 *  pane, a grid, a return. Each row is the same glyph, tone and words the
 *  markers use, plus what the basis MEANS. */
export declare function ProvenanceLegend({ bases, className }: ProvenanceLegendProps): import("react").JSX.Element | null;
