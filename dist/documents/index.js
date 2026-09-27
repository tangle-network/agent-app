// src/documents/zip.ts
var END_OF_CENTRAL_DIRECTORY = 101010256;
var CENTRAL_FILE_HEADER = 33639248;
var LOCAL_FILE_HEADER = 67324752;
var ZIP64_SENTINEL_32 = 4294967295;
var ZIP64_SENTINEL_16 = 65535;
var MAX_COMMENT_LENGTH = 65535;
var END_OF_CENTRAL_DIRECTORY_SIZE = 22;
var STORED = 0;
var DEFLATED = 8;
function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function findEndOfCentralDirectory(bytes) {
  const dv = view(bytes);
  const earliest = Math.max(0, bytes.byteLength - END_OF_CENTRAL_DIRECTORY_SIZE - MAX_COMMENT_LENGTH);
  for (let offset = bytes.byteLength - END_OF_CENTRAL_DIRECTORY_SIZE; offset >= earliest; offset--) {
    if (dv.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY) continue;
    if (offset + END_OF_CENTRAL_DIRECTORY_SIZE + dv.getUint16(offset + 20, true) === bytes.byteLength) return offset;
  }
  return -1;
}
function readZipDirectory(bytes) {
  if (bytes.byteLength < END_OF_CENTRAL_DIRECTORY_SIZE) {
    return { succeeded: false, error: `not a zip archive \u2014 ${bytes.byteLength} bytes is shorter than an empty archive` };
  }
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) {
    return { succeeded: false, error: "not a zip archive \u2014 no end-of-central-directory record found" };
  }
  const dv = view(bytes);
  const entryCount = dv.getUint16(eocd + 10, true);
  const directoryOffset = dv.getUint32(eocd + 16, true);
  if (entryCount === ZIP64_SENTINEL_16 || directoryOffset === ZIP64_SENTINEL_32) {
    return { succeeded: false, error: "zip64 archives are not supported" };
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const entries = [];
  let cursor = directoryOffset;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > bytes.byteLength || dv.getUint32(cursor, true) !== CENTRAL_FILE_HEADER) {
      return { succeeded: false, error: `central directory is truncated at entry ${i + 1} of ${entryCount}` };
    }
    const flags = dv.getUint16(cursor + 8, true);
    const nameLength = dv.getUint16(cursor + 28, true);
    const extraLength = dv.getUint16(cursor + 30, true);
    const commentLength = dv.getUint16(cursor + 32, true);
    entries.push({
      name: decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)),
      compressionMethod: dv.getUint16(cursor + 10, true),
      compressedSize: dv.getUint32(cursor + 20, true),
      uncompressedSize: dv.getUint32(cursor + 24, true),
      localHeaderOffset: dv.getUint32(cursor + 42, true),
      encrypted: (flags & 1) !== 0
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return { succeeded: true, value: entries };
}
var DEFAULT_MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024;
async function inflateRaw(payload, limit) {
  const body = new Response(payload).body;
  if (!body) throw new Error("payload produced no readable stream");
  const reader = body.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === void 0) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return { kind: "limit-exceeded", bytes: total };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", value: out };
}
async function readZipEntry(bytes, entry, options = {}) {
  if (entry.encrypted) {
    return { succeeded: false, error: `'${entry.name}' is encrypted \u2014 password-protected archives are not supported` };
  }
  const limit = options.maxUncompressedBytes ?? DEFAULT_MAX_ZIP_ENTRY_BYTES;
  if (entry.uncompressedSize > limit) {
    return {
      succeeded: false,
      error: `'${entry.name}' declares ${entry.uncompressedSize} uncompressed bytes, over the ${limit}-byte per-entry limit`
    };
  }
  const dv = view(bytes);
  if (entry.localHeaderOffset + 30 > bytes.byteLength || dv.getUint32(entry.localHeaderOffset, true) !== LOCAL_FILE_HEADER) {
    return { succeeded: false, error: `'${entry.name}' has no local file header at offset ${entry.localHeaderOffset}` };
  }
  const nameLength = dv.getUint16(entry.localHeaderOffset + 26, true);
  const extraLength = dv.getUint16(entry.localHeaderOffset + 28, true);
  const start = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.byteLength) {
    return { succeeded: false, error: `'${entry.name}' payload runs past the end of the archive` };
  }
  const payload = bytes.subarray(start, end);
  if (entry.compressionMethod === STORED) return { succeeded: true, value: payload };
  if (entry.compressionMethod !== DEFLATED) {
    return { succeeded: false, error: `'${entry.name}' uses unsupported compression method ${entry.compressionMethod}` };
  }
  try {
    const inflated = await inflateRaw(payload, limit);
    if (inflated.kind === "limit-exceeded") {
      return {
        succeeded: false,
        error: `'${entry.name}' expands past the ${limit}-byte per-entry limit (declared ${entry.uncompressedSize})`
      };
    }
    if (inflated.value.byteLength !== entry.uncompressedSize) {
      return {
        succeeded: false,
        error: `'${entry.name}' inflated to ${inflated.value.byteLength} bytes but the directory declares ${entry.uncompressedSize}`
      };
    }
    return { succeeded: true, value: inflated.value };
  } catch (error2) {
    return { succeeded: false, error: `'${entry.name}' failed to inflate \u2014 ${error2 instanceof Error ? error2.message : String(error2)}` };
  }
}

