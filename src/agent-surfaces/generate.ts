/**
 * Writes or checks a product's agent surfaces as static files. Node-only; the
 * `agent-app-agent-surfaces` bin wraps it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { type AgentSurfaceConfig, agentSurfaceFiles } from './index'

function readExisting(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

export function runAgentSurfacesCli(argv: readonly string[]): number {
  const [configPath, ...rest] = argv
  const outIndex = rest.indexOf('--out')
  const outDir = outIndex >= 0 ? rest[outIndex + 1] : undefined
  const check = rest.includes('--check')
  if (!configPath || !outDir) {
    console.error('Usage: agent-app-agent-surfaces <config.json> --out <dir> [--check]')
    return 2
  }
  const config = JSON.parse(readFileSync(resolve(configPath), 'utf8')) as AgentSurfaceConfig
  const stale: string[] = []
  for (const file of agentSurfaceFiles(config)) {
    const target = join(resolve(outDir), file.path)
    if (readExisting(target) === file.body) continue
    if (check) {
      stale.push(file.path)
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.body)
    console.log(`wrote ${file.path}`)
  }
  if (stale.length > 0) {
    console.error(
      `Agent surfaces are stale: ${stale.join(', ')}. Regenerate with: agent-app-agent-surfaces ${configPath} --out ${outDir}`,
    )
    return 1
  }
  return 0
}

