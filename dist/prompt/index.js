// src/prompt/index.ts
function isBlank(value) {
  return value.trim().length === 0;
}
function assembleSystemPrompt(input) {
  const { base, directive = "", sections = [], trim = false } = input;
  if (isBlank(base)) {
    return {
      succeeded: false,
      error: "assembleSystemPrompt: base is empty \u2014 a system prompt with no persona/base block is a defect, not a default"
    };
  }
  let prompt = directive.length > 0 ? `${base}

${directive}` : base;
  for (const section of sections) prompt += section;
  return { succeeded: true, prompt: trim ? prompt.trim() : prompt };
}
export {
  assembleSystemPrompt
};
//# sourceMappingURL=index.js.map