import { describe, expect, it } from 'vitest'
import { judgeWorkspaceSurface, type WorkspaceSurfaceSample } from './workspace-surface'

const at = (over: Partial<WorkspaceSurfaceSample>): WorkspaceSurfaceSample => ({
  route: '/w/assets', width: 1440, theme: 'light', surfaces: 1, header: 'inset', headerOffsetPx: 1, ...over,
})

describe('judgeWorkspaceSurface', () => {
  it('passes a page on one panel under an inset shell header', () => {
    expect(judgeWorkspaceSurface(at({}))).toEqual([])
  })
  it('names a page with its own skeleton', () => {
    expect(judgeWorkspaceSurface(at({ surfaces: 0, header: null, headerOffsetPx: null }))[0]?.reason).toMatch(/not on the shared panel/)
  })
  it('refuses two panels on one page', () => {
    expect(judgeWorkspaceSurface(at({ surfaces: 2 }))[0]?.reason).toMatch(/2 workspace surfaces/)
  })
  it('refuses a flat header or none inside the panel', () => {
    expect(judgeWorkspaceSurface(at({ header: 'flat' }))[0]?.reason).toMatch(/must be inset/)
    expect(judgeWorkspaceSurface(at({ header: null, headerOffsetPx: null }))[0]?.reason).toMatch(/no ShellHeader/)
  })
  it('refuses a header that is not the first row', () => {
    expect(judgeWorkspaceSurface(at({ headerOffsetPx: 48 }))[0]?.reason).toMatch(/48px below the panel top/)
  })
})
