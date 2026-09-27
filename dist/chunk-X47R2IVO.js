import {
  isWorkspaceFileExportable
} from "./chunk-TXD5HXLE.js";

// src/chat-routes/wire.ts
function chatTurnRequestInit(payload) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}
var INLINE_PARTS_MAX_BYTES = 95e4;
var DISPATCH_REQUEST_MAX_BYTES = 1024 * 1024;
var DISPATCH_STRUCTURAL_RESERVE_BYTES = 64 * 1024;
var DISPATCH_MAX_PARTS = 64;
var DISPATCH_MAX_MEDIA_PARTS = 24;
function base64WireLen(byteLen) {
  return Math.ceil(byteLen / 3) * 4;
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes >= 1024 * 1024) {
    const megabytes = Math.floor(bytes / (1024 * 1024));
    const remainder = bytes % (1024 * 1024);
    return remainder === 0 ? `${megabytes}MB` : `${megabytes}MB ${formatBytes(remainder)}`;
  }
  return `${Math.round(bytes / 1024)}KB`;
}
var ChatTurnInputError = class extends Error {
  constructor(message, status = 400, code = "INVALID_CHAT_TURN") {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "ChatTurnInputError";
  }
  status;
  code;
};
function partByteSize(part) {
  let bytes = 0;
  if (part.type === "text") return part.text.length;
  if (part.url) bytes += part.url.length;
  if (part.path) bytes += part.path.length;
  return bytes;
}
function promptPartsByteSize(parts) {
  return parts.reduce((total, part) => total + partByteSize(part), 0);
}
function assertPromptPartsWithinCap(parts, maxBytes = INLINE_PARTS_MAX_BYTES) {
  const total = promptPartsByteSize(parts);
  if (total <= maxBytes) return;
  const largest = [...parts].sort((a, b) => partByteSize(b) - partByteSize(a))[0];
  const largestName = largest && largest.type !== "text" ? largest.filename ?? largest.path ?? largest.type : "text";
  throw new ChatTurnInputError(
    `Inline prompt parts total ${total}B, over the ${maxBytes}B budget (largest: ${largestName}, ${largest ? partByteSize(largest) : 0}B). Upload large files through the upload route so they travel as sandbox path references.`,
    413,
    "PROMPT_PARTS_TOO_LARGE"
  );
}
var MENTION_IMAGE_MEDIA_TYPES = /* @__PURE__ */ new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".bmp", "image/bmp"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".avif", "image/avif"]
]);
function extensionOf(path) {
  const base = path.split("/").filter(Boolean).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}
