// src/documents/pdf-inspector.ts
import { detectPdf, initSync, processPdf, extractText, version } from "@firecrawl/pdf-inspector-wasm";
var initialized = false;
function detail(error) {
  return error instanceof Error ? error.message : String(error);
}
function fail(code, stage, message) {
  return { succeeded: false, error: { code, stage, message, mediaType: "application/pdf" } };
}
var KINDS = {
  TextBased: "text-based",
  Scanned: "scanned",
  ImageBased: "image-based",
  Mixed: "mixed"
};
function initPdfInspector(wasm) {
  try {
    if (!initialized) {
      initSync({ module: typeof wasm === "function" ? wasm() : wasm });
      initialized = true;
    }
    return { succeeded: true, value: { version: version() } };
  } catch (error) {
    initialized = false;
    return {
      succeeded: false,
      error: {
        code: "classification-failed",
        stage: "classify",
        mediaType: "application/pdf",
        message: `The PDF engine's wasm failed to instantiate \u2014 ${detail(error)}. Check that the .wasm asset reaches the runtime as a compiled module (see the documents module docs).`
      }
    };
  }
}
function isPdfInspectorReady() {
  return initialized;
}
function toClassification(result) {
  const kind = KINDS[result.pdfType] ?? "mixed";
  const needing = new Set(result.pagesNeedingOcr);
  const reasons = new Map(result.ocrReasonsByPage.map((entry) => [entry.page, entry.reasons]));
  const tables = new Set(result.layout.pagesWithTables);
  const columns = new Set(result.layout.pagesWithColumns);
  const pages = [];
  for (let pageNumber = 1; pageNumber <= result.pageCount; pageNumber++) {
    pages.push({
      pageNumber,
      index: pageNumber - 1,
      needsOcr: needing.has(pageNumber),
      ocrReasons: reasons.get(pageNumber) ?? [],
      hasTable: tables.has(pageNumber),
      hasColumns: columns.has(pageNumber)
    });
  }
  const pagesNeedingOcr = pages.filter((page) => page.needsOcr).map((page) => page.pageNumber);
  const noTextAnywhere = result.pageCount > 0 && pagesNeedingOcr.length === result.pageCount;
  return {
    kind,
    pageCount: result.pageCount,
    confidence: result.confidence,
    pages,
    pagesNeedingOcr,
    needsOcr: noTextAnywhere || (kind === "scanned" || kind === "image-based") && pagesNeedingOcr.length === 0,
    partiallyScanned: pagesNeedingOcr.length > 0 && !noTextAnywhere,
    complexLayout: result.layout.isComplex,
    hasEncodingIssues: result.hasEncodingIssues
  };
}
function createPdfInspectorEngine(wasm) {
  const ready = () => initPdfInspector(wasm);
  return {
    classify(bytes) {
      const init = ready();
      if (!init.succeeded) return init;
      try {
        return { succeeded: true, value: toClassification(detectPdf(bytes)) };
      } catch (error) {
        return fail("classification-failed", "classify", `The PDF could not be read \u2014 ${detail(error)}.`);
      }
    },
    extract(bytes, format) {
      const init = ready();
      if (!init.succeeded) return { succeeded: false, error: { ...init.error, code: "extraction-failed", stage: "extract" } };
      try {
        if (format === "text") return { succeeded: true, value: extractText(bytes) };
        const processed = processPdf(bytes, { profile: "fidelity", includePageMarkers: true });
        return { succeeded: true, value: processed.markdown ?? "" };
      } catch (error) {
        return fail("extraction-failed", "extract", `The PDF's text could not be extracted \u2014 ${detail(error)}.`);
      }
    }
  };
}
export {
  createPdfInspectorEngine,
  initPdfInspector,
  isPdfInspectorReady
};
//# sourceMappingURL=pdf-inspector.js.map