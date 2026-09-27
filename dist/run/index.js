import {
  KNOWN_HARNESSES
} from "../chunk-MCYJON3F.js";

// src/run/index.ts
var ROUTER_HARNESS = "router";
function resolveExecutionMode(harness) {
  if (harness == null || harness === ROUTER_HARNESS) return "router";
  return "sandbox";
}
function isKnownSandboxHarness(harness) {
  return harness != null && harness !== ROUTER_HARNESS && KNOWN_HARNESSES.includes(harness);
}
function executionModeForProfile(profile) {
  return resolveExecutionMode(profile.harness);
}
async function* runAgent(harness, branches) {
  const mode = resolveExecutionMode(harness);
  const source = mode === "sandbox" ? branches.sandbox() : branches.router();
  const iterable = await source;
  for await (const event of iterable) yield event;
}
export {
  ROUTER_HARNESS,
  executionModeForProfile,
  isKnownSandboxHarness,
  resolveExecutionMode,
  runAgent
};
//# sourceMappingURL=index.js.map