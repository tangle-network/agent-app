# `/documents` — document text extraction

Turns an uploaded PDF, DOCX or text file into plain text, or into a typed failure that names the stage it stopped at.

Two subpaths:

| Import | Contains | Needs |
| --- | --- | --- |
| `@tangle-network/agent-app/documents` | `extractDocument`, `createDocumentExtractor`, the DOCX and text readers, the zip reader, every type | nothing — zero dependencies |
| `@tangle-network/agent-app/documents/pdf-inspector` | `createPdfInspectorEngine`, `initPdfInspector` | optional peer `@firecrawl/pdf-inspector-wasm`, plus the wasm delivery below |

The split is not stylistic.
The PDF engine's `.wasm` has to reach the runtime as a build-time module asset produced by the *consumer's* bundler, so a shared library cannot import it; and a product that only accepts DOCX and text should not have to install a wasm package it never calls.
DOCX needs no dependency at all — `DecompressionStream('deflate-raw')` is a runtime API in both workerd and Node, so the OOXML reader is header arithmetic plus a stream.

## The scanned-PDF contract

A PDF with no text layer fails with `pdf-needs-ocr`, carrying the full page-level classification.

It is never an empty string.
A product that receives `''` from a scan renders an empty page or, worse, hands nothing to a model that then answers confidently about a document nobody read.

```ts
const outcome = await documents.extract(bytes, { mediaType, filename })
if (!outcome.succeeded) {
  if (outcome.error.code === 'pdf-needs-ocr') {
    // outcome.error.classification.pagesNeedingOcr → [1, 2, 3] (1-indexed)
    return offerOcr(outcome.error.classification)
  }
  return renderFailure(outcome.error.stage, outcome.error.message)
}
```

## Delivering the wasm

This is the step that cost two products a day each.

### 1. Install the engine

```bash
pnpm add @firecrawl/pdf-inspector-wasm
```

### 2. Declare the `.wasm` import for TypeScript

Both wrangler's bundler and `@cloudflare/vite-plugin` apply the `CompiledWasm` rule to a `.wasm` import, so it resolves to an already-compiled `WebAssembly.Module`.
There is no wrangler `rules` entry to add.
TypeScript needs to be told, once, in the app's ambient declarations (`src/env.d.ts` or equivalent):

```ts
declare module '*.wasm' {
  const wasmModule: WebAssembly.Module
  export default wasmModule
}
```

### 3. Build the engine once, at module scope

```ts
// app/lib/.server/documents.ts
import wasm from '@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm'
import { createDocumentExtractor } from '@tangle-network/agent-app/documents'
import { createPdfInspectorEngine } from '@tangle-network/agent-app/documents/pdf-inspector'

export const documents = createDocumentExtractor({
  pdf: createPdfInspectorEngine(wasm),
  maxBytes: 25 * 1024 * 1024,
})
```

Instantiation is lazy: `createPdfInspectorEngine` costs nothing until the first PDF arrives, and is idempotent per isolate afterwards.
To pay it at startup instead of on a user's first upload, call `initPdfInspector(wasm)` from your worker's init path.

### 4. Point vitest at the same bytes

Node cannot import a `.wasm` as a module, so tests alias the specifier to a shim that compiles identical bytes:

```ts
// vitest.config.ts
resolve: {
  alias: [
    {
      find: /^@firecrawl\/pdf-inspector-wasm\/pdf_inspector_wasm_bg\.wasm$/,
      replacement: resolve(__dirname, 'tests/support/pdf-inspector-wasm-node.ts'),
    },
  ],
},
```

```ts
// tests/support/pdf-inspector-wasm-node.ts
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const dir = dirname(require.resolve('@firecrawl/pdf-inspector-wasm'))
export default new WebAssembly.Module(readFileSync(join(dir, 'pdf_inspector_wasm_bg.wasm')))
```

The alias is only needed where the app's own code imports the `.wasm`.
Nothing in `agent-app` imports it, so this package's own tests just read the bytes and hand them to `createPdfInspectorEngine` — `initSync` accepts a `WebAssembly.Module` or raw bytes.

### Why this engine, and not another

- `@firecrawl/pdf-inspector-wasm` imports nothing but its own JS glue — no WASI — and `initSync` instantiates an already-compiled module, which is exactly what workerd permits. Compiling wasm from bytes at request time is what it forbids.
- The **napi** build of the same library does not run under workerd.
- pdfjs-based extractors need DOM globals workerd does not provide.

## Classification

```ts
const classified = documents.classifyPdf(bytes)
if (classified.succeeded) {
  classified.value.kind            // 'text-based' | 'scanned' | 'image-based' | 'mixed'
  classified.value.pageCount       // 40
  classified.value.pagesNeedingOcr // [12, 13] — ALWAYS 1-indexed
  classified.value.needsOcr        // true when no page has text at all
  classified.value.partiallyScanned // true when some pages do
  classified.value.pages           // one row per page: needsOcr, ocrReasons, hasTable, hasColumns
}
```

`pagesNeedingOcr` is 1-indexed on purpose.
The underlying engine's two entry points disagree — `classifyPdf` reports 0-indexed pages, `detectPdf` reports the same pages 1-indexed — and both predecessor integrations carried a hand-written `page + 1` at their UI.
This module publishes one indexing convention so nothing downstream has to know which engine call produced a number.

## Text format

`preferredPdfFormat` selects the extraction engine:

| Value | Engine | Shape |
| --- | --- | --- |
| `'text'` (default) | `extractText` | Plain text with the source's line breaks intact — what line-anchored parsers need |
| `'markdown'` | `processPdf` | Headings and `<!-- Page N -->` markers, but lines reflowed into paragraphs |

