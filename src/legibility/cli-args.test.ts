/**
 * The bin's contract with a CI file. A flag that silently does nothing is the
 * same failure as a check that silently passes.
 */
import { describe, expect, it } from 'vitest'
import { LegibilityUsageError, mergeConfig, parseArgs } from './cli-args'

describe('parseArgs', () => {
  it('collects repeatable sources and nav files', () => {
    const args = parseArgs(['--src', 'src', '--src', 'packages/ui/src', '--nav', 'src/nav.tsx', '--routes', 'src/routes.ts'])
    expect(args.srcDirs).toEqual(['src', 'packages/ui/src'])
    expect(args.navFiles).toEqual(['src/nav.tsx'])
    expect(args.routes).toBe('src/routes.ts')
  })

  it('rejects a --skip that names no real check, listing the real ones', () => {
    expect(() => parseArgs(['--skip', 'vocabulary'])).toThrow(LegibilityUsageError)
    expect(() => parseArgs(['--skip', 'vocabulary'])).toThrow(/engineering-vocabulary/)
  })

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--strict'])).toThrow(/unknown argument: --strict/)
  })

  it('rejects a flag whose value is missing', () => {
    expect(() => parseArgs(['--src'])).toThrow(/--src needs a value/)
  })
})

describe('mergeConfig', () => {
  const empty = parseArgs([])

  it('keeps the config file when no flag overrides it', () => {
    const merged = mergeConfig({ srcDirs: ['app/src'], vocabulary: { allowTerms: ['record'] } }, empty)
    expect(merged.srcDirs).toEqual(['app/src'])
    expect(merged.vocabulary?.allowTerms).toEqual(['record'])
  })

  it('lets a flag win over the config file', () => {
    const merged = mergeConfig({ srcDirs: ['app/src'] }, parseArgs(['--src', 'other/src']))
    expect(merged.srcDirs).toEqual(['other/src'])
  })

  it('turns off exactly the checks --skip names', () => {
    const merged = mergeConfig({}, parseArgs(['--skip', 'silent-failure']))
    expect(merged.checks).toEqual({ 'silent-failure': false })
  })

  it('adds --ignore paths to the config file own list', () => {
    const merged = mergeConfig({ ignorePaths: ['generated'] }, parseArgs(['--ignore', 'legacy']))
    expect(merged.ignorePaths).toEqual(['generated', 'legacy'])
  })

  it('omits reachability entirely when neither routes nor paths are given', () => {
    expect(mergeConfig({}, empty).reachability).toBeUndefined()
  })

  it('keeps the config file nav files when only --routes is passed', () => {
    const merged = mergeConfig(
      { reachability: { navFiles: ['src/nav.tsx'], ignore: ['api/*'] } },
      parseArgs(['--routes', 'src/routes.ts']),
    )
    expect(merged.reachability).toEqual({
      navFiles: ['src/nav.tsx'],
      ignore: ['api/*'],
      routeConfigFile: 'src/routes.ts',
    })
  })
})
