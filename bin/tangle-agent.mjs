#!/usr/bin/env node
/** Shipped in agent-app's existing bin/ package files; no private source imports. */
const [mode, path, flag, ...extra] = process.argv.slice(2)
try {
  if (extra.length) throw new Error('Too many arguments')
  if (mode === 'serve') {
    if (path || flag) throw new Error('serve accepts no positional configuration; the trusted profile supplies environment references')
    await (await import('./tangle-agent/runtime.mjs')).serve()
  } else if (mode === 'install-home' && path && !flag) {
    // The function requires root and verifies the actual non-root runtime UID.
    // Never expose this operator/image setup command as an agent MCP tool.
    console.log(JSON.stringify(await (await import('./tangle-agent/home.mjs')).installProtectedHome(path)))
  } else if ((mode === 'plan' || mode === 'provision') && path) {
    if (flag && flag !== '--apply') throw new Error('Unknown option')
    if (mode === 'plan' && flag) throw new Error('plan never writes')
    await (await import('./tangle-agent/provision.mjs')).provision(path, mode === 'provision' && flag === '--apply')
  } else {
    throw new Error('Usage: tangle-agent serve | install-home <runtime-user> | plan <manifest.json> | provision <manifest.json> --apply')
  }
} catch (error) {
  const message = error?.code === 'ERR_MODULE_NOT_FOUND'
    ? 'Missing published optional package. Install the general-agent image dependency cohort documented in docs/tangle-agent-v1.md.'
    : typeof error?.message === 'string' ? error.message : 'Tangle agent command failed'
  console.error(message.replace(/(?:sk-tan-|hubcap_|Bearer\s+)[A-Za-z0-9._-]+/gi, '[credential]'))
  process.exitCode = 1
}
