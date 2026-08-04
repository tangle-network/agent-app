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

import { extractDocxText } from './docx'
import { resolveMediaType } from './media-type'
import { DEFAULT_MAX_ZIP_ENTRY_BYTES } from './zip'
import type {
  DocumentExtractionError,
  DocumentOutcome,
  ExtractedDocument,
  PdfClassification,
  PdfEngine,
  PdfExtractionDetail,
  PdfTextFormat,
} from './types'

/** 25 MB — the cap both predecessor implementations converged on, and roughly
 *  the point where a Worker's memory budget stops tolerating a full decode. */
export const DEFAULT_MAX_DOCUMENT_BYTES = 25 * 1024 * 1024

export interface ExtractDocumentOptions {
  /** The type the upload declared. Falls back to `filename`'s extension when
   *  missing or `application/octet-stream`. */
  readonly mediaType?: string
  /** Used to resolve the media type, and named in error messages. */
  readonly filename?: string
  /** Required to extract PDFs. Supplied by the caller because the wasm asset
   *  must come from the consumer's bundler — see
   *  `@tangle-network/agent-app/documents/pdf-inspector`. */
  readonly pdf?: PdfEngine
  /** Byte cap on the uploaded ARCHIVE, default
   *  {@link DEFAULT_MAX_DOCUMENT_BYTES}. */
  readonly maxBytes?: number
  /**
   * Byte cap on what any ONE part of an Office package may expand to, default
   * {@link DEFAULT_MAX_ZIP_ENTRY_BYTES}.
   *
   * A separate dial from {@link maxBytes} because they bound different things:
   * deflate reaches ~1000:1 on repetitive input, so capping the upload does
   * nothing to cap the decompression it asks for.
   */
  readonly maxUncompressedPartBytes?: number
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
  readonly preferredPdfFormat?: PdfTextFormat
}

function error(
  code: DocumentExtractionError['code'],
  stage: DocumentExtractionError['stage'],
  message: string,
  mediaType: string,
  classification?: PdfClassification,
): { succeeded: false; error: DocumentExtractionError } {
  return { succeeded: false, error: { code, stage, message, mediaType, ...(classification ? { classification } : {}) } }
}

function describe(filename: string | undefined): string {
  return filename ? `'${filename}'` : 'the document'
}

function pageList(pages: readonly number[]): string {
  return pages.length > 8 ? `${pages.slice(0, 8).join(', ')}, … (${pages.length} total)` : pages.join(', ')
}

/**
 * Classify a PDF: whether it has a text layer, and which pages do not.
 *
 * Safe on every input — classification is what makes extraction safe, so it can
 * never be the thing that panics. Call this directly when a product wants to
 * show "3 of 40 pages need OCR" before deciding to extract.
 */
export function classifyPdfDocument(bytes: Uint8Array, pdf: PdfEngine): DocumentOutcome<PdfClassification> {
  return pdf.classify(bytes)
}

async function extractPdf(
  bytes: Uint8Array,
  options: ExtractDocumentOptions,
  mediaType: string,
): Promise<DocumentOutcome<{ text: string; detail: PdfExtractionDetail; warnings: string[] }>> {
  const pdf = options.pdf
  if (!pdf) {
    return error(
      'pdf-engine-unavailable',
      'classify',
      `PDF extraction needs a PDF engine, and none was configured. Pass \`pdf\` — see @tangle-network/agent-app/documents/pdf-inspector for the wasm-backed engine and how to deliver its .wasm asset.`,
      mediaType,
    )
  }

  const classified = pdf.classify(bytes)
  if (!classified.succeeded) return classified
  const classification = classified.value

  if (classification.needsOcr) {
    const label = classification.kind === 'image-based' ? 'image-based' : 'a scan'
    return error(
      'pdf-needs-ocr',
      'classify',
      `${describe(options.filename)} is ${label} with no text layer on any of its ${classification.pageCount} page${classification.pageCount === 1 ? '' : 's'} — OCR is required before its text can be read.`,
      mediaType,
      classification,
    )
  }

  const warnings: string[] = []
  // extractText walks a per-page layout table that is empty for a page with no
  // text runs; the markdown engine tolerates that and returns the pages that do
  // have text, which is why a partial scan switches engines rather than failing.
  const requested = options.preferredPdfFormat ?? 'text'
  const textFormat: PdfTextFormat = classification.partiallyScanned ? 'markdown' : requested
  if (classification.partiallyScanned) {
    const one = classification.pagesNeedingOcr.length === 1
    warnings.push(
      `Page${one ? '' : 's'} ${pageList(classification.pagesNeedingOcr)} of ${classification.pageCount} ${one ? 'has' : 'have'} no text layer and need${one ? 's' : ''} OCR; the text below comes from the remaining pages.`,
    )
    if (requested === 'text') {
      warnings.push('Text was extracted as markdown because the plain-text engine cannot read a partially scanned PDF.')
    }
  }
  if (classification.hasEncodingIssues) {
    warnings.push('The PDF has character-encoding problems; extracted text may contain garbled characters.')
  }

  const extracted = pdf.extract(bytes, textFormat)
  if (!extracted.succeeded) return extracted

  return {
    succeeded: true,
    value: {
      text: extracted.value,
      detail: { classification, textFormat, partial: classification.partiallyScanned },
      warnings,
    },
  }
}

