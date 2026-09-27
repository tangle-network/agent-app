#!/usr/bin/env node
import {
  formatPreflightReport,
  runPreflight
} from "../chunk-XDB7IBYE.js";
import "../chunk-COP2K4LF.js";
import {
  invokedAsScript
} from "../chunk-C3CAYGGQ.js";

// src/preflight/cli.ts
import { pathToFileURL } from "url";
import { resolve } from "path";
import { existsSync } from "fs";
var DEFAULT_CONFIG = "preflight.config.mjs";
async function loadProbes(configPath) {
  const abs = resolve(process.cwd(), configPath);
  if (!existsSync(abs)) {
    throw new Error(
      `agent-app-preflight: no config at "${abs}". Create one that default-exports a PreflightProbe[], or pass a path.`
    );
  }
  const mod = await import(pathToFileURL(abs).href);
  const probes = mod.default;
  if (!Array.isArray(probes)) {
    throw new Error(
      `agent-app-preflight: "${abs}" must default-export an array of probes; got ${typeof probes}.`
    );
  }
  if (probes.length === 0) {
    throw new Error(`agent-app-preflight: "${abs}" exported an empty probe list \u2014 nothing would be verified.`);
  }
  return probes;
}
async function runPreflightCli(argv) {
  const probes = await loadProbes(argv[0] ?? DEFAULT_CONFIG);
  const report = await runPreflight(probes);
  console.log(formatPreflightReport(report));
  return report.ok ? 0 : 1;
}
if (invokedAsScript(import.meta.url, process.argv[1])) {
  runPreflightCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
export {
  loadProbes,
  runPreflightCli
};
//# sourceMappingURL=cli.js.map