import {
  formatBytes
} from "./chunk-X47R2IVO.js";

// src/chat-routes/binary-sniff.ts
var OOXML_WORD_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
var OOXML_SPREADSHEET_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
var OOXML_PRESENTATION_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
var OOXML_WORD_MACRO_ENABLED_MIME = "application/vnd.ms-word.document.macroEnabled.12";
var OOXML_SPREADSHEET_MACRO_ENABLED_MIME = "application/vnd.ms-excel.sheet.macroEnabled.12";
var OOXML_PRESENTATION_MACRO_ENABLED_MIME = "application/vnd.ms-powerpoint.presentation.macroEnabled.12";
function bytesStartWith(bytes, offset, signature) {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}
function asciiAt(bytes, offset, text) {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}
function sniffRiff(bytes) {
  if (!asciiAt(bytes, 0, "RIFF")) return null;
  if (asciiAt(bytes, 8, "WEBP")) return "image/webp";
  if (asciiAt(bytes, 8, "WAVE")) return "audio/wav";
  return null;
}
function sniffFtyp(bytes) {
  if (!asciiAt(bytes, 4, "ftyp")) return null;
  if (asciiAt(bytes, 8, "qt  ")) return "video/quicktime";
  if (asciiAt(bytes, 8, "avif") || asciiAt(bytes, 8, "avis")) return "image/avif";
  if (asciiAt(bytes, 8, "heic") || asciiAt(bytes, 8, "heix") || asciiAt(bytes, 8, "hevc") || asciiAt(bytes, 8, "hevx")) return "image/heic";
  if (asciiAt(bytes, 8, "mif1") || asciiAt(bytes, 8, "msf1")) return "image/heif";
  return "video/mp4";
}
var EBML_HEADER_ID = 440786851;
var EBML_DOC_TYPE_ID = 17026;
var EBML_HEADER_SCAN_BYTES = 4 * 1024;
function readEbmlVint(bytes, offset, maxLength, stripMarker) {
  const first = bytes[offset];
  if (first === void 0 || first === 0) return null;
  let marker = 128;
  let length = 1;
  while ((first & marker) === 0) {
    marker >>= 1;
    length++;
  }
  if (length > maxLength || offset + length > bytes.length) return null;
  if (stripMarker) {
    let unknown = (first & marker - 1) === marker - 1;
    for (let index = 1; index < length; index++) unknown &&= bytes[offset + index] === 255;
    if (unknown) return null;
  }
  let value = stripMarker ? first & marker - 1 : first;
  for (let index = 1; index < length; index++) {
    value = value * 256 + bytes[offset + index];
    if (!Number.isSafeInteger(value)) return null;
  }
  return { length, value };
}
function sniffEbml(bytes) {
  const headerId = readEbmlVint(bytes, 0, 4, false);
  if (headerId?.value !== EBML_HEADER_ID) return null;
  const headerSize = readEbmlVint(bytes, headerId.length, 8, true);
  if (!headerSize) return null;
  const headerStart = headerId.length + headerSize.length;
  const headerEnd = headerStart + headerSize.value;
  if (!Number.isSafeInteger(headerEnd) || headerEnd > bytes.length) return null;
  const scanEnd = Math.min(headerEnd, headerStart + EBML_HEADER_SCAN_BYTES);
  let cursor = headerStart;
  while (cursor < scanEnd) {
    const id = readEbmlVint(bytes, cursor, 4, false);
    if (!id) return null;
    const size = readEbmlVint(bytes, cursor + id.length, 8, true);
    if (!size) return null;
    const valueStart = cursor + id.length + size.length;
    const valueEnd = valueStart + size.value;
    if (!Number.isSafeInteger(valueEnd) || valueEnd > headerEnd || valueEnd > scanEnd) return null;
    if (id.value === EBML_DOC_TYPE_ID) {
      let docType = "";
      for (let index = valueStart; index < valueEnd; index++) {
        const byte = bytes[index];
        if (byte > 127) return null;
        docType += String.fromCharCode(byte);
      }
      if (docType === "webm") return "video/webm";
      if (docType === "matroska") return "video/x-matroska";
      return null;
    }
    cursor = valueEnd;
  }
  return null;
}
function sniffBmp(bytes) {
  return asciiAt(bytes, 0, "BM") && bytes.length >= 10 && bytes[6] === 0 && bytes[7] === 0 && bytes[8] === 0 && bytes[9] === 0;
}
function sniffId3(bytes) {
  return asciiAt(bytes, 0, "ID3") && bytes.length >= 10 && bytes[3] < 16 && bytes[6] < 128 && bytes[7] < 128 && bytes[8] < 128 && bytes[9] < 128;
}
var ZIP_LOCAL_FILE_HEADER_SIGNATURE = 67324752;
var ZIP_CENTRAL_FILE_HEADER_SIGNATURE = 33639248;
var ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 101010256;
var ZIP_END_OF_CENTRAL_DIRECTORY_BYTES = 22;
var ZIP_CENTRAL_FILE_HEADER_BYTES = 46;
var ZIP_LOCAL_FILE_HEADER_BYTES = 30;
var ZIP_MAX_COMMENT_BYTES = 65535;
var ZIP64_SENTINEL_U16 = 65535;
var ZIP64_SENTINEL_U32 = 4294967295;
var ZIP_METHOD_STORED = 0;
var OPC_CONTENT_TYPES_PART = "[Content_Types].xml";
var OPC_PACKAGE_RELATIONSHIPS_PART = "_rels/.rels";
var OPC_CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
var OPC_CONTENT_TYPES_SCAN_BYTES = 64 * 1024;
var OOXML_DECLARED_MAIN_PART_TYPES = [
  {
    declaredType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    mime: OOXML_WORD_MIME,
    macroEnabledMime: OOXML_WORD_MACRO_ENABLED_MIME,
    macroEnabled: false
  },
  {
    declaredType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    mime: OOXML_SPREADSHEET_MIME,
    macroEnabledMime: OOXML_SPREADSHEET_MACRO_ENABLED_MIME,
    macroEnabled: false
  },
  {
    declaredType: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    mime: OOXML_PRESENTATION_MIME,
    macroEnabledMime: OOXML_PRESENTATION_MACRO_ENABLED_MIME,
    macroEnabled: false
  },
  {
    declaredType: "application/vnd.ms-word.document.macroEnabled.main+xml",
    mime: OOXML_WORD_MACRO_ENABLED_MIME,
    macroEnabledMime: OOXML_WORD_MACRO_ENABLED_MIME,
    macroEnabled: true
  },
  {
    declaredType: "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
    mime: OOXML_SPREADSHEET_MACRO_ENABLED_MIME,
    macroEnabledMime: OOXML_SPREADSHEET_MACRO_ENABLED_MIME,
    macroEnabled: true
  },
  {
    declaredType: "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
    mime: OOXML_PRESENTATION_MACRO_ENABLED_MIME,
    macroEnabledMime: OOXML_PRESENTATION_MACRO_ENABLED_MIME,
    macroEnabled: true
  }
];
var OOXML_MAIN_PARTS = [
  { part: "word/document.xml", directory: "word/", mime: OOXML_WORD_MIME, macroEnabledMime: OOXML_WORD_MACRO_ENABLED_MIME },
  { part: "xl/workbook.xml", directory: "xl/", mime: OOXML_SPREADSHEET_MIME, macroEnabledMime: OOXML_SPREADSHEET_MACRO_ENABLED_MIME },
  { part: "ppt/presentation.xml", directory: "ppt/", mime: OOXML_PRESENTATION_MIME, macroEnabledMime: OOXML_PRESENTATION_MACRO_ENABLED_MIME }
];
var OOXML_VBA_PROJECT_PART_SUFFIX = "vbaProject.bin";
function readU16Le(bytes, offset) {
  return bytes[offset] | bytes[offset + 1] << 8;
}
function readU32Le(bytes, offset) {
  return (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16) + bytes[offset + 3] * 16777216;
}
function asciiEntryName(bytes, offset, length) {
  let name = "";
  for (let i = 0; i < length; i++) {
    const byte = bytes[offset + i];
    name += byte < 128 ? String.fromCharCode(byte) : "\uFFFD";
  }
  return name;
}
function findZipEndOfCentralDirectory(bytes) {
  const lowest = Math.max(0, bytes.length - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES - ZIP_MAX_COMMENT_BYTES);
  for (let offset = bytes.length - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES; offset >= lowest; offset--) {
    if (readU32Le(bytes, offset) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    if (offset + ZIP_END_OF_CENTRAL_DIRECTORY_BYTES + readU16Le(bytes, offset + 20) === bytes.length) return offset;
  }
  return null;
}
function readZipCentralDirectory(bytes) {
  const end = findZipEndOfCentralDirectory(bytes);
  if (end === null) return null;
  const entryCount = readU16Le(bytes, end + 10);
  const directoryBytes = readU32Le(bytes, end + 12);
  const directoryOffset = readU32Le(bytes, end + 16);
  if (entryCount === ZIP64_SENTINEL_U16) return null;
  if (directoryBytes === ZIP64_SENTINEL_U32 || directoryOffset === ZIP64_SENTINEL_U32) return null;
  if (directoryOffset + directoryBytes > bytes.length) return null;
  const entries = [];
  let cursor = directoryOffset;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + ZIP_CENTRAL_FILE_HEADER_BYTES > bytes.length) return null;
    if (readU32Le(bytes, cursor) !== ZIP_CENTRAL_FILE_HEADER_SIGNATURE) return null;
    const nameLength = readU16Le(bytes, cursor + 28);
    const extraLength = readU16Le(bytes, cursor + 30);
    const commentLength = readU16Le(bytes, cursor + 32);
    if (cursor + ZIP_CENTRAL_FILE_HEADER_BYTES + nameLength > bytes.length) return null;
    entries.push({
      name: asciiEntryName(bytes, cursor + ZIP_CENTRAL_FILE_HEADER_BYTES, nameLength),
      compressionMethod: readU16Le(bytes, cursor + 10),
      compressedBytes: readU32Le(bytes, cursor + 20),
      localHeaderOffset: readU32Le(bytes, cursor + 42)
    });
    cursor += ZIP_CENTRAL_FILE_HEADER_BYTES + nameLength + extraLength + commentLength;
  }
  return entries;
}
function storedZipEntryText(bytes, entry) {
  if (entry.compressionMethod !== ZIP_METHOD_STORED) return null;
  const header = entry.localHeaderOffset;
  if (header + ZIP_LOCAL_FILE_HEADER_BYTES > bytes.length) return null;
  if (readU32Le(bytes, header) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) return null;
  const start = header + ZIP_LOCAL_FILE_HEADER_BYTES + readU16Le(bytes, header + 26) + readU16Le(bytes, header + 28);
  const length = Math.min(entry.compressedBytes, OPC_CONTENT_TYPES_SCAN_BYTES);
  if (length === 0 || start + length > bytes.length) return null;
  return new TextDecoder("utf-8").decode(bytes.subarray(start, start + length));
}
function sniffOoxml(bytes) {
  const entries = readZipCentralDirectory(bytes);
  if (!entries) return null;
  const contentTypes = entries.find((entry) => entry.name === OPC_CONTENT_TYPES_PART);
  if (!contentTypes) return null;
  const names = entries.map((entry) => entry.name);
  if (!names.includes(OPC_PACKAGE_RELATIONSHIPS_PART)) return null;
  const macroEnabled = names.some((name) => name.endsWith(OOXML_VBA_PROJECT_PART_SUFFIX));
  const declared = storedZipEntryText(bytes, contentTypes);
  if (declared !== null) {
    if (!declared.includes(OPC_CONTENT_TYPES_NAMESPACE)) return null;
    const matches = OOXML_DECLARED_MAIN_PART_TYPES.filter((row2) => declared.includes(row2.declaredType));
    const row = matches.find((candidate) => candidate.macroEnabled) ?? matches[0];
    if (row) return macroEnabled || row.macroEnabled ? row.macroEnabledMime : row.mime;
  }
  const canonical = OOXML_MAIN_PARTS.find((main) => names.includes(main.part));
  const format = canonical ?? OOXML_MAIN_PARTS.find((main) => names.some((name) => name.startsWith(main.directory)));
  if (!format) return null;
  return macroEnabled ? format.macroEnabledMime : format.mime;
}
function sniffMagicBytes(bytes) {
  if (bytesStartWith(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (bytesStartWith(bytes, 0, [255, 216, 255])) return "image/jpeg";
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) return "image/gif";
  if (sniffBmp(bytes)) return "image/bmp";
  if (bytesStartWith(bytes, 0, [73, 73, 42, 0])) return "image/tiff";
  if (bytesStartWith(bytes, 0, [77, 77, 0, 42])) return "image/tiff";
  if (bytesStartWith(bytes, 0, [0, 0, 1, 0])) return "image/x-icon";
  if (asciiAt(bytes, 0, "%PDF-")) return "application/pdf";
  if (bytesStartWith(bytes, 0, [80, 75, 3, 4])) return sniffOoxml(bytes) ?? "application/zip";
  if (bytesStartWith(bytes, 0, [31, 139])) return "application/gzip";
  if (sniffId3(bytes) || bytesStartWith(bytes, 0, [255, 251])) return "audio/mpeg";
  if (asciiAt(bytes, 0, "OggS")) return "audio/ogg";
  const ebml = sniffEbml(bytes);
  if (ebml) return ebml;
  const riff = sniffRiff(bytes);
  if (riff) return riff;
  const ftyp = sniffFtyp(bytes);
  if (ftyp) return ftyp;
  return null;
}
function sniffSvgText(decoded) {
  let text = decoded;
  if (text.charCodeAt(0) === 65279) text = text.slice(1);
  text = text.trimStart();
  if (/^<svg[\s>/]/.test(text)) return true;
  if (!text.startsWith("<?xml")) return false;
  return /<svg[\s>/]/.test(text.slice(0, 1024));
}
function sniffBinary(bytes) {
  const mime = sniffMagicBytes(bytes);
  if (mime) return { binary: true, mime };
  if (bytes.includes(0)) return { binary: true, mime: null };
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { binary: true, mime: null };
  }
  if (sniffSvgText(decoded)) return { binary: true, mime: "image/svg+xml" };
  return { binary: false, mime: null };
}

