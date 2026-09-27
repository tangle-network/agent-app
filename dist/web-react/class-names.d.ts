/**
 * One class-attribute join for this subpath.
 *
 * The pattern it replaces is `` `base ${className ?? ''}` ``, which emits
 * `class="base "` for every caller that passes nothing: a trailing separator in
 * the DOM, in every snapshot, and in every assertion that compares the attribute
 * instead of searching it. Interpolating an absent value is the defect — the
 * fix is to never build the attribute by interpolation.
 */
export declare function joinClasses(...parts: ReadonlyArray<string | false | null | undefined>): string;