function mediaTypeForMentionPath(path) {
  return MENTION_IMAGE_MEDIA_TYPES.get(extensionOf(path));
}
function mentionKindForPath(path) {
  return mediaTypeForMentionPath(path) ? "image" : "file";
}
function fileMentionsToParts(mentions, opts = {}) {
  const resolvePath = opts.resolvePath ?? ((path) => path);
  return mentions.map((mention) => {
    const mediaType = mediaTypeForMentionPath(mention.path);
    const part = {
      type: mediaType ? "image" : "file",
      filename: mention.name,
      path: resolvePath(mention.path)
    };
    if (mediaType) part.mediaType = mediaType;
    return part;
  });
}
function buildMentionPromptBlock(mentions) {
  if (mentions.length === 0) return "";
  const lines = mentions.map((m) => `- ${m.name} (${m.path})`);
  return `

Mentioned files \u2014 read them from these paths:
${lines.join("\n")}`;
}
var MENTION_MAX_COUNT = 16;
var MAX_MENTION_NAME_LENGTH = 256;
var MAX_MENTION_PATH_LENGTH = 1024;
function validateSandboxMentionPath(path) {
  if (typeof path !== "string" || path.length === 0) {
    return { succeeded: false, error: "mention path must be a non-empty string" };
  }
  if (path.length > MAX_MENTION_PATH_LENGTH) {
    return { succeeded: false, error: `mention path must not exceed ${MAX_MENTION_PATH_LENGTH} characters` };
  }
  if (path.includes("\0")) {
    return { succeeded: false, error: "mention path must not contain null bytes" };
  }
  if (path.includes("\\")) {
    return { succeeded: false, error: "mention path must not contain backslashes" };
  }
  if (path.startsWith("/")) {
    return { succeeded: false, error: "mention path must be workspace-relative, not absolute" };
  }
  if (path.split("/").some((segment) => segment === "..")) {
    return { succeeded: false, error: 'mention path must not contain ".." segments' };
  }
  return { succeeded: true };
}
function parseFileMention(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatTurnInputError(`mentions[${index}] must be an object`);
  }
  const record = value;
  const pathCheck = validateSandboxMentionPath(record.path);
  if (!pathCheck.succeeded) throw new ChatTurnInputError(`mentions[${index}]: ${pathCheck.error}`);
  if (!isWorkspaceFileExportable(record.path)) {
    throw new ChatTurnInputError(`mentions[${index}]: file is not exportable`);
  }
  const name = record.name;
  if (typeof name !== "string" || !name.trim()) {
    throw new ChatTurnInputError(`mentions[${index}].name must be a non-empty string`);
  }
  if (name.length > MAX_MENTION_NAME_LENGTH) {
    throw new ChatTurnInputError(`mentions[${index}].name must not exceed ${MAX_MENTION_NAME_LENGTH} characters`);
  }
  const size = record.size;
  if (size !== void 0) {
    if (typeof size !== "number" || !Number.isFinite(size)) {
      throw new ChatTurnInputError(`mentions[${index}].size must be a finite number`);
    }
    if (size < 0) {
      throw new ChatTurnInputError(`mentions[${index}].size must not be negative`);
    }
  }
  return { path: record.path, name, ...typeof size === "number" ? { size } : {} };
}
function parseFileMentions(raw) {
  if (raw === void 0 || raw === null) return [];
  if (!Array.isArray(raw)) throw new ChatTurnInputError("mentions must be an array");
  if (raw.length > MENTION_MAX_COUNT) {
    throw new ChatTurnInputError(`mentions must not exceed ${MENTION_MAX_COUNT} entries`);
  }
  const mentions = [];
  const seenPaths = /* @__PURE__ */ new Set();
  for (let index = 0; index < raw.length; index += 1) {
    const mention = parseFileMention(raw[index], index);
    if (seenPaths.has(mention.path)) continue;
    seenPaths.add(mention.path);
    mentions.push(mention);
  }
  return mentions;
}
function parseChatTurnParts(raw) {
  if (raw === void 0 || raw === null) return [];
  if (!Array.isArray(raw)) throw new ChatTurnInputError("parts must be an array");
  return raw.map((entry, index) => {
    const part = entry;
    if (!part || typeof part !== "object") {
      throw new ChatTurnInputError(`parts[${index}] must be an object`);
    }
    if (part.type !== "image" && part.type !== "file") {
      throw new ChatTurnInputError(`parts[${index}].type must be 'image' or 'file'`);
    }
    for (const key of ["filename", "mediaType", "url", "path"]) {
      if (part[key] !== void 0 && typeof part[key] !== "string") {
        throw new ChatTurnInputError(`parts[${index}].${key} must be a string`);
      }
    }
    if (part.content !== void 0) {
      throw new ChatTurnInputError(`parts[${index}].content is not supported; provide a url or path`);
    }
    const url = typeof part.url === "string" && part.url.length > 0 ? part.url : void 0;
    const path = typeof part.path === "string" && part.path.length > 0 ? part.path : void 0;
    if (Boolean(url) === Boolean(path)) {
      throw new ChatTurnInputError(`parts[${index}] requires exactly one url or path`);
    }
    if (path && !path.startsWith("/")) {
      throw new ChatTurnInputError(`parts[${index}].path must be absolute`);
    }
    const filename = typeof part.filename === "string" ? part.filename.trim() : void 0;
    if (part.type === "file" && !filename) {
      throw new ChatTurnInputError(`parts[${index}].filename is required for file parts`);
    }
    return {
      type: part.type,
      ...filename ? { filename } : {},
      ...part.mediaType !== void 0 ? { mediaType: part.mediaType } : {},
      ...url ? { url } : { path }
    };
  });
}

export {
  chatTurnRequestInit,
  INLINE_PARTS_MAX_BYTES,
  DISPATCH_REQUEST_MAX_BYTES,
  DISPATCH_STRUCTURAL_RESERVE_BYTES,
  DISPATCH_MAX_PARTS,
  DISPATCH_MAX_MEDIA_PARTS,
  base64WireLen,
  formatBytes,
  ChatTurnInputError,
  promptPartsByteSize,
  assertPromptPartsWithinCap,
  mediaTypeForMentionPath,
  mentionKindForPath,
  fileMentionsToParts,
  buildMentionPromptBlock,
  MENTION_MAX_COUNT,
  validateSandboxMentionPath,
  parseFileMentions,
  parseChatTurnParts
};
//# sourceMappingURL=chunk-X47R2IVO.js.map