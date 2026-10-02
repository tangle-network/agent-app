import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import * as platform from '../src/platform/index'
import type { HubSettingsContext } from '../src/platform/index'

const retiredExports = [
  'createHubProxyRoutes',
  'resolveUserTangleHubBearer',
  'resolveUserTangleHubBearerForUser',
  'TangleBearerMissingError',
  'isTangleBearerMissingError',
  'isPlatformHubErrorLike',
] as const

describe('Hub settings has one public server boundary', () => {
  it('exports the authorized SDK boundary', () => {
    expect(typeof platform.createHubSettingsRoutes).toBe('function')
  })

  it.each(retiredExports)('does not publish the retired %s API', (name) => {
    expect(Object.keys(platform)).not.toContain(name)
  })

  it('removes the old implementation instead of keeping a hidden compatibility shim', () => {
    expect(existsSync(fileURLToPath(new URL('../src/platform/hub.ts', import.meta.url)))).toBe(false)
    const barrel = readFileSync(new URL('../src/platform/index.ts', import.meta.url), 'utf8')
    expect(barrel).not.toMatch(/from ['"]\.\/hub['"]/)
    expect(barrel).toContain("export * from './hub-settings.js'")
  })

  it.each([
    ['/catalog', 'GET'],
    ['/auth/start', 'POST'],
    ['/healthchecks', 'GET'],
    ['/v1/integrations/catalog', 'GET'],
    ['/exec', 'POST'],
    ['/tokens', 'POST'],
    ['/apps', 'POST'],
    ['/policies/allow-writes', 'POST'],
  ])('does not revive $0 via an app-selected mount path', async (path, method) => {
    const authorize = vi.fn<HubSettingsContext['authorize']>(async () => new Response(null, { status: 403 }))
    const resolveClient = vi.fn<HubSettingsContext['resolveClient']>(async () => {
      throw new Error('An excluded route must never resolve a credential')
    })
    const routes = platform.createHubSettingsRoutes({ basePath: '/api/integrations', authorize, resolveClient })
    const response = await routes.handle(new Request(`https://app.example/api/integrations${path}`, { method }))
    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(authorize).not.toHaveBeenCalled()
    expect(resolveClient).not.toHaveBeenCalled()
  })
})