// src/chat-routes/attachment-validation.ts
var MAX_BINARY_ATTACHMENT_BYTES = 10 * 1024 * 1024;
var MAX_TEXT_ATTACHMENT_BYTES = 950 * 1024;
var ATTACHMENT_MAX_COUNT = 10;
var MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;
var ATTACHMENT_ACCEPT = "image/*,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.yaml,.yml,.html";
var OOXML_SNIFFED_MIMES = /* @__PURE__ */ new Set([
  OOXML_WORD_MIME,
  OOXML_SPREADSHEET_MIME,
  OOXML_PRESENTATION_MIME
]);
var MACRO_ENABLED_OOXML_SNIFFED_MIMES = /* @__PURE__ */ new Set([
  OOXML_WORD_MACRO_ENABLED_MIME,
  OOXML_SPREADSHEET_MACRO_ENABLED_MIME,
  OOXML_PRESENTATION_MACRO_ENABLED_MIME
]);
var ALLOWED_ATTACHMENT_SNIFFED_MIMES = /* @__PURE__ */ new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/x-icon",
  "image/webp",
  "image/svg+xml",
  "image/avif",
  "image/heic",
  "image/heif",
  "application/pdf",
  ...OOXML_SNIFFED_MIMES
]);
var EXTENSION_IMPLIES_SNIFFED_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  ico: "image/x-icon",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  docx: OOXML_WORD_MIME,
  xlsx: OOXML_SPREADSHEET_MIME,
  pptx: OOXML_PRESENTATION_MIME,
  docm: OOXML_WORD_MACRO_ENABLED_MIME,
  xlsm: OOXML_SPREADSHEET_MACRO_ENABLED_MIME,
  pptm: OOXML_PRESENTATION_MACRO_ENABLED_MIME,
  webm: "video/webm",
  mkv: "video/x-matroska"
};
function checkAttachmentType(fileName, sniff, allowed = ALLOWED_ATTACHMENT_SNIFFED_MIMES) {
  if (sniff.binary === false) return { succeeded: true };
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  const impliedMime = EXTENSION_IMPLIES_SNIFFED_MIME[extension];
  if (impliedMime && sniff.mime && sniff.mime !== impliedMime) {
    return {
      succeeded: false,
      code: "attachment_type_mismatch",
      message: `${fileName} has a .${extension} extension, but its content is ${sniff.mime}`
    };
  }
  if (!sniff.mime || !allowed.has(sniff.mime)) {
    return {
      succeeded: false,
      code: "attachment_type_not_allowed",
      message: sniff.mime ? `${fileName}'s content (${sniff.mime}) is not an allowed attachment type` : `${fileName}'s content is not a recognized attachment type`
    };
  }
  return { succeeded: true };
}
function sanitizeAttachmentFileName(name) {
  const sanitized = name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  return sanitized || "file";
}
function attachmentSizeErrorMessage(name, actualBytes, limitBytes) {
  return `${name} is ${formatBytes(actualBytes)}; attachments are limited to ${formatBytes(limitBytes)}`;
}
function attachmentTotalSizeErrorMessage(totalBytes, limitBytes) {
  return `Attachments total ${formatBytes(totalBytes)}; each message is limited to ${formatBytes(limitBytes)}`;
}

export {
  OOXML_WORD_MIME,
  OOXML_SPREADSHEET_MIME,
  OOXML_PRESENTATION_MIME,
  OOXML_WORD_MACRO_ENABLED_MIME,
  OOXML_SPREADSHEET_MACRO_ENABLED_MIME,
  OOXML_PRESENTATION_MACRO_ENABLED_MIME,
  sniffBinary,
  MAX_BINARY_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  ATTACHMENT_MAX_COUNT,
  MAX_ATTACHMENT_TOTAL_BYTES,
  ATTACHMENT_ACCEPT,
  OOXML_SNIFFED_MIMES,
  MACRO_ENABLED_OOXML_SNIFFED_MIMES,
  ALLOWED_ATTACHMENT_SNIFFED_MIMES,
  checkAttachmentType,
  sanitizeAttachmentFileName,
  attachmentSizeErrorMessage,
  attachmentTotalSizeErrorMessage
};
//# sourceMappingURL=chunk-NU7QSZBR.js.map