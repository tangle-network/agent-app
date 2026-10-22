/**
 * Configuration-only check that a product bills through the Tangle Platform
 * and provisions no product-local Stripe billing. Pure: the product reads its
 * own config files and passes their text, so the check makes no Stripe or
 * Platform request and needs no secrets.
 */

/** The one Platform origin every product's config must name. */
const CANONICAL_PLATFORM_URL = 'https://id.tangle.tools'
const AUTHORITATIVE_STRIPE_WEBHOOK = 'https://id.tangle.tools/v1/billing/webhooks/stripe'
const WEBHOOK_PROHIBITION = "Do not create, re-enable or repoint a Stripe webhook on this product's domain."

/**
 * `STRIPE_*` names DECLARED in a config text — not historical prose or
 * customer integration names. Covers dotenv/shell assignments, quoted JSON keys
 * and optional/readonly Worker bindings.
 */
function localStripeBindings(text: string): string[] {
  return [...text.matchAll(/^\s*(?:(?:export|readonly)\s+)?["']?(STRIPE_[A-Z0-9_]+)["']?\s*\??\s*[:=]/gm)].map(
    (match) => match[1]!,
  )
}

export interface PlatformBillingConfigInput {
  /** The env template's path, for messages, and its text. */
  readonly template: { readonly path: string; readonly text: string }
  /** Further config files (Worker binding types, ...) that must declare no Stripe binding. */
  readonly configs?: ReadonlyArray<{ readonly path: string; readonly text: string }>
  /** The Platform service-credential variable the template must document, when the product has one. */
  readonly serviceTokenEnv?: string
}

/** Every way the product's config departs from Platform-owned billing; empty when it holds. */
export function checkPlatformBillingConfig(input: PlatformBillingConfigInput): string[] {
  const problems: string[] = []
  const { template } = input
  for (const file of [template, ...(input.configs ?? [])]) {
    const bindings = localStripeBindings(file.text)
    if (bindings.length > 0) problems.push(`${file.path} provisions product-local Stripe billing: ${bindings.join(', ')}`)
  }
  const urls = [...template.text.matchAll(/^TANGLE_PLATFORM_URL=([^\r\n]*)$/gm)]
  if (urls.length !== 1) problems.push(`${template.path} must declare TANGLE_PLATFORM_URL exactly once (found ${urls.length})`)
  else if (urls[0]![1]!.trim() !== CANONICAL_PLATFORM_URL) {
    problems.push(`${template.path} TANGLE_PLATFORM_URL must be ${CANONICAL_PLATFORM_URL}`)
  }
  if (!template.text.includes(AUTHORITATIVE_STRIPE_WEBHOOK)) {
    problems.push(`${template.path} must document the authoritative webhook ${AUTHORITATIVE_STRIPE_WEBHOOK}`)
  }
  if (!template.text.includes(WEBHOOK_PROHIBITION)) {
    problems.push(`${template.path} must prohibit local Stripe webhook registration: "${WEBHOOK_PROHIBITION}"`)
  }
  if (input.serviceTokenEnv && !new RegExp(`^${input.serviceTokenEnv}=`, 'm').test(template.text)) {
    problems.push(`${template.path} must document the Platform service credential ${input.serviceTokenEnv}`)
  }
  return problems
}
