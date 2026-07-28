import { gte, minVersion } from 'semver'

export function minimumVersionGte(actualRange: string, requiredRange: string): boolean {
  const invalidRangeMessage =
    `invalid semver range: actual=${actualRange}, required=${requiredRange}`
  let actual: ReturnType<typeof minVersion>
  let required: ReturnType<typeof minVersion>
  try {
    actual = minVersion(actualRange)
    required = minVersion(requiredRange)
  } catch (cause) {
    throw new Error(invalidRangeMessage, { cause })
  }

  if (!actual || !required) {
    throw new Error(invalidRangeMessage)
  }

  return gte(actual, required)
}
