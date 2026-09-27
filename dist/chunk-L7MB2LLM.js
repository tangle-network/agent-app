// src/web-react/class-names.ts
function joinClasses(...parts) {
  const kept = [];
  for (const part of parts) {
    if (typeof part !== "string") continue;
    const trimmed = part.trim();
    if (trimmed.length > 0) kept.push(trimmed);
  }
  return kept.join(" ");
}

export {
  joinClasses
};
//# sourceMappingURL=chunk-L7MB2LLM.js.map