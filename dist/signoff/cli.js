#!/usr/bin/env node
import {
  formatSignoffLine,
  formatSignoffReport,
  runSignoff
} from "../chunk-35TMEOFA.js";
import {
  invokedAsScript
} from "../chunk-C3CAYGGQ.js";

// src/signoff/cli.ts
import { mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
function usage() {
  return [
    "Usage: agent-app-signoff [repoDir] [options]",
    "",
    "  --source head|working-tree  bytes to verify (default working-tree)",
    "  --config <path>             config module (default signoff.config.mjs)",
    "  --seed <n>                  base seed; reproduces a previous run",
    "  --shuffle-runs <n>          override every shuffled step's run count",
    "  --max-parallel <n>          cap concurrent steps",
    "  --cache-dir <path>          clean trees + pristine stores live here",
    "  --keep-going                run every step even after one fails",
    "  --keep-workspace            leave the clean tree on disk to inspect",
    "  --json <path>               write the machine-readable report",
    "  --quiet                     verdict only; no per-step progress"
  ].join("\n");
}
function fail(message) {
  process.stderr.write(`agent-app-signoff: ${message}

${usage()}
`);
  process.exit(2);
}
function positiveInt(raw, flag) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) fail(`${flag} needs a non-negative integer, got "${raw}"`);
  return value;
}
function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const take = () => {
      const value = argv[index + 1];
      if (value === void 0) fail(`${flag} needs a value`);
      index += 1;
      return value;
    };
    switch (flag) {
      case "--source": {
        const value = take();
        if (value !== "head" && value !== "working-tree") fail(`--source must be head or working-tree, got "${value}"`);
        parsed.source = value;
        break;
      }
      case "--config":
        parsed.configPath = take();
        break;
      case "--seed":
        parsed.seed = positiveInt(take(), "--seed");
        break;
      case "--shuffle-runs":
        parsed.shuffleRuns = positiveInt(take(), "--shuffle-runs");
        break;
      case "--max-parallel":
        parsed.maxParallel = positiveInt(take(), "--max-parallel");
        break;
      case "--cache-dir":
        parsed.cacheDir = take();
        break;
      case "--keep-going":
        parsed.keepGoing = true;
        break;
      case "--keep-workspace":
        parsed.keepWorkspace = true;
        break;
      case "--json":
        parsed.jsonPath = take();
        break;
      case "--quiet":
        parsed.quiet = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(`${usage()}
`);
        process.exit(0);
        break;
      default:
        if (flag.startsWith("-")) fail(`unknown option: ${flag}`);
        if (parsed.repoDir !== void 0) fail(`unexpected second directory: ${flag}`);
        parsed.repoDir = flag;
    }
  }
  return parsed;
}
function progressWriter() {
  return (event) => {
    switch (event.kind) {
      case "tree":
        process.stderr.write(`\xB7 clean tree at ${event.path} (${event.head.slice(0, 12)}${event.dirty ? " + working tree" : ""})
`);
        break;
      case "store":
        process.stderr.write(`\xB7 store ${event.cacheHit ? "warm" : "COLD"} ${event.cacheKey.slice(0, 16)}
`);
        break;
      case "install-start":
        process.stderr.write(`\xB7 ${event.command}
`);
        break;
      case "install-end":
        process.stderr.write(`\xB7 install exit ${event.exitCode} in ${event.durationMs}ms
`);
        break;
      case "step-start":
        process.stderr.write(`\xB7 start ${event.name}${event.seed === null ? "" : ` (seed ${event.seed})`}
`);
        break;
      case "step-end":
        process.stderr.write(`\xB7 ${event.status === "passed" ? "ok" : event.status} ${event.name} ${event.durationMs}ms
`);
        break;
    }
  };
}
async function runSignoffCli(argv) {
  const args = parseArgs(argv);
  const report = await runSignoff({ ...args, onEvent: args.quiet ? void 0 : progressWriter() });
  if (args.jsonPath !== void 0) {
    const abs = resolve(args.jsonPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(report, null, 2)}
`);
  }
  process.stdout.write(`${args.quiet ? formatSignoffLine(report) : formatSignoffReport(report)}
`);
  return report.ok ? 0 : 1;
}
if (invokedAsScript(import.meta.url, process.argv[1])) {
  runSignoffCli(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}
`);
    process.exit(2);
  });
}
export {
  parseArgs,
  runSignoffCli
};
//# sourceMappingURL=cli.js.map