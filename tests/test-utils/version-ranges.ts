import { gte, minVersion } from 'semver'

export function minimumVersionGte(actualRange: string, requiredRange: string): boolean {
  const actual = minVersion(actualRange)
  const required = minVersion(requiredRange)

  if (!actual || !required) {
    throw new Error(`invalid semver range: actual=${actualRange}, required=${requiredRange}`)
  }

  return gte(actual, required)
}
