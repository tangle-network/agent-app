#!/usr/bin/env node
import {
  formatSpendReport,
  reconcileSpend,
  spendReportToJson
} from "../chunk-TRWJ5CRT.js";

// src/spend/cli-args.ts
import { pathToFileURL } from "url";
import { resolve } from "path";
var SpendUsageError = class extends Error {
};
var DEFAULT_CONFIG_FILE = "spend.config.mjs";
var USAGE = [
  "agent-app-spend-check \u2014 reconcile settled sandbox compute against what this product asked for.",
  "",
  "Usage: agent-app-spend-check [--config <file>] [--json] [--as-of <iso>] [--skip <check,check>]",
  "",
  `  --config <file>   Config module. Default ${DEFAULT_CONFIG_FILE}.`,
  "  --json            Emit the report as JSON instead of a table.",
  '  --as-of <iso>     Treat this instant as "now". Default: the current time.',
  "  --skip <checks>   Comma-separated check ids to leave out.",
  "",
  "The config module default-exports (or exports as `config`) the reconcile options,",
  "or a function returning them. It supplies the two things this package cannot:",
  "the product's own expectation store, and an authenticated fetch of its settled",
  "ledger rows. Scope that fetch to boxes this product owns.",
  "",
  "Exit 0 = clean, 1 = findings, 2 = usage or config error."
].join("\n");
function parseSpendArgs(argv) {
  let configFile = DEFAULT_CONFIG_FILE;
  let json = false;
  let asOf;
  let skip = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--config") {
      const value = argv[++i];
      if (!value) throw new SpendUsageError("--config needs a file path");
      configFile = value;
    } else if (arg === "--as-of") {
      const value = argv[++i];
      if (!value) throw new SpendUsageError("--as-of needs an ISO instant");
      const parsed = Date.parse(value);
      if (Number.isNaN(parsed)) throw new SpendUsageError(`--as-of is not a date: ${value}`);
      asOf = parsed;
    } else if (arg === "--skip") {
      const value = argv[++i];
      if (!value) throw new SpendUsageError("--skip needs a comma-separated list of check ids");
      skip = value.split(",").map((part) => part.trim()).filter(Boolean);
    } else if (arg === "--help" || arg === "-h") {
      throw new SpendUsageError("help");
    } else if (arg !== void 0) {
      throw new SpendUsageError(`unrecognized argument: ${arg}`);
    }
  }
  return { configFile, json, asOf, skip };
}
async function loadSpendConfig(configFile) {
  const resolved = resolve(process.cwd(), configFile);
  let module;
  try {
    module = await import(pathToFileURL(resolved).href);
  } catch (err) {
    throw new SpendUsageError(
      `could not load ${resolved}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const exported = module.default ?? module.config;
  const value = typeof exported === "function" ? await exported() : exported;
  if (!value || typeof value !== "object") {
    throw new SpendUsageError(`${resolved} must export reconcile options as \`default\` or \`config\``);
  }
  const options = value;
  if (!Array.isArray(options.rows)) {
    throw new SpendUsageError(`${resolved} must supply \`rows\` \u2014 the product's own settled-ledger fetch`);
  }
  if (!options.store) {
    throw new SpendUsageError(`${resolved} must supply \`store\` \u2014 the product's expectation ledger`);
  }
  return options;
}

// src/spend/cli.ts
async function main() {
  const args = parseSpendArgs(process.argv.slice(2));
  const config = await loadSpendConfig(args.configFile);
  const report = await reconcileSpend({
    ...config,
    ...args.asOf !== void 0 ? { asOf: args.asOf } : {},
    ...args.skip.length > 0 ? { skip: args.skip } : {}
  });
  const rendered = args.json ? spendReportToJson(report) : formatSpendReport(report);
  if (report.ok) process.stdout.write(`${rendered}
`);
  else process.stderr.write(`${rendered}
`);
  return report.ok ? 0 : 1;
}
try {
  process.exit(await main());
} catch (err) {
  if (err instanceof SpendUsageError) {
    process.stderr.write(`${err.message === "help" ? "" : `${err.message}

`}${USAGE}
`);
    process.exit(2);
  }
  process.stderr.write(
    `agent-app-spend-check failed: ${err instanceof Error ? err.message : String(err)}
`
  );
  process.exit(2);
}
//# sourceMappingURL=cli.js.map