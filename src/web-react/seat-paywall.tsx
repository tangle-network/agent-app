/**
 * `SeatPaywall` — the shared "unlock this product" screen every agent app
 * shows when a user has no active seat and has spent past the free tier.
 *
 * Copy contract (design §6.8): the included monthly AI usage is framed as a
 * BENEFIT the buyer receives — never the ratio, never the word "margin", never
 * "we debit 50%". Surface the allowance, hide the economics.
 *
 * Styling contract matches the rest of `web-react`: Tailwind classes over the
 * shared design tokens (`bg-card`, `border-border`, `text-muted-foreground`,
 * `bg-primary`, …); glyphs are inline SVGs; no icon or UI library.
 */

import type { ReactNode } from 'react'

import type { ProductSeatOffer } from '../platform/billing'
import { usePending } from './controls'

export interface SeatPaywallProps {
  /** Human product name shown in the headline, e.g. "Creative". */
  product: string
  /** Fired when the user clicks the unlock CTA — route them to checkout. When
   *  it returns a promise the button shows a pending state and ignores repeat
   *  clicks until it settles (no double-charge on a slow checkout open). */
  onCheckout: () => void | Promise<void>
  /** Monthly seat price in whole dollars. Default 100. */
  priceUsd?: number
  /** Included monthly AI usage in whole dollars. Default 50. */
  includedUsageUsd?: number
  /** Platform catalog terms. When present, these override the legacy dollar
   * props and show any introductory period without product-local price copy. */
  offer?: ProductSeatOffer
  /** Optional one-line value prop under the headline. */
  tagline?: string
  /** CTA label. Default "Unlock {product}". */
  ctaLabel?: string
  /** Value-prop bullets. Default = product/usage-derived only; pass your own to
   *  supply product-specific value props (the shell bakes no GTM copy). */
  benefits?: ReactNode[]
  /** Optional fine print under the CTA (e.g. "Cancel anytime."). Omitted by default. */
  footnote?: ReactNode
}

function usd(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100)
}

function CheckGlyph(): ReactNode {
  return (
    <svg
      className="h-4 w-4 shrink-0 text-primary"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function Benefit({ children }: { children: ReactNode }): ReactNode {
  return (
    <li className="flex items-start gap-2.5 text-sm text-foreground">
      <span className="mt-0.5">
        <CheckGlyph />
      </span>
      <span>{children}</span>
    </li>
  )
}

/**
 * Centered card paywall. The price line reads
 * "$100/mo · includes $50/mo of AI usage" so the included allowance anchors the
 * value without ever exposing the ratio.
 */
export function SeatPaywall({
  product,
  onCheckout,
  priceUsd = 100,
  includedUsageUsd = 50,
  offer,
  tagline,
  ctaLabel,
  benefits,
  footnote,
}: SeatPaywallProps): ReactNode {
  const { pending, run } = usePending()
  const recurringPrice = offer ? usd(offer.recurring.priceCents) : `$${priceUsd}`
  const recurringUsage = offer
    ? usd(offer.recurring.includedCreditsCents)
    : `$${includedUsageUsd}`
  const introductory = offer?.introductory ?? null
  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-card-edge bg-card p-8">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {product}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
          Unlock {product}
        </h1>
        {tagline && <p className="mt-2 text-sm text-muted-foreground">{tagline}</p>}

        {introductory ? (
          <>
            <div className="mt-6 flex items-baseline gap-1.5">
              <span className="text-3xl font-semibold text-foreground">
                {usd(introductory.priceCents)}
              </span>
              <span className="text-sm text-muted-foreground">first month</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Includes {usd(introductory.includedCreditsCents)} of AI usage in your first month
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Then {recurringPrice}/mo · includes {recurringUsage}/mo of AI usage
            </p>
          </>
        ) : (
          <>
            <div className="mt-6 flex items-baseline gap-1.5">
              <span className="text-3xl font-semibold text-foreground">{recurringPrice}</span>
              <span className="text-sm text-muted-foreground">/mo</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Includes {recurringUsage}/mo of AI usage
            </p>
          </>
        )}

        <ul className="mt-6 space-y-2.5">
          {(benefits ?? [
            `Full access to ${product}`,
            `${recurringUsage}/mo of AI usage included`,
          ]).map((benefit, i) => (
            <Benefit key={i}>{benefit}</Benefit>
          ))}
        </ul>

        <button
          type="button"
          disabled={pending}
          onClick={() => run(onCheckout)}
          className="mt-7 inline-flex w-full items-center justify-center rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {pending ? 'Opening checkout…' : ctaLabel ?? `Unlock ${product}`}
        </button>
        {footnote && (
          <p className="mt-3 text-center text-xs text-muted-foreground/70">
            {footnote}
          </p>
        )}
      </div>
    </div>
  )
}