It is a *preference* because of one measured case.
`extractText` panics inside the wasm (`RuntimeError: unreachable`) on any document with a page that has no text layer — including a `mixed` document whose other 39 pages are perfectly readable.
Only the markdown engine survives that, so a partially scanned PDF is extracted as markdown regardless of what was asked for, and the result says so:

```ts
outcome.value.pdf?.textFormat // 'markdown'
outcome.value.pdf?.partial    // true
outcome.value.warnings        // ['Page 12 of 40 have no text layer and need OCR; …', '…extracted as markdown because…']
```

Check `pdf.textFormat` when the distinction matters.
Both predecessor integrations returned a bare failure for this case, so a 40-page contract with one scanned exhibit was rejected outright.

## OCR is not here

Deliberately.
OCR belongs to the sandbox image, where `ocrmypdf` and `tesseract` are pre-baked; a wasm OCR stack in a Worker is the wrong shape and the wrong cost.

This module's job is to produce a signal precise enough to route to it:

```ts
if (!outcome.succeeded && outcome.error.code === 'pdf-needs-ocr') {
  const box = await shell.provisionSandbox(/* … */)          // @tangle-network/agent-app/sandbox
  const text = await runOcrInSandbox(box, bytes)             // product-owned: ocrmypdf --sidecar
  // Feed the recovered text back through the SAME downstream parser a digital
  // document uses — pass it as text/plain, or hand it straight to your parser.
}
```

Two rules for the handoff:

1. The sandbox image must already carry the OCR binary. Verify with `command -v ocrmypdf` and fail loud if it is absent — installing it per request is a several-minute cold start hidden inside a user's upload.
2. OCR-recovered text must re-enter the same code path as digital text. A second parser for OCR output is the start of two implementations that drift.

## Errors

Every failure carries a `stage` and a `code`.

| Stage | Codes | Means |
| --- | --- | --- |
| `size-check` | `too-large`, `empty-document` | Rejected before any parsing |
| `media-type` | `unsupported-media-type` | Nothing here can read this type; the message names what can be read |
| `classify` | `pdf-engine-unavailable`, `pdf-needs-ocr`, `classification-failed` | The PDF could not be read, or has no text to read |
| `extract` | `extraction-failed`, `malformed-archive`, `empty-document` | The container parsed but produced no usable text |
| `decode` | `decode-failed`, `empty-document` | Bytes declared as text are not valid UTF-8, or are blank |

Text files are decoded strictly.
Bytes that are not valid UTF-8 fail with `decode-failed` rather than being decoded lossily — mojibake handed to a model reads as prose and is not recoverable downstream.

## Untrusted archives: what is bounded, and by what

This module reads bytes a user uploaded, so both zip failure modes are bounded, and by different mechanisms.

**Expansion is capped per part, before and during the inflate.**
`maxBytes` (default 25 MB) bounds the ARCHIVE.
It does nothing to bound the decompression the archive asks for: deflate reaches roughly 1000:1 on repetitive input, so a 25 MB upload can request 25 GB of output inside an isolate with 128 MB, which is a crash rather than an error a product can report.
`maxUncompressedPartBytes` (default `DEFAULT_MAX_ZIP_ENTRY_BYTES`, 32 MB) is the second dial.
It is checked twice: against the size the central directory DECLARES before any inflate begins, and against the real output as the stream arrives, because the declared size is the archive's own claim about itself.
Both refusals are ordinary typed failures — `malformed-archive` at stage `extract`.

```ts
await documents.extract(bytes, { mediaType, filename, maxUncompressedPartBytes: 8 * 1024 * 1024 })
// → { succeeded: false, error: { code: 'malformed-archive', stage: 'extract',
//     message: "'word/document.xml' expands past the 8388608-byte per-entry limit …" } }
```

**The end-of-central-directory record is resolved the same way the upload gate resolves it.**
A zip's trailing comment can contain anything, including bytes that spell `PK\x05\x06`, so a reader that stops at the first signature it finds scanning backwards can resolve a DIFFERENT record than a reader that also checks the comment length accounts for the trailing bytes.
Two readers that disagree mean the gate approves one archive and the extractor reads another.
Both readers check the comment length.

## Supported types

| Media type | Format | Reader |
| --- | --- | --- |
| `application/pdf` | `pdf` | wasm engine, classify-first |
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `docx` | built in, no dependency |
| `application/vnd.ms-word.document.macroEnabled.12` (`.docm`) | `docx` | same reader; the VBA project is never read or executed |
| `text/*` | `text` | strict UTF-8 decode |

`application/msword` (legacy binary `.doc`) is refused with an instruction to convert, because an OLE2 compound file is not a zip and would otherwise surface as a confusing archive error.

When the upload declares `application/octet-stream` — which browsers routinely do — the filename extension decides.
A declared type always wins over the extension.

### What the DOCX reader does with WordprocessingML

- `<w:t>` runs become text; `<w:tab/>` becomes a tab; `<w:br/>` and `<w:cr/>` become newlines; each `</w:p>` ends a line.
- `<w:instrText>` is dropped — field instruction codes such as `HYPERLINK "…"` are machinery, not prose.
- `<w:delText>` is dropped — text a tracked change deleted should not appear as if the author wrote it.
- XML character references are resolved; an unknown entity is left verbatim rather than silently dropped.
- The main part is located through `_rels/.rels`, not assumed to be `word/document.xml`.

One line per paragraph, not blank-line-separated blocks: downstream parsers match line-anchored patterns against form and contract text.
