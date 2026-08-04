/**
 * PDF classification and extraction against the REAL wasm engine on real PDFs.
 *
 * The first block re-measures the engine behaviour the module's design rests
 * on — including the panic that makes classify-first mandatory. It is asserted
 * here rather than described in a comment because if a future engine version
 * stops panicking (or starts panicking somewhere new), the module's control
 * flow is wrong and nothing else in the suite would notice.
 */

import { extractText } from '@firecrawl/pdf-inspector-wasm'
import { beforeAll, describe, expect, it } from 'vitest'

import { extractDocument, PDF_MEDIA_TYPE, createDocumentExtractor } from '../../src/documents'
import { createPdfInspectorEngine, initPdfInspector, isPdfInspectorReady } from '../../src/documents/pdf-inspector'
import { densePage, imageAndTextPdf, pdfInspectorWasmBytes, textPdf } from './fixtures'

const CONTRACT_LINES = [
  'MASTER SERVICES AGREEMENT',
  'Limitation of Liability: liability is capped at fees paid.',
  'Governing Law: Delaware.',
]

const engine = createPdfInspectorEngine(() => pdfInspectorWasmBytes())

let textBased: Uint8Array
let twoPageText: Uint8Array
let scanned: Uint8Array
let partiallyScanned: Uint8Array

beforeAll(async () => {
  textBased = await textPdf([CONTRACT_LINES])
  twoPageText = await textPdf([['PAGE ONE CLAUSE'], ['PAGE TWO CLAUSE']])
  scanned = await imageAndTextPdf(1, [])
  partiallyScanned = await imageAndTextPdf(1, [densePage('Services')])
})

describe('engine behaviour the classify-first contract depends on', () => {
  it('instantiates from raw wasm bytes and reports ready', () => {
    const init = initPdfInspector(pdfInspectorWasmBytes())
    expect(init.succeeded).toBe(true)
    if (init.succeeded) expect(init.value.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(isPdfInspectorReady()).toBe(true)
  })

  it('PANICS in extractText on a page with no text layer — the reason classify runs first', () => {
    expect(() => extractText(scanned)).toThrow()
    // …and on a partially scanned document too, where other pages are readable.
    expect(() => extractText(partiallyScanned)).toThrow()
  })

  it('survives that panic — the same instance still classifies afterwards', () => {
    const after = engine.classify(textBased)
    expect(after.succeeded).toBe(true)
    if (after.succeeded) expect(after.value.kind).toBe('text-based')
  })
})

describe('classification', () => {
  it('classifies a text-based PDF with no page needing OCR', () => {
    const outcome = engine.classify(textBased)
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    expect(outcome.value.kind).toBe('text-based')
    expect(outcome.value.pageCount).toBe(1)
    expect(outcome.value.needsOcr).toBe(false)
    expect(outcome.value.partiallyScanned).toBe(false)
    expect(outcome.value.pagesNeedingOcr).toEqual([])
    expect(outcome.value.pages).toEqual([
      { pageNumber: 1, index: 0, needsOcr: false, ocrReasons: [], hasTable: false, hasColumns: false },
    ])
  })

  it('emits one page row per page, 1-indexed for people and 0-indexed for arrays', () => {
    const outcome = engine.classify(twoPageText)
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    expect(outcome.value.pages.map((page) => page.pageNumber)).toEqual([1, 2])
    expect(outcome.value.pages.map((page) => page.index)).toEqual([0, 1])
  })

  it('classifies an image-only PDF as needing OCR everywhere', () => {
    const outcome = engine.classify(scanned)
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    expect(['scanned', 'image-based']).toContain(outcome.value.kind)
    expect(outcome.value.needsOcr).toBe(true)
    expect(outcome.value.partiallyScanned).toBe(false)
    expect(outcome.value.pagesNeedingOcr).toEqual([1])
    expect(outcome.value.pages[0]?.ocrReasons.length).toBeGreaterThan(0)
  })

  it('classifies a document with one scanned page as partially scanned, naming that page', () => {
    const outcome = engine.classify(partiallyScanned)
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    expect(outcome.value.kind).toBe('mixed')
    expect(outcome.value.pageCount).toBe(2)
    expect(outcome.value.needsOcr).toBe(false)
    expect(outcome.value.partiallyScanned).toBe(true)
    // 1-indexed: the scanned page is the SECOND page, not page 1.
    expect(outcome.value.pagesNeedingOcr).toEqual([2])
    expect(outcome.value.pages[0]?.needsOcr).toBe(false)
    expect(outcome.value.pages[1]?.needsOcr).toBe(true)
  })

  it('fails loud on bytes that are not a PDF', () => {
    const outcome = engine.classify(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]))
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error.code).toBe('classification-failed')
    expect(outcome.error.stage).toBe('classify')
  })
})

