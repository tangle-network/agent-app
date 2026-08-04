/**
 * Document text extraction — the upload-side capability every vertical needs
 * before a model can read anything a user sends: PDF, DOCX, and text in, plain
 * text plus a stage-named failure out.
 *
 * **This entry imports nothing.** The PDF engine arrives through the
 * {@link PdfEngine} seam because its wasm has to be a build-time asset from the
 * consumer's own bundler; `@tangle-network/agent-app/documents/pdf-inspector`
 * is the shipped implementation, on its own subpath so a product that handles
 * only DOCX and text never installs the wasm package. DOCX needs no dependency
 * at all — `DecompressionStream` is a runtime API in both workerd and Node.
 *
 * **The scanned-PDF contract.** A PDF with no text layer fails with
 * `pdf-needs-ocr` carrying the page-level classification. It is never an empty
 * string: a product that receives `''` from a scan will happily let a model
 * answer questions about a document nobody read. OCR itself is NOT here — it
 * belongs to the sandbox image (ocrmypdf/tesseract), and this module's job is
 * to hand the caller a signal precise enough to route to it.
 *
 * Wiring, including the exact Cloudflare vite-plugin wasm delivery, is in
 * `docs/documents-module.md`.
 */

export {
  classifyPdfDocument,
  createDocumentExtractor,
  DEFAULT_MAX_DOCUMENT_BYTES,
  extractDocument,
  type DocumentExtractor,
  type DocumentExtractorConfig,
  type ExtractDocumentOptions,
} from './extract'

export { decodeXmlEntities, extractDocxText, wordprocessingXmlToText, type DocxText } from './docx'

export {
  DOCM_MEDIA_TYPE,
  DOCX_MEDIA_TYPE,
  normalizeMediaType,
  PDF_MEDIA_TYPE,
  resolveMediaType,
  type ResolvedMediaType,
  type ResolveMediaTypeInput,
} from './media-type'

export {
  DEFAULT_MAX_ZIP_ENTRY_BYTES,
  readZipDirectory,
  readZipEntry,
  type ReadZipEntryOptions,
  type ZipEntry,
  type ZipOutcome,
} from './zip'

export type {
  DocumentExtractionError,
  DocumentExtractionErrorCode,
  DocumentExtractionStage,
  DocumentFormat,
  DocumentOutcome,
  DocxExtractionDetail,
  ExtractedDocument,
  PdfClassification,
  PdfContentKind,
  PdfEngine,
  PdfExtractionDetail,
  PdfPageClassification,
  PdfTextFormat,
} from './types'
