/**
 * The wasm-backed {@link PdfEngine}, binding `@firecrawl/pdf-inspector-wasm`
 * (MIT, Rust→wasm).
 *
 * **Why this is its own subpath.** The engine's `.wasm` must reach the runtime
 * as a build-time module asset produced by the CONSUMER's bundler — workerd
 * forbids compiling wasm from bytes at request time — so a shared library
 * cannot import it. This file therefore imports only the JS glue and takes the
 * compiled module as an argument. Keeping it out of
 * `@tangle-network/agent-app/documents` also means a product that only handles
 * DOCX and text never needs the package installed at all.
 *
 * **Why this engine.** It is the one PDF extractor proven to run under real
 * workerd: the wasm imports nothing but its own JS glue (no WASI), and
 * `initSync` instantiates an already-compiled `WebAssembly.Module`, which is
 * exactly the case workerd permits. The napi build does not run there, and
 * pdfjs-based extractors need DOM globals workerd does not have.
 *
 * **Engine behaviour this wrapper is built around, measured on real fixture
 * PDFs (`tests/documents/pdf.test.ts` re-measures all of it):**
 * - `extractText` emits an image placeholder for a page with no text layer.
 *   Classification must run first so a placeholder is not reported as a
 *   complete extraction.
 * - `processPdf` returns the readable pages' markdown, which is why `extract`
 *   uses it for markdown and for anything partially scanned.
 * - `detectPdf` reports OCR pages 1-INDEXED, while `classifyPdf` reports the
 *   same pages 0-indexed. This wrapper uses `detectPdf` (it carries per-page
 *   reasons and layout that `classifyPdf` does not) and publishes 1-indexed.
 * - `processPdf`'s own `pagesNeedingOcr` is unreliable — it reported both pages
 *   of a fully text-based 2-page PDF as needing OCR — so the classification a
 *   caller sees always comes from `detectPdf`.
 */

import { detectPdf, initSync, processPdf, extractText, version } from '@firecrawl/pdf-inspector-wasm'

import type {
  DocumentOutcome,
  PdfClassification,
  PdfContentKind,
  PdfEngine,
  PdfPageClassification,
  PdfTextFormat,
} from './types'

/**
 * The compiled wasm, or a thunk that produces it on first use.
 *
 * A Worker passes the `.wasm` module import (a `WebAssembly.Module`); Node
 * passes raw bytes. A thunk defers reading either until a PDF actually arrives.
 */
export type PdfInspectorWasm =
  | WebAssembly.Module
  | BufferSource
  | (() => WebAssembly.Module | BufferSource)

// `initSync` binds a module-global inside the engine's glue, so readiness is
// per-isolate, not per-engine-instance: two engines built from the same wasm
// must not each re-instantiate it.
let initialized = false

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fail(
  code: 'classification-failed' | 'extraction-failed',
  stage: 'classify' | 'extract',
  message: string,
): { succeeded: false; error: { code: 'classification-failed' | 'extraction-failed'; stage: 'classify' | 'extract'; message: string; mediaType: string } } {
  return { succeeded: false, error: { code, stage, message, mediaType: 'application/pdf' } }
}

const KINDS: Readonly<Record<string, PdfContentKind>> = {
  TextBased: 'text-based',
  Scanned: 'scanned',
  ImageBased: 'image-based',
  Mixed: 'mixed',
}

/** Instantiate the engine for this isolate. Idempotent; safe to call per
 *  request. Exported so a product can warm the wasm at startup instead of
 *  paying instantiation on a user's first upload. */
export function initPdfInspector(wasm: PdfInspectorWasm): DocumentOutcome<{ version: string }> {
  try {
    if (!initialized) {
      initSync({ module: typeof wasm === 'function' ? wasm() : wasm })
      initialized = true
    }
    return { succeeded: true, value: { version: version() } }
  } catch (error) {
    initialized = false
    return {
      succeeded: false,
      error: {
        code: 'classification-failed',
        stage: 'classify',
        mediaType: 'application/pdf',
        message: `The PDF engine's wasm failed to instantiate — ${detail(error)}. Check that the .wasm asset reaches the runtime as a compiled module (see the documents module docs).`,
      },
    }
  }
}

/** Whether the engine has been instantiated in this isolate. */
export function isPdfInspectorReady(): boolean {
  return initialized
}

function toClassification(result: {
  pdfType: string
  pageCount: number
  pagesNeedingOcr: number[]
  ocrReasonsByPage: { page: number; reasons: string[] }[]
  confidence: number
  layout: { isComplex: boolean; pagesWithTables: number[]; pagesWithColumns: number[] }
  hasEncodingIssues: boolean
}): PdfClassification {
  const kind = KINDS[result.pdfType] ?? 'mixed'
  const needing = new Set(result.pagesNeedingOcr)
  const reasons = new Map(result.ocrReasonsByPage.map((entry) => [entry.page, entry.reasons]))
  const tables = new Set(result.layout.pagesWithTables)
  const columns = new Set(result.layout.pagesWithColumns)

  const pages: PdfPageClassification[] = []
  for (let pageNumber = 1; pageNumber <= result.pageCount; pageNumber++) {
    pages.push({
      pageNumber,
      index: pageNumber - 1,
      needsOcr: needing.has(pageNumber),
      ocrReasons: reasons.get(pageNumber) ?? [],
      hasTable: tables.has(pageNumber),
      hasColumns: columns.has(pageNumber),
    })
  }

  const pagesNeedingOcr = pages.filter((page) => page.needsOcr).map((page) => page.pageNumber)
  // `kind` alone cannot decide this: a 1-page scan and a 40-page document with
  // one scanned exhibit can both come back `Scanned`/`Mixed` depending on the
  // engine's confidence, so the page count is what separates "no text at all"
  // from "text on most pages".
  const noTextAnywhere = result.pageCount > 0 && pagesNeedingOcr.length === result.pageCount
  return {
    kind,
    pageCount: result.pageCount,
    confidence: result.confidence,
    pages,
    pagesNeedingOcr,
    needsOcr: noTextAnywhere || ((kind === 'scanned' || kind === 'image-based') && pagesNeedingOcr.length === 0),
    partiallyScanned: pagesNeedingOcr.length > 0 && !noTextAnywhere,
    complexLayout: result.layout.isComplex,
    hasEncodingIssues: result.hasEncodingIssues,
  }
}

/**
 * Build the wasm-backed engine. Instantiation is lazy — the first classify or
 * extract call initializes it — so importing this costs nothing until a PDF
 * arrives.
 */
export function createPdfInspectorEngine(wasm: PdfInspectorWasm): PdfEngine {
  const ready = (): DocumentOutcome<{ version: string }> => initPdfInspector(wasm)

  return {
    classify(bytes: Uint8Array) {
      const init = ready()
      if (!init.succeeded) return init
      try {
        return { succeeded: true, value: toClassification(detectPdf(bytes)) }
      } catch (error) {
        return fail('classification-failed', 'classify', `The PDF could not be read — ${detail(error)}.`)
      }
    },
    extract(bytes: Uint8Array, format: PdfTextFormat) {
      const init = ready()
      if (!init.succeeded) return { succeeded: false, error: { ...init.error, code: 'extraction-failed', stage: 'extract' } }
      try {
        if (format === 'text') return { succeeded: true, value: extractText(bytes) }
        const processed = processPdf(bytes, { profile: 'fidelity', includePageMarkers: true })
        return { succeeded: true, value: processed.markdown ?? '' }
      } catch (error) {
        return fail('extraction-failed', 'extract', `The PDF's text could not be extracted — ${detail(error)}.`)
      }
    },
  }
}
