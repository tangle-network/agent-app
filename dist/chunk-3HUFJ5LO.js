// src/web-react/mention-pill.ts
var MENTION_PILL_CLASS = "rounded-md bg-primary/10 px-1 py-0.5 font-medium text-primary";

// src/web-react/mention-boundaries.ts
var PATH_CONTINUATION_CHAR = /[\p{L}\p{M}\p{N}._\-/]/u;
var WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
function charBefore(text, index) {
  if (index <= 0) return void 0;
  return Array.from(text.slice(Math.max(0, index - 2), index)).pop();
}
function charAt(text, index) {
  if (index >= text.length) return void 0;
  const codePoint = text.codePointAt(index);
  return codePoint === void 0 ? void 0 : String.fromCodePoint(codePoint);
}

export {
  MENTION_PILL_CLASS,
  PATH_CONTINUATION_CHAR,
  WORD_CHAR,
  charBefore,
  charAt
};
//# sourceMappingURL=chunk-3HUFJ5LO.js.map