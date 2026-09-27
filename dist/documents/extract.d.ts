/**
 * The extraction pipeline: size gate → media type → (PDF: classify, then
 * extract) / (DOCX: OPC read) / (text: strict decode).
 *
 * Two rules make this safe to build a product on.
 *
 * 1. **Classify before extracting a PDF.** The wasm engine's `extractText`
 *    panics (`RuntimeError: unreachable`) on any page with no text layer, and
 *    that is measured, not theoretical — including on `mixed` documents where
 *    only ONE page is an image. Classification runs first and decides whether
 *    extraction is even reachable, which is also what produces the OCR signal.
 * 2. **A scanned PDF is `pdf-needs-ocr`, never an empty string.** Both hand-
 *    rolled predecessors of this module got this right and it is the single
 *    behaviour a product cannot afford to lose: silent empty text lets a
 *    downstream model answer confidently about a document nobody read.
 */
import type { DocumentOutcome, ExtractedDocument, PdfClassification, PdfEngine, PdfTextFormat } from './types';
/** 25 MB — the cap both predecessor implementations converged on, and roughly
 *  the point where a Worker's memory budget stops tolerating a full decode. */
export declare const DEFAULT_MAX_DOCUMENT_BYTES: number;
export interface ExtractDocumentOptions {
    /** The type the upload declared. Falls back to `filename`'s extension when
     *  missing or `application/octet-stream`. */
    readonly mediaType?: string;
    /** Used to resolve the media type, and named in error messages. */
    readonly filename?: string;
    /** Required to extract PDFs. Supplied by the caller because the wasm asset
     *  must come from the consumer's bundler — see
     *  `@tangle-network/agent-app/documents/pdf-inspector`. */
    readonly pdf?: PdfEngine;
    /** Byte cap on the uploaded ARCHIVE, default
     *  {@link DEFAULT_MAX_DOCUMENT_BYTES}. */
    readonly maxBytes?: number;
    /**
     * Byte cap on what any ONE part of an Office package may expand to, default
     * {@link DEFAULT_MAX_ZIP_ENTRY_BYTES}.
     *
     * A separate dial from {@link maxBytes} because they bound different things:
     * deflate reaches ~1000:1 on repetitive input, so capping the upload does
     * nothing to cap the decompression it asks for.
     */
    readonly maxUncompressedPartBytes?: number;
    /**
     * Plain text (default) preserves source line breaks, which line-anchored
     * parsers depend on; markdown carries headings and page markers but reflows
     * lines into paragraphs.
     *
     * A *preference*, because of exactly one measured case: on a partially
     * scanned PDF the plain-text engine panics, and only the markdown engine can
     * recover the pages that do have text. The result reports what you actually
     * got in {@link PdfExtractionDetail.textFormat} — check it when the
     * distinction matters.
     */
    readonly preferredPdfFormat?: PdfTextFormat;
}
/**
 * Classify a PDF: whether it has a text layer, and which pages do not.
 *
 * Safe on every input — classification is what makes extraction safe, so it can
 * never be the thing that panics. Call this directly when a product wants to
 * show "3 of 40 pages need OCR" before deciding to extract.
 */
export declare function classifyPdfDocument(bytes: Uint8Array, pdf: PdfEngine): DocumentOutcome<PdfClassification>;
/**
 * Extract a document's text.
 *
 * Every failure is a typed {@link DocumentExtractionError} naming the stage it
 * stopped at; nothing throws, and success never carries empty text.
 */
export declare function extractDocument(input: ArrayBuffer | Uint8Array, options?: ExtractDocumentOptions): Promise<DocumentOutcome<ExtractedDocument>>;
export interface DocumentExtractorConfig {
    readonly pdf?: PdfEngine;
    readonly maxBytes?: number;
    readonly maxUncompressedPartBytes?: number;
    readonly preferredPdfFormat?: PdfTextFormat;
}
export interface DocumentExtractor {
    readonly extract: (input: ArrayBuffer | Uint8Array, options?: Omit<ExtractDocumentOptions, 'pdf' | 'maxBytes' | 'maxUncompressedPartBytes' | 'preferredPdfFormat'>) => Promise<DocumentOutcome<ExtractedDocument>>;
    /** Classify a PDF without extracting. Fails with `pdf-engine-unavailable`
     *  when the extractor was built without a PDF engine. */
    readonly classifyPdf: (input: ArrayBuffer | Uint8Array) => DocumentOutcome<PdfClassification>;
}
/**
 * Bind an engine and limits once, at worker start, so call sites read
 * `documents.extract(bytes, { mediaType })` and never re-wire the wasm.
 */
export declare function createDocumentExtractor(config?: DocumentExtractorConfig): DocumentExtractor;
