#!/usr/bin/env node
import {
  formatSignoffSummary,
  formatSignoffVerification,
  readSignoffKey,
  verifySignoffAtRev,
  verifySignoffProofFile
} from "../chunk-2N5O7E32.js";
import {
  invokedAsScript
} from "../chunk-C3CAYGGQ.js";

// src/signoff/proof-cli.ts
function parseArgs(argv) {
  let rev = "HEAD";
  let file = null;
  let dir = process.cwd();
  let keyPath = null;
  let repo = null;
  let json = false;
  let sawRev = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === void 0) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === "--file") file = next();
    else if (arg === "--dir") dir = next();
    else if (arg === "--key") keyPath = next();
    else if (arg === "--repo") repo = next();
    else if (arg === "--json") json = true;
    else if (arg.startsWith("-")) throw new Error(`unknown flag ${arg}`);
    else {
      if (sawRev) throw new Error(`unexpected second revision ${arg}`);
      rev = arg;
      sawRev = true;
    }
  }
  return { rev, file, dir, keyPath, repo, json };
}
function report(result, options) {
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          commitBinding: result.commitBinding,
          macChecked: result.macChecked,
          failures: result.failures,
          requiredSteps: result.requiredSteps,
          summary: formatSignoffSummary(result.proof),
          proof: result.proof
        },
        null,
        2
      )}
`
    );
  } else {
    process.stdout.write(`${formatSignoffVerification(result)}
${formatSignoffSummary(result.proof)}
`);
  }
  return result.ok ? 0 : 1;
}
function main() {
  const options = parseArgs(process.argv.slice(2));
  const key = options.keyPath === null ? void 0 : readSignoffKey(options.keyPath);
  if (options.file !== null) {
    return report(verifySignoffProofFile({ repoDir: options.dir, file: options.file, rev: options.rev, key, expectRepo: options.repo ?? void 0 }), options);
  }
  const outcome = verifySignoffAtRev({ repoDir: options.dir, rev: options.rev, key, expectRepo: options.repo ?? void 0 });
  if (!outcome.found) {
    process.stdout.write(
      `NO PROOF ${outcome.commit}
  nothing is attached under refs/notes/signoff, and no proof covers this commit's tree
  if notes exist upstream, this repo may not fetch them:
${outcome.hint.map((line) => `    ${line}`).join("\n")}
`
    );
    return 1;
  }
  return report(outcome, options);
}
if (invokedAsScript(import.meta.url, process.argv[1])) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`agent-app-verify-proof failed: ${error instanceof Error ? error.message : String(error)}
`);
    process.exit(1);
  }
}
//# sourceMappingURL=proof-cli.js.map