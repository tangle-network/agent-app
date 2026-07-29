const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** One path rule in Cloudflare's static-asset `_headers` file. */
export interface CloudflareHeadersRule {
  pattern: string
  headers: Readonly<Record<string, string>>
}

function assertSingleLine(value: string, label: string): void {
  if (value.length === 0 || /[\r\n]/.test(value)) {
    throw new Error(`${label} must be a non-empty single line`)
  }
}

/**
 * Render native Cloudflare static-asset header rules.
 *
 * Values are validated before serialization so a product setting cannot add a
 * second path rule or response header through a newline.
 */
export function renderCloudflareHeadersFile(
  rules: readonly CloudflareHeadersRule[],
): string {
  if (rules.length === 0) {
    throw new Error('At least one Cloudflare header rule is required')
  }

  const renderedRules = rules.map(({ pattern, headers }) => {
    assertSingleLine(pattern, 'Cloudflare header pattern')
    if (!pattern.startsWith('/') || /\s/.test(pattern)) {
      throw new Error('Cloudflare header patterns must start with / and contain no whitespace')
    }

    const entries = Object.entries(headers)
    if (entries.length === 0) {
      throw new Error(`Cloudflare header rule ${pattern} must contain at least one header`)
    }

    const renderedHeaders = entries.map(([name, value]) => {
      if (!HEADER_NAME.test(name)) {
        throw new Error(`Invalid HTTP header name: ${name}`)
      }
      assertSingleLine(value, `Cloudflare header ${name}`)
      return `  ${name}: ${value}`
    })

    return [pattern, ...renderedHeaders].join('\n')
  })

  return `${renderedRules.join('\n\n')}\n`
}
