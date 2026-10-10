import { describe, expect, it } from 'vitest'
import { judgeShellAlignment, type ShellDivider, type ShellDividerSample } from './shell-alignment'
import { parseShellAlignmentArgs, ShellAlignmentUsageError } from './shell-alignment-cli'

const row = (label: string, top: number, bottom: number, left = 260, right = 1440): ShellDivider => ({ label, left, right, top, bottom })
const desktop = (headers: ShellDivider[]): ShellDividerSample => ({
  route: '/w/inbox', width: 1440, theme: 'light', shellHeaderPx: 56,
  rail: row('div[data-shell-header]', 0, 56, 0, 260), phoneBar: null, headers,
})

describe('judgeShellAlignment', () => {
  it('passes when every header divider lands on the rail divider', () => {
    expect(judgeShellAlignment(desktop([row('header.page', 0, 56), row('div[data-shell-header]', 9, 56, 270, 1432)]))).toEqual([])
  })

  it("fails Hospitality's 66px inbox head with a signed +10px offset", () => {
    const [finding] = judgeShellAlignment(desktop([row('div.ha-inbox-detail-head', 0, 66)]))
    expect(finding).toMatchObject({ header: 'div.ha-inbox-detail-head', offsetPx: 10, expectedY: 56, actualY: 66 })
  })

  it('fails the old inset header one pixel low, and tolerates sub-pixel rounding', () => {
    expect(judgeShellAlignment(desktop([row('inset', 9, 57)]))).toHaveLength(1)
    expect(judgeShellAlignment(desktop([row('inset', 9, 56.4)]))).toEqual([])
  })

  it('on a phone, holds the bar and each header under it to one shell row', () => {
    const phone: ShellDividerSample = {
      route: '/w/chat', width: 390, theme: 'dark', shellHeaderPx: 56, rail: null,
      phoneBar: row('header[data-shell-header]', 0, 56, 0, 390),
      headers: [row('ok', 56, 112, 0, 390), row('div.ha-inbox-list-head', 56, 106, 0, 390)],
    }
    const findings = judgeShellAlignment(phone)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ header: 'div.ha-inbox-list-head', offsetPx: -6 })
  })

  it('fails a route that renders no shell at all', () => {
    const findings = judgeShellAlignment({ ...desktop([]), rail: null })
    expect(findings[0]?.reason).toMatch(/does not render the shared shell/)
  })
})

describe('parseShellAlignmentArgs', () => {
  it('needs a base URL and a route', () => {
    expect(() => parseShellAlignmentArgs(['--route', '/a'])).toThrow(ShellAlignmentUsageError)
    expect(() => parseShellAlignmentArgs(['--base-url', 'http://x'])).toThrow(ShellAlignmentUsageError)
    expect(parseShellAlignmentArgs(['--base-url', 'http://x', '--route', '/a', '--route', '/b', '--widths', '1280,390', '--themes', 'dark']))
      .toMatchObject({ baseUrl: 'http://x', routes: ['/a', '/b'], widths: [1280, 390], themes: ['dark'] })
  })
})
