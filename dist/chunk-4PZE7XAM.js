import {
  persistedPartToWorkProduct
} from "./chunk-ZVEEWGDK.js";
import {
  mentionKindForPath
} from "./chunk-X47R2IVO.js";
import {
  persistedPartToInteraction
} from "./chunk-M3K2HVQD.js";
import {
  persistedPartToPlan,
  planToPersistedPart
} from "./chunk-YJMCRXQQ.js";

// src/chat-store/parts.ts
function toChatMessageParts(parts) {
  const out = [];
  for (const part of parts) {
    const typed = toChatMessagePart(part);
    if (typed) out.push(typed);
  }
  return out;
}
var str = (value) => typeof value === "string";
function toChatMessagePart(part) {
  if (!part || typeof part !== "object") return null;
  const type = part.type;
  switch (type) {
    case "text":
    case "reasoning":
      return str(part.text) ? part : null;
    case "tool":
      return str(part.id) && str(part.tool) && part.state && typeof part.state === "object" ? part : null;
    case "file":
    case "image":
      return part;
    case "subtask":
      return str(part.prompt) && str(part.description) && str(part.agent) ? part : null;
    case "step-start":
      return { type: "step-start" };
    case "step-finish":
      return part;
    case "interaction":
      return persistedPartToInteraction(part) ? part : null;
    case "notice":
      return str(part.id) && str(part.noticeKind) && str(part.text) ? part : null;
    case "plan": {
      const plan = persistedPartToPlan(part);
      return plan ? { ...part, ...planToPersistedPart(plan) } : null;
    }
    case "work_product":
      return persistedPartToWorkProduct(part) ? part : null;
    case "mention":
      return isChatMentionPart(part) ? part : null;
    case void 0:
      return null;
    default: {
      const _exhaustive = type;
      void _exhaustive;
      return null;
    }
  }
}
function isChatToolPart(part) {
  return part.type === "tool";
}
function isChatTextPart(part) {
  return part.type === "text";
}
function isChatInteractionPart(part) {
  return part.type === "interaction";
}
function isChatPlanPart(part) {
  return part.type === "plan";
}
function isChatWorkProductPart(part) {
  return part.type === "work_product";
}
function isChatStepFinishPart(part) {
  return part.type === "step-finish";
}
function isChatMentionPart(part) {
  if (!part || typeof part !== "object") return false;
  const record = part;
  if (record.size !== void 0 && (typeof record.size !== "number" || !Number.isFinite(record.size))) {
    return false;
  }
  return record.type === "mention" && typeof record.path === "string" && record.path.length > 0 && typeof record.name === "string" && record.name.trim().length > 0 && (record.mentionKind === "image" || record.mentionKind === "file");
}
function mentionPartsFromMessageParts(parts) {
  if (!parts) return [];
  return parts.filter(isChatMentionPart);
}
function mentionInputToPart(input) {
  const part = {
    type: "mention",
    mentionKind: mentionKindForPath(input.path),
    path: input.path,
    name: input.name
  };
  if (typeof input.size === "number" && Number.isFinite(input.size)) part.size = input.size;
  return part;
}
function attachmentKindForMime(mime) {
  return mime?.startsWith("image/") ? "image" : "file";
}
function isChatAttachmentPart(part) {
  if (!part || typeof part !== "object") return false;
  const record = part;
  return (record.type === "image" || record.type === "file") && typeof record.path === "string" && record.path.length > 0;
}
function attachmentInputToPart(input) {
  const part = { type: input.kind, path: input.path, name: input.name };
  if (typeof input.size === "number" && Number.isFinite(input.size)) part.size = input.size;
  if (input.mediaType) part.mediaType = input.mediaType;
  return part;
}
function attachmentPartsFromMessageParts(parts) {
  if (!parts) return [];
  return parts.filter(isChatAttachmentPart);
}
var DEFAULT_ATTACHMENT_PROMPT_HEADER = "Attached files (already saved to the workspace vault \u2014 read them from these paths):";
var PROMPT_BLOCK_CONTROL_CHARS = /[\x00-\x1F\x7F]/g;
function buildAttachmentPromptBlock(atts, header = DEFAULT_ATTACHMENT_PROMPT_HEADER) {
  if (atts.length === 0) return "";
  const clean = (value) => value.replace(PROMPT_BLOCK_CONTROL_CHARS, " ");
  const lines = atts.map((a) => `- ${clean(a.name)} (vault: ${clean(a.path)})`);
  return `

${header}
${lines.join("\n")}`;
}
function historyContentWithAttachments(message, header) {
  const attachmentParts = attachmentPartsFromMessageParts(message.parts);
  if (attachmentParts.length === 0) return message.content;
  return `${message.content}${buildAttachmentPromptBlock(attachmentParts, header)}`;
}

export {
  toChatMessageParts,
  isChatToolPart,
  isChatTextPart,
  isChatInteractionPart,
  isChatPlanPart,
  isChatWorkProductPart,
  isChatStepFinishPart,
  isChatMentionPart,
  mentionPartsFromMessageParts,
  mentionInputToPart,
  attachmentKindForMime,
  isChatAttachmentPart,
  attachmentInputToPart,
  attachmentPartsFromMessageParts,
  DEFAULT_ATTACHMENT_PROMPT_HEADER,
  buildAttachmentPromptBlock,
  historyContentWithAttachments
};
//# sourceMappingURL=chunk-4PZE7XAM.js.map