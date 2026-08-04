/**
 * Media type → extraction format. Resolution order is declared type first,
 * filename extension second (products routinely receive `application/octet-stream`
 * from a browser upload), and nothing else — byte sniffing belongs to the
 * upload gate that reads untrusted bytes, not to the extractor that has already
 * been handed a decision.
 */

import type { DocumentFormat, DocumentOutcome } from './types'

/** OOXML WordprocessingML — the `.docx` a word processor writes. */
export const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** Macro-enabled WordprocessingML (`.docm`). Same part structure, so text
 *  extraction is identical; the VBA project is never read or executed. */
export const DOCM_MEDIA_TYPE = 'application/vnd.ms-word.document.macroEnabled.12'

export const PDF_MEDIA_TYPE = 'application/pdf'

/** Legacy binary Word (`.doc`) — an OLE2 compound file, not an OOXML package.
 *  Named so the failure can say "convert to .docx" instead of surfacing a zip
 *  parse error from a reader that was handed the wrong container. */
const LEGACY_DOC_MEDIA_TYPES = new Set(['application/msword', 'application/vnd.ms-word'])

/** Lower-cased comparison key → the registered spelling to report back. Media
 *  types are case-insensitive, and the `.docm` type is registered with capitals
 *  (`macroEnabled`), so matching without this folds it into "unsupported". */
const DOCX_MEDIA_TYPES = new Map([
  [DOCX_MEDIA_TYPE.toLowerCase(), DOCX_MEDIA_TYPE],
  [DOCM_MEDIA_TYPE.toLowerCase(), DOCM_MEDIA_TYPE],
])

/** Extensions that decide the format when the declared type is missing or the
 *  browser's generic `application/octet-stream`. */
const EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  pdf: PDF_MEDIA_TYPE,
  docx: DOCX_MEDIA_TYPE,
  docm: DOCM_MEDIA_TYPE,
  doc: 'application/msword',
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
}

const UNDECLARED = new Set(['', 'application/octet-stream', 'binary/octet-stream'])

export interface ResolvedMediaType {
  readonly format: DocumentFormat
  /** Canonical media type for the resolved format. */
  readonly mediaType: string
}

/** Strip parameters and case from a media type: `Text/Plain; charset=utf-8` →
 *  `text/plain`. */
export function normalizeMediaType(mediaType: string): string {
  const base = mediaType.split(';', 1)[0] ?? ''
  return base.trim().toLowerCase()
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot < 0 || dot === filename.length - 1) return ''
  return filename.slice(dot + 1).toLowerCase()
}

export interface ResolveMediaTypeInput {
  /** The type the upload declared. May be empty or `application/octet-stream`. */
  readonly mediaType?: string
  /** Consulted only when `mediaType` is missing or generic. */
  readonly filename?: string
}

/**
 * Decide which extractor handles these bytes. Fails loud rather than guessing:
 * an unrecognized type names itself and lists what is supported.
 */
export function resolveMediaType(input: ResolveMediaTypeInput): DocumentOutcome<ResolvedMediaType> {
  const declared = normalizeMediaType(input.mediaType ?? '')
  const fromExtension = input.filename ? EXTENSION_MEDIA_TYPES[extensionOf(input.filename)] : undefined
  const effective = (UNDECLARED.has(declared) ? fromExtension ?? declared : declared).toLowerCase()

  const fail = (message: string): DocumentOutcome<ResolvedMediaType> => ({
    succeeded: false,
    error: { code: 'unsupported-media-type', stage: 'media-type', message, mediaType: declared || (fromExtension ?? '') },
  })

  if (effective === PDF_MEDIA_TYPE) return { succeeded: true, value: { format: 'pdf', mediaType: PDF_MEDIA_TYPE } }
  const docx = DOCX_MEDIA_TYPES.get(effective)
  if (docx) return { succeeded: true, value: { format: 'docx', mediaType: docx } }
  if (LEGACY_DOC_MEDIA_TYPES.has(effective)) {
    return fail(
      `Legacy binary Word documents (${effective}) are not supported — they are OLE2 compound files, not OOXML packages. Save the file as .docx and upload it again.`,
    )
  }
  if (effective.startsWith('text/')) return { succeeded: true, value: { format: 'text', mediaType: effective } }
  if (effective === '') {
    return fail(
      `Cannot determine the document type: no media type was declared${input.filename ? ` and '${input.filename}' has no recognized extension` : ' and no filename was supplied'}. Supported: ${PDF_MEDIA_TYPE}, ${DOCX_MEDIA_TYPE}, and any text/* type.`,
    )
  }
  return fail(
    `Unsupported media type '${effective}'. Supported: ${PDF_MEDIA_TYPE}, ${DOCX_MEDIA_TYPE}, ${DOCM_MEDIA_TYPE}, and any text/* type.`,
  )
}
