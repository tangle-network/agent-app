/**
 * DOCX → plain text, one paragraph per line.
 *
 * The main document part is resolved through the OPC relationship graph
 * (`_rels/.rels` → the `officeDocument` relationship's target) rather than
 * assuming `word/document.xml`, because the part name is a producer's choice,
 * not a constant.
 *
 * WordprocessingML text lives in `<w:t>` runs. Everything else is markup, with
 * four exceptions that carry meaning a reader would otherwise lose: `<w:tab/>`,
 * `<w:br/>`, `<w:cr/>`, and the paragraph boundary `</w:p>`. Two element bodies
 * are deliberately DROPPED — `<w:instrText>` (field instruction codes such as
 * `HYPERLINK "…"`, which are machinery, not prose) and `<w:delText>` (text a
 * tracked-changes revision deleted; extracting it would show a reader words the
 * author removed).
 *
 * One line per paragraph, not blank-line-separated paragraphs: extractors
 * downstream match line-anchored patterns against form and contract text, so a
 * predictable line structure is the useful shape.
 */

import type { DocumentOutcome, DocxExtractionDetail } from './types'
import { readZipDirectory, readZipEntry, type ReadZipEntryOptions } from './zip'

const RELATIONSHIPS_PART = '_rels/.rels'
const OFFICE_DOCUMENT_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/** Resolve XML character/entity references. Unknown entities are left verbatim
 *  rather than dropped, so nothing silently disappears from a document. */
export function decodeXmlEntities(input: string): string {
  if (!input.includes('&')) return input
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, reference: string) => {
    if (reference.startsWith('#x') || reference.startsWith('#X')) {
      const code = Number.parseInt(reference.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (reference.startsWith('#')) {
      const code = Number.parseInt(reference.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[reference] ?? match
  })
}

interface Tag {
  /** Local name without prefix, e.g. `t` for `<w:t>`. */
  readonly name: string
  readonly closing: boolean
  readonly selfClosing: boolean
}

/** Parse a tag body (the text between `<` and `>`) into name + shape. */
function parseTag(body: string): Tag {
  const closing = body.startsWith('/')
  const selfClosing = body.endsWith('/')
  let inner = body.slice(closing ? 1 : 0, selfClosing ? body.length - 1 : body.length)
  const space = inner.search(/[\s/]/)
  if (space >= 0) inner = inner.slice(0, space)
  const colon = inner.indexOf(':')
  return { name: colon >= 0 ? inner.slice(colon + 1) : inner, closing, selfClosing }
}

/** Element bodies whose text is markup or retracted content, never prose. */
const DROPPED_ELEMENTS = new Set(['instrText', 'delInstrText', 'delText'])

export interface DocxText {
  readonly text: string
  readonly paragraphCount: number
}

/**
 * Walk WordprocessingML and emit its readable text.
 *
 * Hand-scanned rather than regex-split because comments and CDATA sections may
 * contain `>`; a `/<[^>]*>/` scan ends the tag early on the first one and
 * corrupts everything after it.
 */
export function wordprocessingXmlToText(xml: string): DocxText {
  const out: string[] = []
  let paragraphCount = 0
  let textDepth = 0
  let dropDepth = 0
  let cursor = 0

  while (cursor < xml.length) {
    const open = xml.indexOf('<', cursor)
    if (open < 0) break
    if (open > cursor && textDepth > 0 && dropDepth === 0) {
      out.push(decodeXmlEntities(xml.slice(cursor, open)))
    }

    if (xml.startsWith('<!--', open)) {
      const close = xml.indexOf('-->', open + 4)
      cursor = close < 0 ? xml.length : close + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', open)) {
      const close = xml.indexOf(']]>', open + 9)
      const end = close < 0 ? xml.length : close
      if (textDepth > 0 && dropDepth === 0) out.push(xml.slice(open + 9, end))
      cursor = close < 0 ? xml.length : close + 3
      continue
    }
    const close = xml.indexOf('>', open + 1)
    if (close < 0) break
    const body = xml.slice(open + 1, close)
    cursor = close + 1
    if (body.startsWith('?') || body.startsWith('!')) continue

    const tag = parseTag(body)
    if (DROPPED_ELEMENTS.has(tag.name)) {
      if (tag.selfClosing) continue
      dropDepth += tag.closing ? -1 : 1
      if (dropDepth < 0) dropDepth = 0
      continue
    }
    if (dropDepth > 0) continue

    if (tag.name === 't') {
      if (tag.selfClosing) continue
      textDepth += tag.closing ? -1 : 1
      if (textDepth < 0) textDepth = 0
      continue
    }
    if (tag.name === 'tab' && !tag.closing) out.push('\t')
    else if ((tag.name === 'br' || tag.name === 'cr') && !tag.closing) out.push('\n')
    else if (tag.name === 'p' && tag.closing) {
      out.push('\n')
      paragraphCount++
    }
  }

  return { text: out.join('').replace(/\r\n?/g, '\n'), paragraphCount }
}

function relationshipTarget(relsXml: string): string | null {
  for (const match of relsXml.matchAll(/<[^>]*Relationship\b[^>]*>/g)) {
    const element = match[0]
    const type = /\bType\s*=\s*"([^"]*)"/.exec(element)?.[1]
    if (type !== OFFICE_DOCUMENT_RELATIONSHIP) continue
    const target = /\bTarget\s*=\s*"([^"]*)"/.exec(element)?.[1]
    if (target) return decodeXmlEntities(target).replace(/^\/+/, '')
  }
  return null
}

