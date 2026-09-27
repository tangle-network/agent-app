#!/usr/bin/env node
import {
  LEGIBILITY_CHECKS,
  checkLegibility,
  formatLegibilityReport,
  legibilityReportToJson
} from "../chunk-EPZYYWCT.js";
import "../chunk-EMLGWEHV.js";
import {
  invokedAsScript
} from "../chunk-C3CAYGGQ.js";

// src/legibility/cli.ts
import { existsSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";

// src/legibility/cli-args.ts
var DEFAULT_CONFIG_FILE = "legibility.config.mjs";
var LegibilityUsageError = class extends Error {
};
var USAGE = [
  "Usage: agent-app-legibility-check --src <dir> [--src <dir>\u2026] [--routes <file>] [--nav <file>\u2026]",
  "                                 [--ignore <substr>\u2026] [--skip <check>\u2026] [--config <file>]",
  "                                 [--json] [--list-suppressions]",
  `Checks: ${LEGIBILITY_CHECKS.join(", ")}`
].join("\n");
function parseArgs(argv) {
  const out = {
    srcDirs: [],
    navFiles: [],
    ignorePaths: [],
    skip: [],
    json: false,
    listSuppressions: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const take = () => {
      const value = argv[++i];
      if (value === void 0) throw new LegibilityUsageError(`${flag} needs a value`);
      return value;
    };
    switch (flag) {
      case "--src":
        out.srcDirs.push(take());
        break;
      case "--routes":
        out.routes = take();
        break;
      case "--nav":
        out.navFiles.push(take());
        break;
      case "--ignore":
        out.ignorePaths.push(take());
        break;
      case "--skip": {
        const check = take();
        if (!LEGIBILITY_CHECKS.includes(check)) {
          throw new LegibilityUsageError(`--skip ${check} is not a check. Known: ${LEGIBILITY_CHECKS.join(", ")}`);
        }
        out.skip.push(check);
        break;
      }
      case "--config":
        out.config = take();
        break;
      case "--json":
        out.json = true;
        break;
      case "--list-suppressions":
        out.listSuppressions = true;
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      default:
        throw new LegibilityUsageError(`unknown argument: ${flag}`);
    }
  }
  return out;
}
function mergeConfig(fromFile, args) {
  const checks = { ...fromFile.checks };
  for (const check of args.skip) checks[check] = false;
  const reachability = {
    ...fromFile.reachability,
    ...args.routes ? { routeConfigFile: args.routes } : {},
    ...args.navFiles.length > 0 ? { navFiles: args.navFiles } : {}
  };
  return {
    ...fromFile,
    srcDirs: args.srcDirs.length > 0 ? args.srcDirs : fromFile.srcDirs ?? [],
    ignorePaths: [...fromFile.ignorePaths ?? [], ...args.ignorePaths],
    ...Object.keys(checks).length > 0 ? { checks } : {},
    ...reachability.routeConfigFile || reachability.routePaths ? { reachability } : {}
  };
}

// src/legibility/cli.ts
async function loadConfigFile(path) {
  const explicit = path !== void 0;
  const resolved = resolve(process.cwd(), path ?? DEFAULT_CONFIG_FILE);
  if (!existsSync(resolved)) {
    if (explicit) throw new LegibilityUsageError(`no config at ${resolved}`);
    return {};
  }
  const module = await import(pathToFileURL(resolved).href);
  const exported = module.default ?? module.config;
  const value = typeof exported === "function" ? await exported() : exported;
  if (value === null || typeof value !== "object") {
    throw new LegibilityUsageError(`${resolved} must default-export a legibility config object`);
  }
  return value;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}
`);
    return 0;
  }
  const config = mergeConfig(await loadConfigFile(args.config), args);
  if (config.srcDirs.length === 0) {
    throw new LegibilityUsageError("at least one --src <dir> is required (or srcDirs in the config file)");
  }
  const report = checkLegibility(config);
  const text = args.json ? legibilityReportToJson(report) : formatLegibilityReport(report, { listSuppressions: args.listSuppressions });
  if (report.ok) process.stdout.write(`${text}
`);
  else process.stderr.write(`${text}
`);
  return report.ok ? 0 : 1;
}
if (invokedAsScript(import.meta.url, process.argv[1])) {
  try {
    process.exit(await main());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`agent-app-legibility-check: ${message}
`);
    if (error instanceof LegibilityUsageError) process.stderr.write(`${USAGE}
`);
    process.exit(2);
  }
}
//# sourceMappingURL=cli.js.map