import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * Is this module the script the process was started with?
 *
 * The obvious spelling — `import.meta.url === pathToFileURL(process.argv[1]).href`
 * — is wrong for every packaged bin, and wrong in the silent direction: the
 * module decides it was imported rather than executed, so the CLI does nothing
 * and exits 0.
 *
 * The two sides are not the same kind of path. `import.meta.url` is the module
 * URL Node resolved, and Node resolves a module's realpath unless started with
 * `--preserve-symlinks`. `process.argv[1]` is the path as SPELLED on the
 * command line. A package manager's bin shim spells it through symlinked
 * directories:
 *
 *   argv[1]          …/node_modules/.bin/../@scope/pkg/dist/cli.js
 *   import.meta.url  …/node_modules/.pnpm/pkg@1.2.3/node_modules/@scope/pkg/dist/cli.js
 *
 * Same file, two strings, and a `===` between them is false.
 *
 * So the entry path is resolved the same way Node resolved the module before
 * the comparison. A missing or unresolvable entry is not this function's
 * business to explain — it is simply not this module, which is the honest
 * answer and keeps an importer from executing a CLI.
 */
export function invokedAsScript(moduleUrl: string, entry: string | undefined): boolean {
  if (entry === undefined || entry.length === 0) return false
  let resolved: string
  try {
    resolved = realpathSync(entry)
  } catch {
    return false
  }
  return moduleUrl === pathToFileURL(resolved).href
}
