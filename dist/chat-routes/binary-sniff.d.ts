/**
 * Content-based binary/text classification, shared by the attachment upload
 * route (server) and the composer's client-side pre-validation (browser) —
 * both sides must agree on what counts as binary before a byte ever leaves
 * the client. Extension-based allowlists lie (a renamed `.docx`, a PNG saved
 * as `.txt`), so classification reads the actual bytes: a magic-byte table
 * for common binary formats first, then a UTF-8 decode attempt for
 * everything else. Three families need more than a fixed-offset signature and
 * get a reader of their own — ISO-BMFF brands (`sniffFtyp`), EBML containers
 * (`sniffEbml`), and OOXML Office packages, whose PKZIP container is shared
 * with every other `.zip` (`sniffOoxml`).
 *
 * Lifted near-verbatim from gtm-agent's `src/lib/binary-sniff.ts` (the
 * source PRs hardened this against real corruption/gate bugs: gtm#584,
 * gtm#592). Import-free by design — `/web-react` re-exports `/chat-routes`
 * modules into browser bundles (`tests/browser-safe-subpaths.test.ts` walks
 * the graph), so nothing here may reach a Node builtin or an engine package.
 */
export interface SniffResult {
    binary: boolean;
    mime: string | null;
}
/** Sniffed mime for a Word OOXML package (`.docx`). */
export declare const OOXML_WORD_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** Sniffed mime for an Excel OOXML package (`.xlsx`). */
export declare const OOXML_SPREADSHEET_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** Sniffed mime for a PowerPoint OOXML package (`.pptx`). */
export declare const OOXML_PRESENTATION_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
/** Sniffed mime for a macro-enabled Word package (`.docm`). Reported
 *  separately from {@link OOXML_WORD_MIME} so a package carrying a VBA project
 *  can never be admitted under the plain-document mime: a route that wants
 *  macro-enabled files opts in explicitly through its allowed-mime seam. */
export declare const OOXML_WORD_MACRO_ENABLED_MIME = "application/vnd.ms-word.document.macroEnabled.12";
/** Sniffed mime for a macro-enabled Excel package (`.xlsm`). */
export declare const OOXML_SPREADSHEET_MACRO_ENABLED_MIME = "application/vnd.ms-excel.sheet.macroEnabled.12";
/** Sniffed mime for a macro-enabled PowerPoint package (`.pptm`). */
export declare const OOXML_PRESENTATION_MACRO_ENABLED_MIME = "application/vnd.ms-powerpoint.presentation.macroEnabled.12";
/** Decide whether uploaded bytes are binary or text, and identify the mime
 *  type when it can be determined from content. Magic bytes are checked
 *  first; anything unmatched falls back to a fatal UTF-8 decode. A NUL byte
 *  or a decode failure means binary. Valid UTF-8 that is an SVG document is
 *  binary (byte-identity matters for image tooling). Content that matches
 *  nothing and does not decode as text is binary with an unknown mime —
 *  extension-based guessing happens at the call site, not here. */
export declare function sniffBinary(bytes: Uint8Array): SniffResult;
