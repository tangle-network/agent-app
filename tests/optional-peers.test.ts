import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('optional peer isolation', () => {
  it.each(Object.entries(manifest.peerDependenciesMeta)
    .filter(([, metadata]) => (metadata as { optional?: boolean }).optional)
    .map(([name]) => name))('leaves %s to the consuming application', name => {
    expect(manifest.dependencies?.[name]).toBeUndefined()
    expect(manifest.optionalDependencies?.[name]).toBeUndefined()
    expect(manifest.peerDependencies[name]).toBeTruthy()
  })
})
