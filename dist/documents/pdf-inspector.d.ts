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
import type { DocumentOutcome, PdfEngine } from './types';
/**
 * The compiled wasm, or a thunk that produces it on first use.
 *
 * A Worker passes the `.wasm` module import (a `WebAssembly.Module`); Node
 * passes raw bytes. A thunk defers reading either until a PDF actually arrives.
 */
export type PdfInspectorWasm = WebAssembly.Module | BufferSource | (() => WebAssembly.Module | BufferSource);
/** Instantiate the engine for this isolate. Idempotent; safe to call per
 *  request. Exported so a product can warm the wasm at startup instead of
 *  paying instantiation on a user's first upload. */
export declare function initPdfInspector(wasm: PdfInspectorWasm): DocumentOutcome<{
    version: string;
}>;
/** Whether the engine has been instantiated in this isolate. */
export declare function isPdfInspectorReady(): boolean;
/**
 * Build the wasm-backed engine. Instantiation is lazy — the first classify or
 * extract call initializes it — so importing this costs nothing until a PDF
 * arrives.
 */
export declare function createPdfInspectorEngine(wasm: PdfInspectorWasm): PdfEngine;