// src/documents/docx.ts
var RELATIONSHIPS_PART = "_rels/.rels";
var OFFICE_DOCUMENT_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
var NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'"
};
function decodeXmlEntities(input) {
  if (!input.includes("&")) return input;
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, reference) => {
    if (reference.startsWith("#x") || reference.startsWith("#X")) {
      const code = Number.parseInt(reference.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (reference.startsWith("#")) {
      const code = Number.parseInt(reference.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[reference] ?? match;
  });
}
function parseTag(body) {
  const closing = body.startsWith("/");
  const selfClosing = body.endsWith("/");
  let inner = body.slice(closing ? 1 : 0, selfClosing ? body.length - 1 : body.length);
  const space = inner.search(/[\s/]/);
  if (space >= 0) inner = inner.slice(0, space);
  const colon = inner.indexOf(":");
  return { name: colon >= 0 ? inner.slice(colon + 1) : inner, closing, selfClosing };
}
var DROPPED_ELEMENTS = /* @__PURE__ */ new Set(["instrText", "delInstrText", "delText"]);
function wordprocessingXmlToText(xml) {
  const out = [];
  let paragraphCount = 0;
  let textDepth = 0;
  let dropDepth = 0;
  let cursor = 0;
  while (cursor < xml.length) {
    const open = xml.indexOf("<", cursor);
    if (open < 0) break;
    if (open > cursor && textDepth > 0 && dropDepth === 0) {
      out.push(decodeXmlEntities(xml.slice(cursor, open)));
    }
    if (xml.startsWith("<!--", open)) {
      const close2 = xml.indexOf("-->", open + 4);
      cursor = close2 < 0 ? xml.length : close2 + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const close2 = xml.indexOf("]]>", open + 9);
      const end = close2 < 0 ? xml.length : close2;
      if (textDepth > 0 && dropDepth === 0) out.push(xml.slice(open + 9, end));
      cursor = close2 < 0 ? xml.length : close2 + 3;
      continue;
    }
    const close = xml.indexOf(">", open + 1);
    if (close < 0) break;
    const body = xml.slice(open + 1, close);
    cursor = close + 1;
    if (body.startsWith("?") || body.startsWith("!")) continue;
    const tag = parseTag(body);
    if (DROPPED_ELEMENTS.has(tag.name)) {
      if (tag.selfClosing) continue;
      dropDepth += tag.closing ? -1 : 1;
      if (dropDepth < 0) dropDepth = 0;
      continue;
    }
    if (dropDepth > 0) continue;
    if (tag.name === "t") {
      if (tag.selfClosing) continue;
      textDepth += tag.closing ? -1 : 1;
      if (textDepth < 0) textDepth = 0;
      continue;
    }
    if (tag.name === "tab" && !tag.closing) out.push("	");
    else if ((tag.name === "br" || tag.name === "cr") && !tag.closing) out.push("\n");
    else if (tag.name === "p" && tag.closing) {
      out.push("\n");
      paragraphCount++;
    }
  }
  return { text: out.join("").replace(/\r\n?/g, "\n"), paragraphCount };
}
function relationshipTarget(relsXml) {
  for (const match of relsXml.matchAll(/<[^>]*Relationship\b[^>]*>/g)) {
    const element = match[0];
    const type = /\bType\s*=\s*"([^"]*)"/.exec(element)?.[1];
    if (type !== OFFICE_DOCUMENT_RELATIONSHIP) continue;
    const target = /\bTarget\s*=\s*"([^"]*)"/.exec(element)?.[1];
    if (target) return decodeXmlEntities(target).replace(/^\/+/, "");
  }
  return null;
}
async function extractDocxText(bytes, mediaType, zip = {}) {
  const fail = (code, message) => ({
    succeeded: false,
    error: { code, stage: "extract", message, mediaType }
  });
  const directory = readZipDirectory(bytes);
  if (!directory.succeeded) return fail("malformed-archive", `Not a readable Office package \u2014 ${directory.error}.`);
  const relsEntry = directory.value.find((entry) => entry.name === RELATIONSHIPS_PART);
  if (!relsEntry) {
    return fail(
      "malformed-archive",
      `Office package has no '${RELATIONSHIPS_PART}' part, so its main document cannot be located. Parts found: ${directory.value.map((e) => e.name).slice(0, 12).join(", ") || "none"}.`
    );
  }
  const relsBytes = await readZipEntry(bytes, relsEntry, zip);
  if (!relsBytes.succeeded) return fail("malformed-archive", `Could not read '${RELATIONSHIPS_PART}' \u2014 ${relsBytes.error}.`);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const partName = relationshipTarget(decoder.decode(relsBytes.value));
  if (partName === null) {
    return fail("malformed-archive", `Office package declares no officeDocument relationship in '${RELATIONSHIPS_PART}'.`);
  }
  const documentEntry = directory.value.find((entry) => entry.name === partName);
  if (!documentEntry) {
    return fail("malformed-archive", `Office package points at '${partName}' as its main document, but no such part exists in the archive.`);
  }
  const documentBytes = await readZipEntry(bytes, documentEntry, zip);
  if (!documentBytes.succeeded) return fail("malformed-archive", `Could not read '${partName}' \u2014 ${documentBytes.error}.`);
  const strict = new TextDecoder("utf-8", { fatal: true });
  let xml;
  try {
    xml = strict.decode(documentBytes.value);
  } catch (error2) {
    return fail("extraction-failed", `'${partName}' is not valid UTF-8 \u2014 ${error2 instanceof Error ? error2.message : String(error2)}.`);
  }
  const walked = wordprocessingXmlToText(xml);
  return {
    succeeded: true,
    value: { text: walked.text, detail: { part: partName, paragraphCount: walked.paragraphCount } }
  };
}

