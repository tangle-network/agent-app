#!/usr/bin/env node
import {
  checkThemeContract
} from "../chunk-QGSVF6DZ.js";
import "../chunk-EMLGWEHV.js";
import {
  invokedAsScript
} from "../chunk-C3CAYGGQ.js";

// src/theme-contract/cli.ts
function parseArgs(argv) {
  const out = { srcDirs: [], extraCss: [], allow: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === void 0) fail(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--src":
        out.srcDirs.push(take());
        break;
      case "--extra-css":
        out.extraCss.push(take());
        break;
      case "--allow":
        out.allow.push(take());
        break;
      case "--tokens":
        out.tokens = take();
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${flag}`);
    }
  }
  return out;
}
function printUsage() {
  process.stdout.write(
    "Usage: agent-app-theme-check --src <dir> [--src <dir>\u2026] [--extra-css <file>\u2026] [--tokens <file>] [--allow <--var>\u2026]\n"
  );
}
function fail(msg) {
  process.stderr.write(`agent-app-theme-check: ${msg}
`);
  printUsage();
  process.exit(2);
}
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.srcDirs.length === 0) fail("at least one --src <dir> is required");
  const { ok, missing } = checkThemeContract({
    srcDirs: args.srcDirs,
    tokensCss: args.tokens,
    extraTokensCss: args.extraCss,
    allowlist: args.allow
  });
  if (ok) {
    process.stdout.write(`theme contract OK \u2014 every referenced token is defined (${args.srcDirs.join(", ")})
`);
    process.exit(0);
  }
  process.stderr.write(
    `theme contract FAILED \u2014 ${missing.length} token reference(s) resolve to nothing (surface ships transparent):

`
  );
  for (const m of missing) process.stderr.write(`  ${m.varName}
    referenced in ${m.referencedIn}
`);
  process.stderr.write(
    "\nDefine these in your tokens.css (or `import '@tangle-network/agent-app/styles'`),\npass the defining CSS via --extra-css, or suppress a deliberately-external one with --allow.\n"
  );
  process.exit(1);
}
if (invokedAsScript(import.meta.url, process.argv[1])) main();
//# sourceMappingURL=cli.js.map