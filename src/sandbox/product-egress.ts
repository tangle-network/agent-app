import type { EgressPolicy } from '@tangle-network/sandbox'

/**
 * Build the standard outbound policy for a product sandbox.
 *
 * Product code supplies its public origin and only the extra product-specific
 * destinations. The model capability registry is named explicitly because a
 * strict product sandbox must not inherit the platform's broad developer list.
 */
function isWellFormedDomainPattern(pattern: string): boolean {
  if (!pattern || pattern.startsWith('.') || pattern.includes('..')) return false
  const labels = pattern.split('.')
  if (labels.some((label) => label.length === 0)) return false

  for (let index = 1; index < labels.length; index += 1) {
    if (labels[index]!.includes('*')) return false
  }

  const head = labels[0]!
  if (head === '*' || head === '**') return labels.length >= 2
  return !head.includes('*')
}

/** Hosts required when a product installs its pinned Python tooling at boot. */
export const PYPI_EGRESS_DOMAINS = ['pypi.org', 'files.pythonhosted.org', 'pypi.python.org'] as const

export function buildProductEgressPolicy(
  publicOrigin: string | URL,
  extraDomains: readonly string[] = [],
): EgressPolicy {
  const origin = typeof publicOrigin === 'string' ? new URL(publicOrigin) : publicOrigin
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
    throw new Error(`Product egress origin must use http or https: ${origin.protocol}`)
  }
  if (!origin.hostname) throw new Error('Product egress origin must include a hostname')

  const domains = new Set<string>([origin.hostname.toLowerCase(), 'models.dev'])
  for (const value of extraDomains) {
    const domain = value.trim().toLowerCase().replace(/\.$/, '')
    if (
      !domain
      || domain.includes('://')
      || domain.includes('/')
      || domain.includes(':')
      || !isWellFormedDomainPattern(domain)
    ) {
      throw new Error(`Product egress domain must be a hostname or wildcard: ${value}`)
    }
    domains.add(domain)
  }

  return {
    mode: 'strict',
    allowDomains: [...domains],
    includeImplicitDomains: false,
  }
}
