/**
 * The value half of an interactive OpenUI page: what a field holds, and whether
 * a submitted set of field values matches the form the agent authored.
 *
 * The NODE vocabulary (which fields exist, how they render) has one owner —
 * `@tangle-network/ui`'s `./openui` entry. This module does not restate it. It
 * declares the narrowest STRUCTURAL port a host needs to check a submission:
 * the field's id, its kind, and the constraints that make a value legal. A
 * renderer's richer node type satisfies this port by assignment, so the two
 * packages stay in step without either importing the other.
 */
/** A value one OpenUI field can hold. `string[]` is a multi-select. */
export type OpenUIValue = string | number | boolean | string[];
/** Submitted field values, keyed by field id. */
export type OpenUIFormValues = Record<string, OpenUIValue>;
/**
 * Field ids the host will accept: identifier-safe, and never a key that would
 * reach `Object.prototype`. A submission arrives from a browser and is used to
 * index an object, so this is a boundary check, not a style rule.
 */
export declare function isSafeOpenUIFieldId(id: string): boolean;
/** The input kinds a form field can be. */
export type OpenUIFieldKind = 'text' | 'number' | 'currency' | 'select' | 'checkbox' | 'slider';
/** Whether a string names an input kind this contract knows. */
export declare function isOpenUIFieldKind(kind: string): kind is OpenUIFieldKind;
/**
 * One field, reduced to what a value check needs. A renderer node carrying
 * labels, placeholders, and layout is assignable to this — the extra
 * presentation properties are simply not read here.
 */
export interface OpenUIFieldSpec {
    id: string;
    kind: OpenUIFieldKind;
    required?: boolean;
    /** `number` / `currency` / `slider` bounds, inclusive. */
    min?: number;
    max?: number;
    /** Increment `number` / `currency` / `slider` values must land on, measured from `min ?? 0`. */
    step?: number;
    /** Longest accepted `text` value. */
    maxLength?: number;
    /** Accepted `select` values. */
    options?: ReadonlyArray<{
        value: string;
    }>;
    /** A `select` that accepts more than one option; its value is a `string[]`. */
    multiple?: boolean;
}
/** A form the host can check a submission against. */
export interface OpenUIFormSpec {
    id: string;
    fields: readonly OpenUIFieldSpec[];
}
/** Why one field's value was rejected. */
export type OpenUIFieldIssueCode = 'required' | 'type' | 'range' | 'step' | 'option' | 'length' | 'unknown_field' | 'duplicate_field' | 'unsafe_field_id';
/** One rejected field, named so a card can mark exactly that input. */
export interface OpenUIFieldIssue {
    fieldId: string;
    code: OpenUIFieldIssueCode;
    message: string;
}
/** The outcome of checking a submission against a form. */
export type OpenUIFormValidation = {
    ok: true;
    values: OpenUIFormValues;
} | {
    ok: false;
    issues: OpenUIFieldIssue[];
};
/**
 * Check submitted values against the form the agent authored.
 *
 * Fails loud on both sides of the shape: a value the form never declared is an
 * error (`unknown_field`), not a silently ignored extra, because a host that
 * drops it would act on a form different from the one the user filled in. A
 * `required` field with no value is an error even when the caller simply never
 * sent the key.
 *
 * On success the returned `values` contain only declared fields, in the form's
 * own field order — the object a handler should act on.
 */
export declare function validateOpenUIFormValues(spec: OpenUIFormSpec, values: OpenUIFormValues): OpenUIFormValidation;