// src/documents/media-type.ts
var DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
var DOCM_MEDIA_TYPE = "application/vnd.ms-word.document.macroEnabled.12";
var PDF_MEDIA_TYPE = "application/pdf";
var LEGACY_DOC_MEDIA_TYPES = /* @__PURE__ */ new Set(["application/msword", "application/vnd.ms-word"]);
var DOCX_MEDIA_TYPES = /* @__PURE__ */ new Map([
  [DOCX_MEDIA_TYPE.toLowerCase(), DOCX_MEDIA_TYPE],
  [DOCM_MEDIA_TYPE.toLowerCase(), DOCM_MEDIA_TYPE]
]);
var EXTENSION_MEDIA_TYPES = {
  pdf: PDF_MEDIA_TYPE,
  docx: DOCX_MEDIA_TYPE,
  docm: DOCM_MEDIA_TYPE,
  doc: "application/msword",
  txt: "text/plain",
  text: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv"
};
var UNDECLARED = /* @__PURE__ */ new Set(["", "application/octet-stream", "binary/octet-stream"]);
function normalizeMediaType(mediaType) {
  const base = mediaType.split(";", 1)[0] ?? "";
  return base.trim().toLowerCase();
}
function extensionOf(filename) {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}
function resolveMediaType(input) {
  const declared = normalizeMediaType(input.mediaType ?? "");
  const fromExtension = input.filename ? EXTENSION_MEDIA_TYPES[extensionOf(input.filename)] : void 0;
  const effective = (UNDECLARED.has(declared) ? fromExtension ?? declared : declared).toLowerCase();
  const fail = (message) => ({
    succeeded: false,
    error: { code: "unsupported-media-type", stage: "media-type", message, mediaType: declared || (fromExtension ?? "") }
  });
  if (effective === PDF_MEDIA_TYPE) return { succeeded: true, value: { format: "pdf", mediaType: PDF_MEDIA_TYPE } };
  const docx = DOCX_MEDIA_TYPES.get(effective);
  if (docx) return { succeeded: true, value: { format: "docx", mediaType: docx } };
  if (LEGACY_DOC_MEDIA_TYPES.has(effective)) {
    return fail(
      `Legacy binary Word documents (${effective}) are not supported \u2014 they are OLE2 compound files, not OOXML packages. Save the file as .docx and upload it again.`
    );
  }
  if (effective.startsWith("text/")) return { succeeded: true, value: { format: "text", mediaType: effective } };
  if (effective === "") {
    return fail(
      `Cannot determine the document type: no media type was declared${input.filename ? ` and '${input.filename}' has no recognized extension` : " and no filename was supplied"}. Supported: ${PDF_MEDIA_TYPE}, ${DOCX_MEDIA_TYPE}, and any text/* type.`
    );
  }
  return fail(
    `Unsupported media type '${effective}'. Supported: ${PDF_MEDIA_TYPE}, ${DOCX_MEDIA_TYPE}, ${DOCM_MEDIA_TYPE}, and any text/* type.`
  );
}

