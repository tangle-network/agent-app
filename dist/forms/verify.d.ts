/**
 * Read a filled form back and say, slot by slot, whether the document agrees
 * with the data it was built from.
 *
 * WHAT THIS PROVES, AND WHAT IT CANNOT
 *
 * This proves the WRITE LANDED: the value reached a real widget, that widget
 * exists in the produced file, and it holds the text or tick the data claims.
 * It does NOT prove PLACEMENT — that the widget is the right box on the page —
 * because it resolves the same field names the fill used. Reading a value back
 * by the name you just wrote passes even when the name was invented; measured
 * on tax-agent, an audit of that shape reported 3 passed / 0 failed for three
 * figures sitting in "Combat zone" and the date boxes.
 *
 * Placement is proven by `checkRegistryAgainstBlank`, which compares each
 * slot's claimed label against the widget's own `/TU` text inside the PDF.
 * The two checks are complements, and a product that runs only this one has
 * the audit that already failed once. That is stated here rather than in a
 * commit message because a future caller will otherwise reach for the
 * convenient half.
 *
 * FAILS ON ABSENCE. A registry field the produced PDF does not expose is
 * `missing_field`, and an empty `expected` map is `ok: false` — the
 * `passed=0 failed=0` verdict is the exact shape of the bug this replaces.
 */
import { type FormRegistry } from './registry';
export type SlotVerdict = 'ok' | 'unknown_slot' | 'missing_field' | 'wrong_kind' | 'not_written' | 'mismatch';
/** What the slot's `label` is worth, checked against the produced file. */
export type LabelVerdict = 'matches_widget' | 'label_mismatch' | 'derived_unchecked' | 'no_widget_label';
export interface SlotVerification {
    slot: string;
    field?: string;
    verdict: SlotVerdict;
    /** What the data says the box should hold. */
    expected?: string;
    /** What the box actually holds, read out of the produced bytes. */
    actual?: string;
    labelVerdict?: LabelVerdict;
    label?: string;
}
export interface VerifyFormResult {
    ok: boolean;
    /** Widgets actually read back. Zero means nothing was proven. */
    verified: number;
    slots: SlotVerification[];
}
/**
 * Verify a filled form against the value map it was filled from.
 *
 * `expected` is the SAME shape passed to `fillPdfForm` — deliberately, so a
 * caller cannot verify against a convenient restatement of what it wrote.
 */
export declare function verifyFilledForm(args: {
    /** The PRODUCED bytes, not the blank. */
    pdf: Uint8Array;
    registry: FormRegistry;
    expected: Record<string, unknown>;
}): Promise<VerifyFormResult>;
