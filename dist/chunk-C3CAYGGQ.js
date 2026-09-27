// src/signoff/invoked-as-script.ts
import { realpathSync } from "fs";
import { pathToFileURL } from "url";
function invokedAsScript(moduleUrl, entry) {
  if (entry === void 0 || entry.length === 0) return false;
  let resolved;
  try {
    resolved = realpathSync(entry);
  } catch {
    return false;
  }
  return moduleUrl === pathToFileURL(resolved).href;
}

export {
  invokedAsScript
};
//# sourceMappingURL=chunk-C3CAYGGQ.js.map