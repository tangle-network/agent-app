#!/usr/bin/env node
/** Shipped in agent-app's existing bin/ package files; no private source imports. */
const [mode, path, flag] = process.argv.slice(2)
try {
  if (mode === 'serve') {
    if (path) throw new Error('serve accepts no positional configuration; the trusted profile supplies environment references')
    await (await import('./tangle-agent/runtime.mjs')).serve()
  } else if ((mode === 'plan' || mode === 'provision') && path) {
    if (flag && flag !== '--apply') throw new Error('Unknown option')
    if (mode === 'plan' && flag) throw new Error('plan never writes')
    await (await import('./tangle-agent/provision.mjs')).provision(path, mode === 'provision' && flag === '--apply')
  } else {
    throw new Error('Usage: tangle-agent serve | plan <manifest.json> | provision <manifest.json> --apply')
  }
} catch (error) {
  // Startup errors contain configuration names, never credentials. Do not log
  // an SDK/provider object that may retain authorization headers.
  const message = error?.code === 'ERR_MODULE_NOT_FOUND'
    ? 'Missing published optional package. Install the general-agent image dependency cohort documented in docs/tangle-agent-v1.md.'
    : typeof error?.message === 'string' ? error.message : 'Tangle agent command failed'
  console.error(message.replace(/(?:sk-tan-|hubcap_|Bearer\s+)[A-Za-z0-9._-]+/gi, '[credential]'))
  process.exitCode = 1
}
