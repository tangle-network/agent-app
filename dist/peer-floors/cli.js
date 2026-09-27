#!/usr/bin/env node
import {
  invokedAsScript
} from "../chunk-C3CAYGGQ.js";
import {
  checkAllPeerFloors,
  checkDependencySources,
  formatDependencySourceReport,
  formatPeerFloorReport
} from "../chunk-BOQ4HVVH.js";

// src/peer-floors/cli.ts
function parsePeerCheckArgs(argv) {
  const exclude = [];
  let appDir;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--exclude") {
      const value = argv[i + 1];
      if (value) exclude.push(value);
      i += 1;
    } else if (arg.startsWith("--exclude=")) {
      exclude.push(arg.slice("--exclude=".length));
    } else if (!arg.startsWith("-") && appDir === void 0) {
      appDir = arg;
    }
  }
  return { appDir: appDir ?? process.cwd(), exclude };
}
function main() {
  const { appDir, exclude } = parsePeerCheckArgs(process.argv.slice(2));
  let failed = false;
  try {
    const sources = checkDependencySources({ repoDir: appDir, exclude });
    process.stdout.write(`${formatDependencySourceReport(sources)}

`);
    if (!sources.ok) failed = true;
  } catch (err) {
    process.stderr.write(`agent-app-peer-check (dependency sources) failed: ${err instanceof Error ? err.message : String(err)}
`);
    failed = true;
  }
  try {
    const reports = checkAllPeerFloors({ appDir });
    process.stdout.write(`${reports.map((report) => formatPeerFloorReport(report)).join("\n\n")}
`);
    if (reports.some((report) => !report.ok)) failed = true;
  } catch (err) {
    process.stderr.write(`agent-app-peer-check (peer floors) failed: ${err instanceof Error ? err.message : String(err)}
`);
    failed = true;
  }
  process.exit(failed ? 1 : 0);
}
if (invokedAsScript(import.meta.url, process.argv[1])) main();
export {
  parsePeerCheckArgs
};
//# sourceMappingURL=cli.js.map