/**
 * The composer's file-ingress filter, and the clipboard rename that goes with
 * it.
 *
 * A file reaches a composer by three routes — the picker dialog, a drag-and-drop,
 * and a clipboard paste — and only the picker gets a native `accept` filter (one
 * the user can defeat with "All Files"). Every route therefore funnels through
 * {@link filterAcceptedFiles}, so a type the picker will not offer cannot arrive
 * by another route instead.
 *
 * One route can still reach a different verdict, and it does so deliberately.
 * Paste is the only route that RENAMES, and {@link renamePastedImages} names a
 * file after the type it declares. So a clipboard bitmap called `image.png` that
 * declares `image/heic` is judged as `.heic` on paste, while the picker and a
 * drop judge the name they were handed and admit it under `accept=".png"`. The
 * filter is the same on all three; what differs is the name it is given, and
 * paste is stricter precisely because a rename that kept the contradicting name
 * would let the composer manufacture its own way past the filter.
 *
 * ONE accept matcher serves the package: `ChatComposer` gates its ingress on it
 * and `useComposerAttachments` gates `addFiles` on it. A second implementation
 * of the `accept` grammar is how the two ends of the same staging path start
 * disagreeing about what a file is.
 *
 * Pure data in, pure data out — nothing here throws, logs, or touches the DOM,
 * so a caller decides how a rejection is surfaced. Import-free beyond the
 * browser's own `File`, which keeps it usable from `/web-react`'s client bundle.
 */
/** A file the `accept` list refused, with the reason to show for it. */
export interface ComposerFileRejection {
    file: File;
    reason: string;
}
/**
 * Checks one file against a comma-separated `accept` list, using the grammar of
 * the native `<input accept>` attribute: extensions (`.png`), exact MIME types
 * (`image/png`), and MIME wildcards (`image/*`). An absent or empty list accepts
 * everything, which is what an unset `accept` prop means.
 */
export declare function isAcceptedFileType(file: File, accept?: string): boolean;
/** The reason an `accept` list refused a file. One wording for every ingress
 *  route, so the same file reads the same whether it was picked or dropped. */
export declare function acceptRejectionReason(file: File, accept: string): string;
/**
 * Splits a batch into what the `accept` list admits and what it refuses. Size
 * and count limits are NOT applied here: they belong to the staging queue, which
 * knows what is already staged (`useComposerAttachments`), while this runs at the
 * composer's edge where that is unknown.
 */
export declare function filterAcceptedFiles(files: File[] | FileList, accept?: string): {
    accepted: File[];
    rejected: ComposerFileRejection[];
};
/**
 * Gives every generically-named clipboard image a distinct
 * `pasted-image-<n>.<ext>` name. Two pastes of the same bitmap otherwise arrive
 * as `image.png` twice, and a staging queue that keys on the name treats the
 * second as a duplicate of the first.
 *
 * A number is never reused. The search avoids every `pasted-image-<n>` already
 * present in `stagedNames` (the queue the host still holds, which outlives this
 * composer's own count) and in the batch itself (one paste can carry a file
 * already named that way beside a raw bitmap), so a collision is not reachable
 * rather than merely unlikely. `startIndex` is the caller's running count, and
 * `nextIndex` is the count to hand the next paste.
 *
 * Files that already carry a real name pass through untouched, so a copied
 * `report.pdf` keeps being `report.pdf`. So does an image whose extension
 * cannot be derived from what it declares — a renamed file must never claim a
 * format it is not. Only the name changes: the bytes, the type and the
 * modification time travel with it, so downstream fingerprinting still sees
 * the file the user pasted.
 */
export declare function renamePastedImages(files: File[], startIndex: number, stagedNames?: Iterable<string>): {
    files: File[];
    nextIndex: number;
};
