/**
 * Shell alignment: on each route, at desktop and phone widths, the main pane's
 * header divider must continue the sidebar rail's first divider.
 *
 * Every shell header row is a sandbox-ui `ShellHeader` at brand's
 * `--shell-header-height`, so their bottom borders share one y. A product that
 * gives a header its own height (Hospitality's 66px inbox head beside a 56px
 * rail) moves its divider off that line; this check measures the rendered page,
 * so it catches the drift whatever CSS caused it.
 *
 * The browser half (`collectShellDividers`) only reads geometry; the decision
 * (`judgeShellAlignment`) is a pure function so it is unit-tested without a browser.
 */

/** A horizontal divider: the bottom border of a top-anchored row. Coordinates in CSS px. */
export interface ShellDivider {
  readonly label: string
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

export interface ShellDividerSample {
  readonly route: string
  readonly width: number
  readonly theme: string
  /** `--shell-header-height` resolved to px on this page. */
  readonly shellHeaderPx: number
  /** The rail's first divider (desktop), or null when the rail is hidden. */
  readonly rail: ShellDivider | null
  /** The phone bar standing in for the rail below its breakpoint, or null. */
  readonly phoneBar: ShellDivider | null
  /** Every top-anchored row divider in the main pane and its side panels. */
  readonly headers: readonly ShellDivider[]
}

export interface ShellAlignmentFinding {
  readonly route: string
  readonly width: number
  readonly theme: string
  readonly header: string
  /** Signed px: positive when the header divider sits below the expected line. */
  readonly offsetPx: number
  readonly expectedY: number
  readonly actualY: number
  readonly reason: string
}

export const SHELL_ALIGNMENT_TOLERANCE_PX = 0.5

/**
 * Desktop: every header divider lands on the rail's first divider.
 * Phone: the rail is hidden; the phone bar is one shell row, and a header row
 * that starts under it is exactly one shell row tall.
 */
export function judgeShellAlignment(
  sample: ShellDividerSample,
  tolerancePx = SHELL_ALIGNMENT_TOLERANCE_PX,
): ShellAlignmentFinding[] {
  const where = { route: sample.route, width: sample.width, theme: sample.theme }
  const anchor = sample.rail ?? sample.phoneBar
  if (!anchor) {
    return [{ ...where, header: '(shell)', offsetPx: Number.NaN, expectedY: Number.NaN, actualY: Number.NaN,
      reason: 'no rail divider or phone bar found: the route does not render the shared shell' }]
  }
  const findings: ShellAlignmentFinding[] = []
  if (sample.rail) {
    const expectedY = sample.rail.bottom
    for (const header of sample.headers) {
      const offsetPx = header.bottom - expectedY
      if (Math.abs(offsetPx) > tolerancePx) {
        findings.push({ ...where, header: header.label, offsetPx, expectedY, actualY: header.bottom,
          reason: `header divider is ${formatPx(offsetPx)} from the rail's first divider` })
      }
    }
    return findings
  }
  const bar = sample.phoneBar as ShellDivider
  const barOffset = bar.bottom - bar.top - sample.shellHeaderPx
  if (Math.abs(barOffset) > tolerancePx) {
    findings.push({ ...where, header: bar.label, offsetPx: barOffset, expectedY: bar.top + sample.shellHeaderPx,
      actualY: bar.bottom, reason: `phone bar is ${formatPx(barOffset)} off one shell row` })
  }
  const expectedY = bar.bottom + sample.shellHeaderPx
  for (const header of sample.headers) {
    const offsetPx = header.bottom - expectedY
    if (Math.abs(offsetPx) > tolerancePx) {
      findings.push({ ...where, header: header.label, offsetPx, expectedY, actualY: header.bottom,
        reason: `header under the phone bar is ${formatPx(offsetPx)} off one shell row` })
    }
  }
  return findings
}

function formatPx(value: number): string {
  return `${value > 0 ? '+' : ''}${Math.round(value * 100) / 100}px`
}

/**
 * Runs in the page (Playwright serializes it). A divider is the visible bottom
 * border of a wide, top-anchored element with no top border: header rows have
 * only a bottom divider, while inputs, cards and the inset surface draw a full
 * box and are skipped. Returns raw geometry; `judgeShellAlignment` decides.
 */
export function collectShellDividers(): Omit<ShellDividerSample, 'route' | 'width' | 'theme'> {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:absolute;visibility:hidden;height:var(--shell-header-height, 3.5rem)'
  document.body.appendChild(probe)
  const shellHeaderPx = probe.getBoundingClientRect().height || 56
  probe.remove()

  const viewport = document.documentElement.clientWidth
  const describe = (el: Element): string => {
    const id = el.id ? `#${el.id}` : ''
    const classes = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter((c) => !c.includes(':') && !c.includes('[')).slice(0, 3).map((c) => `.${c}`).join('') : ''
    const shell = el.hasAttribute('data-shell-header') ? '[data-shell-header]' : ''
    return `${el.tagName.toLowerCase()}${id}${classes}${shell}`
  }
  const controls = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'HR', 'TABLE', 'TR', 'TD', 'TH'])
  const visibleColor = (color: string) => !/^(transparent|rgba\([^)]*,\s*0\))$/.test(color.trim())
  const rows: ShellDivider[] = []
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (controls.has(el.tagName) || el.closest('[role="dialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]')) continue
    const rect = el.getBoundingClientRect()
    if (rect.width < 160 || rect.height < 20 || rect.top > 140 || rect.bottom > 240) continue
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue
    const bottomWidth = Number.parseFloat(style.borderBottomWidth)
    if (!(bottomWidth > 0) || style.borderBottomStyle === 'none' || !visibleColor(style.borderBottomColor)) continue
    if (Number.parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none') continue
    rows.push({ label: describe(el), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
  }

  // The rail sits at the left edge, narrower than the page; its first divider is its top row.
  const rail = rows
    .filter((r) => r.left < 2 && r.right < Math.min(480, viewport * 0.5) && r.top < 16)
    .sort((a, b) => a.bottom - b.bottom)[0] ?? null
  const phoneBar = rail ? null : rows
    .filter((r) => r.left < 2 && r.right > viewport - 2 && r.top < 2)
    .sort((a, b) => a.bottom - b.bottom)[0] ?? null
  const paneTop = phoneBar ? phoneBar.bottom : 0
  const headers = rows.filter((r) => r !== rail && r !== phoneBar
    && (!rail || r.left >= rail.right - 1)
    // A header row starts at or near the pane top: Hospitality's history header
    // started 28px down (and ended 28px low), so "near" is 48px, not a gutter.
    && r.top >= paneTop - 1 && r.top < paneTop + 48
    && r.bottom > paneTop + 20 && r.bottom < paneTop + 160)
  // Nested rows that share one divider line are one divider; keep the outermost.
  const unique = headers.filter((r, i) => !headers.some((o, j) => j !== i
    && Math.abs(o.bottom - r.bottom) < 0.01 && o.left <= r.left && o.right >= r.right && (o.right - o.left > r.right - r.left || j < i)))
  return { shellHeaderPx, rail, phoneBar, headers: unique }
}

export interface ShellAlignmentOptions {
  readonly baseUrl: string
  readonly routes: readonly string[]
  readonly widths?: readonly number[]
  readonly themes?: readonly ('light' | 'dark')[]
  /** Playwright storage state (cookies, localStorage) for an authenticated app. */
  readonly storageState?: string
  /** Run in each page before the app loads, with `theme` in scope, to apply the app's own theme switch. */
  readonly themeScript?: string
  /** Write a screenshot per failing route and width here. */
  readonly screenshotDir?: string
  readonly tolerancePx?: number
  /** Wait for this selector after navigation (default `[data-shell-header]`). */
  readonly readySelector?: string
}

export interface ShellAlignmentReport {
  readonly samples: readonly ShellDividerSample[]
  readonly findings: readonly ShellAlignmentFinding[]
  readonly maxOffsetPx: number
}

const PHONE_HEIGHT = 844
const DESKTOP_HEIGHT = 900

/** Drive Chromium over every route × width × theme and judge each page. Needs the optional `playwright` peer. */
export async function checkShellAlignment(options: ShellAlignmentOptions): Promise<ShellAlignmentReport> {
  const { chromium } = await import('playwright')
  const widths = options.widths ?? [1440, 390]
  const themes = options.themes ?? ['light', 'dark']
  const browser = await chromium.launch()
  const samples: ShellDividerSample[] = []
  const findings: ShellAlignmentFinding[] = []
  try {
    for (const width of widths) {
      for (const theme of themes) {
        const context = await browser.newContext({
          viewport: { width, height: width < 768 ? PHONE_HEIGHT : DESKTOP_HEIGHT },
          colorScheme: theme,
          ...(options.storageState ? { storageState: options.storageState } : {}),
        })
        if (options.themeScript) {
          await context.addInitScript({ content: `(() => { const theme = ${JSON.stringify(theme)}; ${options.themeScript} })()` })
        }
        const page = await context.newPage()
        for (const route of options.routes) {
          // An app that polls never reaches network idle, so wait for the shell to
          // render and give in-flight data a short, capped settle.
          await page.goto(new URL(route, options.baseUrl).toString(), { waitUntil: 'domcontentloaded' })
          await page.waitForSelector(options.readySelector ?? '[data-shell-header]', { state: 'visible', timeout: 15_000 }).catch(() => undefined)
          await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined)
          await page.evaluate(() => document.fonts?.ready)
          const geometry = await page.evaluate(collectShellDividers)
          const sample: ShellDividerSample = { route, width, theme, ...geometry }
          samples.push(sample)
          const found = judgeShellAlignment(sample, options.tolerancePx)
          findings.push(...found)
          if (found.length && options.screenshotDir) {
            const name = `${route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root'}-${width}-${theme}.png`
            // Evidence only: a screenshot that stalls must not lose the measurement.
            await page.screenshot({ path: `${options.screenshotDir}/${name}`, timeout: 10_000, animations: 'disabled' }).catch(() => undefined)
          }
        }
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }
  const maxOffsetPx = findings.reduce((max, f) => (Number.isFinite(f.offsetPx) ? Math.max(max, Math.abs(f.offsetPx)) : max), 0)
  return { samples, findings, maxOffsetPx }
}

export function formatShellAlignmentReport(report: ShellAlignmentReport): string {
  const lines = [`shell alignment: ${report.samples.length} pages, ${report.findings.length} misaligned, max offset ${Math.round(report.maxOffsetPx * 100) / 100}px`]
  for (const f of report.findings) lines.push(`  FAIL ${f.route} @${f.width} ${f.theme}: ${f.header} ${f.reason} (y ${round(f.actualY)} vs ${round(f.expectedY)})`)
  if (!report.findings.length) lines.push('  ok: every main header divider continues the rail\'s first divider')
  return lines.join('\n')
}

function round(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '?'
}
