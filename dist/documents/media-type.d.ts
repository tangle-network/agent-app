/**
 * Media type → extraction format. Resolution order is declared type first,
 * filename extension second (products routinely receive `application/octet-stream`
 * from a browser upload), and nothing else — byte sniffing belongs to the
 * upload gate that reads untrusted bytes, not to the extractor that has already
 * been handed a decision.
 */
import type { DocumentFormat, DocumentOutcome } from './types';
/** OOXML WordprocessingML — the `.docx` a word processor writes. */
export declare const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** Macro-enabled WordprocessingML (`.docm`). Same part structure, so text
 *  extraction is identical; the VBA project is never read or executed. */
export declare const DOCM_MEDIA_TYPE = "application/vnd.ms-word.document.macroEnabled.12";
export declare const PDF_MEDIA_TYPE = "application/pdf";
export interface ResolvedMediaType {
    readonly format: DocumentFormat;
    /** Canonical media type for the resolved format. */
    readonly mediaType: string;
}
/** Strip parameters and case from a media type: `Text/Plain; charset=utf-8` →
 *  `text/plain`. */
export declare function normalizeMediaType(mediaType: string): string;
export interface ResolveMediaTypeInput {
    /** The type the upload declared. May be empty or `application/octet-stream`. */
    readonly mediaType?: string;
    /** Consulted only when `mediaType` is missing or generic. */
    readonly filename?: string;
}
/**
 * Decide which extractor handles these bytes. Fails loud rather than guessing:
 * an unrecognized type names itself and lists what is supported.
 */
export declare function resolveMediaType(input: ResolveMediaTypeInput): DocumentOutcome<ResolvedMediaType>;