describe('extraction', () => {
  it('extracts a text-based PDF, preserving its line breaks', async () => {
    const outcome = await extractDocument(textBased, { mediaType: PDF_MEDIA_TYPE, pdf: engine, filename: 'msa.pdf' })
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    expect(outcome.value.format).toBe('pdf')
    expect(outcome.value.text.split('\n')).toEqual(CONTRACT_LINES)
    expect(outcome.value.pdf?.textFormat).toBe('text')
    expect(outcome.value.pdf?.partial).toBe(false)
    expect(outcome.value.pdf?.classification.kind).toBe('text-based')
    expect(outcome.value.warnings).toEqual([])
  })

  it('returns markdown with page markers when asked for it', async () => {
    const outcome = await extractDocument(twoPageText, {
      mediaType: PDF_MEDIA_TYPE,
      pdf: engine,
      preferredPdfFormat: 'markdown',
    })
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    expect(outcome.value.pdf?.textFormat).toBe('markdown')
    expect(outcome.value.text).toContain('<!-- Page 1 -->')
    expect(outcome.value.text).toContain('<!-- Page 2 -->')
  })

  it('returns pdf-needs-ocr with the page detail for a scan — never an empty string', async () => {
    const outcome = await extractDocument(scanned, { mediaType: PDF_MEDIA_TYPE, pdf: engine, filename: 'scan.pdf' })
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error.code).toBe('pdf-needs-ocr')
    expect(outcome.error.stage).toBe('classify')
    expect(outcome.error.message).toContain('OCR')
    expect(outcome.error.classification?.pagesNeedingOcr).toEqual([1])
    expect(outcome.error.classification?.pageCount).toBe(1)
  })

  it('recovers the readable pages of a partially scanned PDF and names what is missing', async () => {
    const outcome = await extractDocument(partiallyScanned, {
      mediaType: PDF_MEDIA_TYPE,
      pdf: engine,
      filename: 'exhibit.pdf',
    })
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    expect(outcome.value.text).toContain('Services clause 1.')
    expect(outcome.value.pdf?.partial).toBe(true)
    // The plain-text engine cannot read this document at all, so the result
    // reports the format it actually produced instead of the one requested.
    expect(outcome.value.pdf?.textFormat).toBe('markdown')
    expect(outcome.value.pdf?.classification.pagesNeedingOcr).toEqual([2])
    expect(outcome.value.warnings.join(' ')).toContain('Page 2 of 2')
    expect(outcome.value.warnings.join(' ')).toContain('markdown')
  })

  it('refuses a PDF when no engine was supplied, naming the subpath that provides one', async () => {
    const outcome = await extractDocument(textBased, { mediaType: PDF_MEDIA_TYPE })
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error.code).toBe('pdf-engine-unavailable')
    expect(outcome.error.message).toContain('documents/pdf-inspector')
  })

  it('surfaces a classification failure through the pipeline rather than throwing', async () => {
    const outcome = await extractDocument(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 9, 9]), {
      mediaType: PDF_MEDIA_TYPE,
      pdf: engine,
    })
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error.code).toBe('classification-failed')
  })
})

describe('bound extractor', () => {
  it('carries the engine and the cap so call sites do not re-wire them', async () => {
    const documents = createDocumentExtractor({ pdf: engine, maxBytes: 64 })
    const oversize = await documents.extract(textBased, { mediaType: PDF_MEDIA_TYPE, filename: 'msa.pdf' })
    expect(oversize.succeeded).toBe(false)
    if (!oversize.succeeded) expect(oversize.error.code).toBe('too-large')

    const classification = createDocumentExtractor({ pdf: engine }).classifyPdf(scanned)
    expect(classification.succeeded).toBe(true)
    if (classification.succeeded) expect(classification.value.needsOcr).toBe(true)
  })

  it('refuses to classify when it was built without an engine', () => {
    const outcome = createDocumentExtractor().classifyPdf(new Uint8Array([1, 2, 3]))
    expect(outcome.succeeded).toBe(false)
    if (!outcome.succeeded) expect(outcome.error.code).toBe('pdf-engine-unavailable')
  })
})
