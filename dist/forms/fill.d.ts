/**
 * Fill a real agency PDF from a slot → value map.
 *
 * Mechanically this is `pdf-lib` writing an AcroForm: TypeScript, no
 * container, no Python, no network. That matters because it is the only shape
 * that runs everywhere these products run — a Cloudflare Worker (where 100% of
 * tax-agent's production work products were produced, with no sandbox at all)
 * and a sandbox container whose egress proxy refuses the agency's own host.
 *
 * The invariant it enforces is in `registry.ts`: the caller supplies SEMANTIC
 * SLOTS and never a widget name. Two consequences show up here.
 *
 * NOTHING IS SILENT. Every slot ends in `filled` or in `unfilled` with a code
 * and a reason. A value the caller supplied that never reached the page means
 * the document and the data disagree, which is the one thing a reviewer must
 * not have to discover by eye. That includes a registry naming a widget the
 * PDF does not expose: it is reported per-slot rather than crashing the render
 * or — worse — being skipped, which is how tax-agent once audited a fill
 * against entirely wrong paths as `passed=0 failed=0`.
 *
 * NO ON-STATE IS EVER AUTHORED. A checkbox's "on" name is a property of the
 * PDF and frequently a hex-escaped sentence: Texas Form 205's seven boxes are
 * `is#20an#20organization`, `initially#20has#20#20managers` (note the double
 * space), and four more like them. A caller that types one of those strings is
 * authoring something it cannot check, so a checkbox slot takes a BOOLEAN and
 * the widget's own on-value is read out of the file. The escaped spelling is
 * not handled — it is unrepresentable.
 */
import type { FormRegistry, FormSlot } from './registry';
/** One widget the fill actually wrote. */
export interface FilledWidget {
    slot: string;
    field: string;
    kind: FormSlot['kind'];
    /** The value as the caller supplied it, before formatting. */
    value: unknown;
    /** Exactly the text placed in the box. Absent for a checkbox. */
    text?: string;
    /** Whether a checkbox was ticked. Absent for a text field. */
    checked?: boolean;
    /** The widget's OWN on-state, decoded — read from the PDF, never authored. */
    onState?: string;
}
/** Why a supplied value did not reach the page. */
export type UnfilledCode = 'unknown_slot' | 'missing_field' | 'wrong_kind' | 'not_a_number' | 'not_a_boolean' | 'unformattable';
export interface UnfilledSlot {
    slot: string;
    field?: string;
    value: unknown;
    code: UnfilledCode;
    reason: string;
}
export interface FillFormResult {
    bytes: Uint8Array;
    filled: FilledWidget[];
    unfilled: UnfilledSlot[];
    form: string;
    revision: string;
}
export interface FillFormOptions {
    /** The blank's bytes. Decode a `FormBlank` with `decodeFormBlank` first. */
    pdf: Uint8Array;
    registry: FormRegistry;
    /** slot name → value. Keys the registry does not know are reported, not dropped. */
    values: Record<string, unknown>;
    /**
     * Override how a text value becomes box text. Return `undefined` to fall
     * through to the built-in formatting for the slot's `format`.
     */
    formatText?: (value: unknown, slot: FormSlot) => string | undefined;
}
/**
 * Format a figure the way a US agency form prints it: grouped thousands, two
 * decimals, negatives in parentheses.
 *
 * Two decimals rather than whole dollars because the caller's data carries
 * cents and a reviewer compares the document against that data — rounding here
 * would manufacture a disagreement between the two on every line with cents.
 */
export declare function formatFormCurrency(value: number): string;
/** A number, or a number written the way a form prints one (`$141,318.74`). */
export declare function parseFormAmount(value: unknown): number | undefined;
/**
 * A checkbox takes a boolean and nothing else.
 *
 * Strict on purpose. Accepting a truthy string would accept the widget's own
 * escaped on-state (`'is#20an#20organization'`) as "true", which is exactly
 * the authored-on-state this module refuses — and it would accept `'no'` as
 * true, silently ticking a box the caller meant to leave clear.
 */
export declare function parseFormBoolean(value: unknown): boolean | undefined;
/**
 * Write a value map onto a blank, returning the bytes plus the exact
 * widget-by-widget account of what was and was not placed.
 */
export declare function fillPdfForm(options: FillFormOptions): Promise<FillFormResult>;
/**
 * What to tell the agent after a fill.
 *
 * Names the values that did NOT reach the page. Those are exactly the cases
 * where the document and the data disagree, and the agent is the only party
 * that can resolve it — returning a bare "done" hands a reviewer a form
 * missing values the data claims are on it.
 */
export declare function describeFormFill(result: FillFormResult): string;