/**
 * Extract a document's text.
 *
 * Every failure is a typed {@link DocumentExtractionError} naming the stage it
 * stopped at; nothing throws, and success never carries empty text.
 */
export async function extractDocument(
  input: ArrayBuffer | Uint8Array,
  options: ExtractDocumentOptions = {},
): Promise<DocumentOutcome<ExtractedDocument>> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const declared = options.mediaType ?? ''
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOCUMENT_BYTES

  if (bytes.byteLength > maxBytes) {
    return error(
      'too-large',
      'size-check',
      `${describe(options.filename)} is ${bytes.byteLength} bytes, over the ${maxBytes}-byte limit.`,
      declared,
    )
  }
  if (bytes.byteLength === 0) {
    return error('empty-document', 'size-check', `${describe(options.filename)} is empty (0 bytes).`, declared)
  }

  const resolved = resolveMediaType({ mediaType: declared, filename: options.filename })
  if (!resolved.succeeded) return resolved
  const { format, mediaType } = resolved.value

  const warnings: string[] = []
  let text: string
  let pdf: PdfExtractionDetail | undefined
  let docx: ExtractedDocument['docx']

  if (format === 'pdf') {
    const outcome = await extractPdf(bytes, options, mediaType)
    if (!outcome.succeeded) return outcome
    text = outcome.value.text
    pdf = outcome.value.detail
    warnings.push(...outcome.value.warnings)
  } else if (format === 'docx') {
    const outcome = await extractDocxText(bytes, mediaType, {
      maxUncompressedBytes: options.maxUncompressedPartBytes ?? DEFAULT_MAX_ZIP_ENTRY_BYTES,
    })
    if (!outcome.succeeded) return outcome
    text = outcome.value.text
    docx = outcome.value.detail
  } else {
    // Strict decode: a text file that is not UTF-8 is a decoding failure the
    // uploader can act on, not mojibake handed to a model as if it were prose.
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (cause) {
      return error(
        'decode-failed',
        'decode',
        `${describe(options.filename)} is not valid UTF-8 text — ${cause instanceof Error ? cause.message : String(cause)}. Re-save it as UTF-8.`,
        mediaType,
      )
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  }

  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return error(
      'empty-document',
      format === 'text' ? 'decode' : 'extract',
      `${describe(options.filename)} produced no text. The file parsed, but it contains nothing readable.`,
      mediaType,
      pdf?.classification,
    )
  }

  return {
    succeeded: true,
    value: {
      text: trimmed,
      format,
      mediaType,
      byteSize: bytes.byteLength,
      characterCount: trimmed.length,
      ...(pdf ? { pdf } : {}),
      ...(docx ? { docx } : {}),
      warnings,
    },
  }
}

export interface DocumentExtractorConfig {
  readonly pdf?: PdfEngine
  readonly maxBytes?: number
  readonly maxUncompressedPartBytes?: number
  readonly preferredPdfFormat?: PdfTextFormat
}

export interface DocumentExtractor {
  readonly extract: (
    input: ArrayBuffer | Uint8Array,
    options?: Omit<ExtractDocumentOptions, 'pdf' | 'maxBytes' | 'maxUncompressedPartBytes' | 'preferredPdfFormat'>,
  ) => Promise<DocumentOutcome<ExtractedDocument>>
  /** Classify a PDF without extracting. Fails with `pdf-engine-unavailable`
   *  when the extractor was built without a PDF engine. */
  readonly classifyPdf: (input: ArrayBuffer | Uint8Array) => DocumentOutcome<PdfClassification>
}

/**
 * Bind an engine and limits once, at worker start, so call sites read
 * `documents.extract(bytes, { mediaType })` and never re-wire the wasm.
 */
export function createDocumentExtractor(config: DocumentExtractorConfig = {}): DocumentExtractor {
  return {
    extract: (input, options) => extractDocument(input, { ...options, ...config }),
    classifyPdf: (input) => {
      if (!config.pdf) {
        return error(
          'pdf-engine-unavailable',
          'classify',
          'This extractor was created without a PDF engine, so PDFs cannot be classified. Pass `pdf` to createDocumentExtractor.',
          'application/pdf',
        )
      }
      return classifyPdfDocument(input instanceof Uint8Array ? input : new Uint8Array(input), config.pdf)
    },
  }
}