// src/documents/extract.ts
var DEFAULT_MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
function error(code, stage, message, mediaType, classification) {
  return { succeeded: false, error: { code, stage, message, mediaType, ...classification ? { classification } : {} } };
}
function describe(filename) {
  return filename ? `'${filename}'` : "the document";
}
function pageList(pages) {
  return pages.length > 8 ? `${pages.slice(0, 8).join(", ")}, \u2026 (${pages.length} total)` : pages.join(", ");
}
function classifyPdfDocument(bytes, pdf) {
  return pdf.classify(bytes);
}
async function extractPdf(bytes, options, mediaType) {
  const pdf = options.pdf;
  if (!pdf) {
    return error(
      "pdf-engine-unavailable",
      "classify",
      `PDF extraction needs a PDF engine, and none was configured. Pass \`pdf\` \u2014 see @tangle-network/agent-app/documents/pdf-inspector for the wasm-backed engine and how to deliver its .wasm asset.`,
      mediaType
    );
  }
  const classified = pdf.classify(bytes);
  if (!classified.succeeded) return classified;
  const classification = classified.value;
  if (classification.needsOcr) {
    const label = classification.kind === "image-based" ? "image-based" : "a scan";
    return error(
      "pdf-needs-ocr",
      "classify",
      `${describe(options.filename)} is ${label} with no text layer on any of its ${classification.pageCount} page${classification.pageCount === 1 ? "" : "s"} \u2014 OCR is required before its text can be read.`,
      mediaType,
      classification
    );
  }
  const warnings = [];
  const requested = options.preferredPdfFormat ?? "text";
  const textFormat = classification.partiallyScanned ? "markdown" : requested;
  if (classification.partiallyScanned) {
    const one = classification.pagesNeedingOcr.length === 1;
    warnings.push(
      `Page${one ? "" : "s"} ${pageList(classification.pagesNeedingOcr)} of ${classification.pageCount} ${one ? "has" : "have"} no text layer and need${one ? "s" : ""} OCR; the text below comes from the remaining pages.`
    );
    if (requested === "text") {
      warnings.push("Text was extracted as markdown because the plain-text engine cannot read a partially scanned PDF.");
    }
  }
  if (classification.hasEncodingIssues) {
    warnings.push("The PDF has character-encoding problems; extracted text may contain garbled characters.");
  }
  const extracted = pdf.extract(bytes, textFormat);
  if (!extracted.succeeded) return extracted;
  return {
    succeeded: true,
    value: {
      text: extracted.value,
      detail: { classification, textFormat, partial: classification.partiallyScanned },
      warnings
    }
  };
}
async function extractDocument(input, options = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const declared = options.mediaType ?? "";
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  if (bytes.byteLength > maxBytes) {
    return error(
      "too-large",
      "size-check",
      `${describe(options.filename)} is ${bytes.byteLength} bytes, over the ${maxBytes}-byte limit.`,
      declared
    );
  }
  if (bytes.byteLength === 0) {
    return error("empty-document", "size-check", `${describe(options.filename)} is empty (0 bytes).`, declared);
  }
  const resolved = resolveMediaType({ mediaType: declared, filename: options.filename });
  if (!resolved.succeeded) return resolved;
  const { format, mediaType } = resolved.value;
  const warnings = [];
  let text;
  let pdf;
  let docx;
  if (format === "pdf") {
    const outcome = await extractPdf(bytes, options, mediaType);
    if (!outcome.succeeded) return outcome;
    text = outcome.value.text;
    pdf = outcome.value.detail;
    warnings.push(...outcome.value.warnings);
  } else if (format === "docx") {
    const outcome = await extractDocxText(bytes, mediaType, {
      maxUncompressedBytes: options.maxUncompressedPartBytes ?? DEFAULT_MAX_ZIP_ENTRY_BYTES
    });
    if (!outcome.succeeded) return outcome;
    text = outcome.value.text;
    docx = outcome.value.detail;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
      return error(
        "decode-failed",
        "decode",
        `${describe(options.filename)} is not valid UTF-8 text \u2014 ${cause instanceof Error ? cause.message : String(cause)}. Re-save it as UTF-8.`,
        mediaType
      );
    }
    if (text.charCodeAt(0) === 65279) text = text.slice(1);
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return error(
      "empty-document",
      format === "text" ? "decode" : "extract",
      `${describe(options.filename)} produced no text. The file parsed, but it contains nothing readable.`,
      mediaType,
      pdf?.classification
    );
  }
  return {
    succeeded: true,
    value: {
      text: trimmed,
      format,
      mediaType,
      byteSize: bytes.byteLength,
      characterCount: trimmed.length,
      ...pdf ? { pdf } : {},
      ...docx ? { docx } : {},
      warnings
    }
  };
}
function createDocumentExtractor(config = {}) {
  return {
    extract: (input, options) => extractDocument(input, { ...options, ...config }),
    classifyPdf: (input) => {
      if (!config.pdf) {
        return error(
          "pdf-engine-unavailable",
          "classify",
          "This extractor was created without a PDF engine, so PDFs cannot be classified. Pass `pdf` to createDocumentExtractor.",
          "application/pdf"
        );
      }
      return classifyPdfDocument(input instanceof Uint8Array ? input : new Uint8Array(input), config.pdf);
    }
  };
}
export {
  DEFAULT_MAX_DOCUMENT_BYTES,
  DEFAULT_MAX_ZIP_ENTRY_BYTES,
  DOCM_MEDIA_TYPE,
  DOCX_MEDIA_TYPE,
  PDF_MEDIA_TYPE,
  classifyPdfDocument,
  createDocumentExtractor,
  decodeXmlEntities,
  extractDocument,
  extractDocxText,
  normalizeMediaType,
  readZipDirectory,
  readZipEntry,
  resolveMediaType,
  wordprocessingXmlToText
};
//# sourceMappingURL=index.js.map