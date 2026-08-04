/**
 * The shapes every documents-module boundary speaks: a typed outcome, a
 * stage-named error, the normalized PDF classification, and the PDF engine
 * port that keeps the wasm binding out of this module's import graph.
 */

/** What kind of extraction a media type routes to. */
export type DocumentFormat = 'pdf' | 'docx' | 'text'

/** Where extraction stopped. Surfaced on every error so a product can tell a
 *  user WHERE it failed rather than "extraction failed". */
export type DocumentExtractionStage = 'size-check' | 'media-type' | 'classify' | 'extract' | 'decode'

/**
 * Why extraction stopped.
 *
 * `pdf-needs-ocr` is the load-bearing one: a scanned PDF has no text layer, so
 * the only honest outcomes are this code or a lie. It is never an empty string
 * and never a generic failure — a caller matches on it to offer the OCR path
 * (see {@link PdfClassification.pagesNeedingOcr} for which pages).
 */
export type DocumentExtractionErrorCode =
  | 'too-large'
  | 'unsupported-media-type'
  | 'pdf-engine-unavailable'
  | 'pdf-needs-ocr'
  | 'classification-failed'
  | 'extraction-failed'
  | 'malformed-archive'
  | 'decode-failed'
  | 'empty-document'

export interface DocumentExtractionError {
  readonly code: DocumentExtractionErrorCode
  readonly stage: DocumentExtractionStage
  /** Human-readable and safe to show a user: names the stage's cause. */
  readonly message: string
  /** The media type as resolved (or as declared, when resolution is what failed). */
  readonly mediaType: string
  /** Present on `pdf-needs-ocr` — the page-level detail the OCR handoff needs. */
  readonly classification?: PdfClassification
}

export type DocumentOutcome<T> =
  | { succeeded: true; value: T }
  | { succeeded: false; error: DocumentExtractionError }

/**
 * PDF content kinds, normalized away from the engine's own vocabulary.
 *
 * - `text-based` — every page carries an extractable text layer.
 * - `scanned` — no text layer anywhere; the pages are page images.
 * - `image-based` — image content with no usable text layer (the engine
 *   distinguishes this from `scanned` by how the images were produced; both
 *   need OCR).
 * - `mixed` — some pages have text, some do not.
 */
export type PdfContentKind = 'text-based' | 'scanned' | 'image-based' | 'mixed'

export interface PdfPageClassification {
  /** 1-indexed, the number a person sees in a viewer. */
  readonly pageNumber: number
  /** 0-indexed, for array math. */
  readonly index: number
  readonly needsOcr: boolean
  /** Engine-reported reasons, e.g. `['scanned']`. Empty when the page is fine. */
  readonly ocrReasons: readonly string[]
  readonly hasTable: boolean
  readonly hasColumns: boolean
}

export interface PdfClassification {
  readonly kind: PdfContentKind
  readonly pageCount: number
  /** Engine confidence in `kind`, 0..1. */
  readonly confidence: number
  readonly pages: readonly PdfPageClassification[]
  /** 1-indexed page numbers needing OCR. The engine's two entry points disagree
   *  on indexing (`classifyPdf` is 0-based, `detectPdf` is 1-based); this is
   *  always 1-based so a consumer never has to know which one produced it. */
  readonly pagesNeedingOcr: readonly number[]
  /** Every page needs OCR — there is no text to extract at all. */
  readonly needsOcr: boolean
  /** Some but not all pages need OCR — text is recoverable from the rest. */
  readonly partiallyScanned: boolean
  readonly complexLayout: boolean
  /** The engine hit character-encoding problems; extracted text may be garbled. */
  readonly hasEncodingIssues: boolean
}

/** Plain text preserves the source's line breaks; markdown carries structure
 *  (headings, page markers) but reflows lines into paragraphs. */
export type PdfTextFormat = 'text' | 'markdown'

/**
 * The seam that keeps `@firecrawl/pdf-inspector-wasm` out of this module.
 *
 * A Worker cannot compile wasm from bytes at runtime, so the `.wasm` has to
 * arrive as a build-time module asset from the CONSUMER's bundler — which
 * means a shared library cannot import it. Implementations are supplied by the
 * caller; `@tangle-network/agent-app/documents/pdf-inspector` ships the one
 * that binds the firecrawl engine.
 */
export interface PdfEngine {
  /** Must not panic on scanned input — classification is what makes extraction
   *  safe, so it runs first on every document. */
  readonly classify: (bytes: Uint8Array) => DocumentOutcome<PdfClassification>
  /** Called only after `classify` says the requested pages carry text. */
  readonly extract: (bytes: Uint8Array, format: PdfTextFormat) => DocumentOutcome<string>
}

export interface PdfExtractionDetail {
  readonly classification: PdfClassification
  /** What the text actually is — see {@link ExtractDocumentOptions.preferredPdfFormat}
   *  for the one case where it differs from what was asked for. */
  readonly textFormat: PdfTextFormat
  /** Text came from a subset of pages; the rest need OCR. */
  readonly partial: boolean
}

export interface DocxExtractionDetail {
  /** The OPC part the text came from, resolved through `_rels/.rels`. */
  readonly part: string
  readonly paragraphCount: number
}

export interface ExtractedDocument {
  /** Never empty — an empty extraction is the `empty-document` error instead. */
  readonly text: string
  readonly format: DocumentFormat
  /** Canonical media type, resolved from the declared type and/or filename. */
  readonly mediaType: string
  readonly byteSize: number
  readonly characterCount: number
  readonly pdf?: PdfExtractionDetail
  readonly docx?: DocxExtractionDetail
  /** Non-fatal facts the caller should surface (e.g. pages left un-OCR'd). */
  readonly warnings: readonly string[]
}
