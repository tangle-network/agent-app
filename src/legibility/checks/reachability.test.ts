/**
 * The redline engine and the deadline calculator both shipped correct and
 * unreachable. The route table below is the real shape that hid them: a nested
 * react-router config where every path is composed from ancestors and every
 * link is built from a runtime `base`.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildScannedFile, scanSources } from '../scan'
import { checkReachability, parseRouteConfig, staticSegments } from './reachability'

const ROUTES = `
import { type RouteConfig, index, route } from '@react-router/dev/routes'

export default [
  index('routes/_index.tsx'),
  route('api/contracts', 'routes/api.contracts.ts'),
  route('app', 'routes/app.tsx', [
    route(':workspaceId', 'routes/app.workspace.tsx', [
      index('routes/app.workspace._index.tsx'),
      route('filings', 'routes/app.workspace.filings.tsx'),
      route('contracts', 'routes/app.workspace.contracts.tsx'),
      route('contracts/redline', 'routes/app.workspace.contracts.redline.tsx'),
      route('deadlines', 'routes/app.workspace.deadlines.tsx'),
    ]),
  ]),
] satisfies RouteConfig
`

/** A product tree on disk: the check reads real files, never a stub. */
function product(files: Record<string, string>): { dir: string; routes: string } {
  const dir = mkdtempSync(join(tmpdir(), 'legibility-routes-'))
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, contents)
  }
  return { dir: join(dir, 'src'), routes: join(dir, 'src/routes.ts') }
}

function unreachable(files: Record<string, string>, navFiles: string[] = []): string[] {
  const { dir, routes } = product({ 'src/routes.ts': ROUTES, ...files })
  const result = checkReachability({
    files: scanSources([dir]),
    options: { routeConfigFile: routes, navFiles: navFiles.map((name) => join(dir, name)) },
  })
  return result.findings.map((finding) => /"([^"]+)"/.exec(finding.message)?.[1] ?? '')
}

describe('route table parsing', () => {
  it('composes a nested path from its ancestors', () => {
    const entries = parseRouteConfig(buildScannedFile('/app/src/routes.ts', ROUTES))
    expect(entries.map((entry) => entry.path)).toEqual([
      'api/contracts',
      'app',
      'app/:workspaceId',
      'app/:workspaceId/filings',
      'app/:workspaceId/contracts',
      'app/:workspaceId/contracts/redline',
      'app/:workspaceId/deadlines',
    ])
  })

  it('names the module each route renders, so resource routes can be told from screens', () => {
    const entries = parseRouteConfig(buildScannedFile('/app/src/routes.ts', ROUTES))
    expect(entries.find((entry) => entry.path === 'api/contracts')?.module).toBe('routes/api.contracts.ts')
  })

  it('reduces a path to the segments a link can be compared against', () => {
    expect(staticSegments('app/:workspaceId/contracts/redline')).toEqual(['app', 'contracts', 'redline'])
    expect(staticSegments('${base}/contracts/${id}')).toEqual(['contracts'])
  })
})

describe('unreachable capability', () => {
  it('reports a route that no nav entry and no link reaches', () => {
    const found = unreachable({
      'src/nav.tsx': `export const NAV = [{ label: 'Filings', path: '/filings' }]`,
      'src/screen.tsx': `export const S = () => <Link to={\`\${base}/contracts\`}>Contracts</Link>`,
    })
    expect(found).toEqual(['app/:workspaceId/contracts/redline', 'app/:workspaceId/deadlines'])
  })

  it('counts a link written against a runtime base', () => {
    // The chunk naming the destination arrives AFTER the `${base}` hole; a
    // scanner that only reads the first chunk reports a route that is linked.
    const found = unreachable({
      'src/screen.tsx': `
        export const S = () => (
          <div>
            <Link to={\`\${base}/contracts/redline\`}>Redline</Link>
            <Link to={\`\${base}/deadlines\`}>Deadlines</Link>
            <Link to={\`\${base}/filings\`}>Filings</Link>
          </div>
        )
      `,
    })
    expect(found).toEqual(['app/:workspaceId/contracts'])
  })

  it('counts a nav entry', () => {
    const nav = `export const NAV = [
      { label: 'Filings', path: '/filings' },
      { label: 'Contracts', path: '/contracts' },
      { label: 'Redline', path: '/contracts/redline' },
      { label: 'Deadlines', path: '/deadlines' },
    ]`
    expect(unreachable({ 'src/nav.tsx': nav }, ['nav.tsx'])).toEqual([])
  })

  it('counts a destination assembled into a named constant', () => {
    const found = unreachable({
      'src/screen.tsx': `
        const redlineUrl = ready ? \`/app/\${id}/contracts/redline\` : '/app/x/contracts/redline'
        export const S = () => <Panel target={redlineUrl} />
      `,
    })
    expect(found).toEqual(['app/:workspaceId/filings', 'app/:workspaceId/contracts', 'app/:workspaceId/deadlines'])
  })

  it('counts an imperative navigation', () => {
    const found = unreachable({
      'src/screen.tsx': 'export const go = () => navigate(`/app/${id}/deadlines`)',
    })
    expect(found).toContain('app/:workspaceId/contracts/redline')
    expect(found).not.toContain('app/:workspaceId/deadlines')
  })

  it('does not ask a resource route or an api route for a door', () => {
    expect(unreachable({})).not.toContain('api/contracts')
  })

  it('does not report a route the product declares as doorless on purpose', () => {
    const { dir, routes } = product({ 'src/routes.ts': ROUTES })
    const reported = (ignore: string[]): string[] =>
      checkReachability({ files: scanSources([dir]), options: { routeConfigFile: routes, ignore } }).findings.map(
        (finding) => /"([^"]+)"/.exec(finding.message)?.[1] ?? '',
      )
    expect(reported(['api/*'])).toContain('app/:workspaceId/deadlines')
    expect(reported(['api/*', 'app/:workspaceId/deadlines'])).not.toContain('app/:workspaceId/deadlines')
  })

  it('names the route config file and line, so the finding is clickable', () => {
    const { dir, routes } = product({ 'src/routes.ts': ROUTES })
    const result = checkReachability({ files: scanSources([dir]), options: { routeConfigFile: routes } })
    expect(result.routeFile?.path).toBe(routes)
    const line = result.routeFile?.positionAt(result.findings[0]?.offset ?? 0).line
    expect(ROUTES.split('\n')[(line ?? 1) - 1]).toContain('route(')
  })
})
