/**
 * Workspace surface: every route of a workspace renders exactly one shared
 * floating panel (sandbox-ui `WorkspaceSurface`, or `WorkspaceLayout` with
 * `surface="inset"`), and that panel's first row is an inset `ShellHeader`.
 *
 * Drew's review of Creative asked for "ONE skeleton": the chat's rounded panel
 * as the layout of Studio, Assets, Tasks, Activity, Vault, the terminal and
 * Integrations. A page with its own skeleton has no `[data-workspace-surface]`,
 * or a header that is not the shell row, and this check names it. It measures
 * the rendered page, so a wrapper that only looks right in the source cannot
 * pass it.
 */

export interface WorkspaceSurfaceSample {
  readonly route: string
  readonly width: number
  readonly theme: string
  /** Visible `[data-workspace-surface]` elements on the page. */
  readonly surfaces: number
  /** The first surface's first header row: `inset`, `flat`, or null when it has none. */
  readonly header: 'inset' | 'flat' | null
  /** px between the surface's top edge and its header's top edge. */
  readonly headerOffsetPx: number | null
}

export interface WorkspaceSurfaceFinding {
  readonly route: string
  readonly width: number
  readonly theme: string
  readonly reason: string
}

/** A header within this distance of the panel top is its first row (a 1px border). */
export const HEADER_TOP_TOLERANCE_PX = 2

export function judgeWorkspaceSurface(sample: WorkspaceSurfaceSample): WorkspaceSurfaceFinding[] {
  const where = { route: sample.route, width: sample.width, theme: sample.theme }
  if (sample.surfaces === 0) {
    return [{ ...where, reason: 'not on the shared panel: no [data-workspace-surface] (use WorkspaceSurface or WorkspaceLayout surface="inset")' }]
  }
  if (sample.surfaces > 1) return [{ ...where, reason: `${sample.surfaces} workspace surfaces on one page; a page has exactly one panel` }]
  if (sample.header !== 'inset') {
    return [{ ...where, reason: sample.header === 'flat'
      ? 'the panel header is a flat ShellHeader; inside the panel it must be inset so its divider meets the rail'
      : 'the panel has no ShellHeader row' }]
  }
  if (sample.headerOffsetPx === null || sample.headerOffsetPx > HEADER_TOP_TOLERANCE_PX) {
    return [{ ...where, reason: `the ShellHeader is ${sample.headerOffsetPx ?? '?'}px below the panel top; it must be the panel's first row` }]
  }
  return []
}

/** Runs in the page. Reads geometry only; `judgeWorkspaceSurface` decides. */
export function collectWorkspaceSurface(): Omit<WorkspaceSurfaceSample, 'route' | 'width' | 'theme'> {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
  }
  const surfaces = Array.from(document.querySelectorAll('[data-workspace-surface]')).filter(visible)
  const first = surfaces[0]
  if (!first) return { surfaces: 0, header: null, headerOffsetPx: null }
  const header = Array.from(first.querySelectorAll('[data-shell-header]')).find(visible)
  if (!header) return { surfaces: surfaces.length, header: null, headerOffsetPx: null }
  const offset = header.getBoundingClientRect().top - first.getBoundingClientRect().top
  return {
    surfaces: surfaces.length,
    header: header.getAttribute('data-shell-header') === 'inset' ? 'inset' : 'flat',
    headerOffsetPx: Math.round(offset * 100) / 100,
  }
}

export interface WorkspaceSurfaceOptions {
  readonly baseUrl: string
  readonly routes: readonly string[]
  readonly widths?: readonly number[]
  readonly themes?: readonly ('light' | 'dark')[]
  readonly storageState?: string
  readonly themeScript?: string
  readonly screenshotDir?: string
  readonly readySelector?: string
}

export interface WorkspaceSurfaceReport {
  readonly samples: readonly WorkspaceSurfaceSample[]
  readonly findings: readonly WorkspaceSurfaceFinding[]
}

/** Drive Chromium over every route × width × theme. Needs the optional `playwright` peer. */
export async function checkWorkspaceSurface(options: WorkspaceSurfaceOptions): Promise<WorkspaceSurfaceReport> {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  const samples: WorkspaceSurfaceSample[] = []
  const findings: WorkspaceSurfaceFinding[] = []
  try {
    for (const width of options.widths ?? [1440, 390]) {
      for (const theme of options.themes ?? ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: { width, height: width < 768 ? 844 : 900 },
          colorScheme: theme,
          ...(options.storageState ? { storageState: options.storageState } : {}),
        })
        if (options.themeScript) {
          await context.addInitScript({ content: `(() => { const theme = ${JSON.stringify(theme)}; ${options.themeScript} })()` })
        }
        const page = await context.newPage()
        for (const route of options.routes) {
          await page.goto(new URL(route, options.baseUrl).toString(), { waitUntil: 'domcontentloaded' })
          await page.waitForSelector(options.readySelector ?? '[data-shell-header]', { state: 'visible', timeout: 15_000 }).catch(() => undefined)
          await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined)
          const sample: WorkspaceSurfaceSample = { route, width, theme, ...(await page.evaluate(collectWorkspaceSurface)) }
          samples.push(sample)
          const found = judgeWorkspaceSurface(sample)
          findings.push(...found)
          if (found.length && options.screenshotDir) {
            const name = `${route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root'}-${width}-${theme}.png`
            await page.screenshot({ path: `${options.screenshotDir}/${name}`, timeout: 10_000 }).catch(() => undefined)
          }
        }
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }
  return { samples, findings }
}

export function formatWorkspaceSurfaceReport(report: WorkspaceSurfaceReport): string {
  const lines = [`workspace surface: ${report.samples.length} pages, ${report.findings.length} off the shared panel`]
  for (const f of report.findings) lines.push(`  FAIL ${f.route} @${f.width} ${f.theme}: ${f.reason}`)
  if (!report.findings.length) lines.push('  ok: every page sits on one shared panel under an inset shell header')
  return lines.join('\n')
}