/**
 * Extract the readable text of a `.docx` / `.docm` package. Every failure names
 * the archive-level cause; a package this cannot read is an error, never an
 * empty document.
 *
 * `zip.maxUncompressedBytes` bounds what each part may expand to. It defaults
 * to the zip reader's own ceiling, which is what keeps a deflate bomb inside a
 * small `.docx` a typed error instead of an out-of-memory crash.
 */
export async function extractDocxText(
  bytes: Uint8Array,
  mediaType: string,
  zip: ReadZipEntryOptions = {},
): Promise<DocumentOutcome<{ text: string; detail: DocxExtractionDetail }>> {
  const fail = (
    code: 'malformed-archive' | 'extraction-failed',
    message: string,
  ): DocumentOutcome<{ text: string; detail: DocxExtractionDetail }> => ({
    succeeded: false,
    error: { code, stage: 'extract', message, mediaType },
  })

  const directory = readZipDirectory(bytes)
  if (!directory.succeeded) return fail('malformed-archive', `Not a readable Office package — ${directory.error}.`)

  const relsEntry = directory.value.find((entry) => entry.name === RELATIONSHIPS_PART)
  if (!relsEntry) {
    return fail(
      'malformed-archive',
      `Office package has no '${RELATIONSHIPS_PART}' part, so its main document cannot be located. Parts found: ${directory.value.map((e) => e.name).slice(0, 12).join(', ') || 'none'}.`,
    )
  }
  const relsBytes = await readZipEntry(bytes, relsEntry, zip)
  if (!relsBytes.succeeded) return fail('malformed-archive', `Could not read '${RELATIONSHIPS_PART}' — ${relsBytes.error}.`)

  const decoder = new TextDecoder('utf-8', { fatal: false })
  const partName = relationshipTarget(decoder.decode(relsBytes.value))
  if (partName === null) {
    return fail('malformed-archive', `Office package declares no officeDocument relationship in '${RELATIONSHIPS_PART}'.`)
  }

  const documentEntry = directory.value.find((entry) => entry.name === partName)
  if (!documentEntry) {
    return fail('malformed-archive', `Office package points at '${partName}' as its main document, but no such part exists in the archive.`)
  }
  const documentBytes = await readZipEntry(bytes, documentEntry, zip)
  if (!documentBytes.succeeded) return fail('malformed-archive', `Could not read '${partName}' — ${documentBytes.error}.`)

  const strict = new TextDecoder('utf-8', { fatal: true })
  let xml: string
  try {
    xml = strict.decode(documentBytes.value)
  } catch (error) {
    return fail('extraction-failed', `'${partName}' is not valid UTF-8 — ${error instanceof Error ? error.message : String(error)}.`)
  }

  const walked = wordprocessingXmlToText(xml)
  return {
    succeeded: true,
    value: { text: walked.text, detail: { part: partName, paragraphCount: walked.paragraphCount } },
  }
}
