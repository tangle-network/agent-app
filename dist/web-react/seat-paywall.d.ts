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
import type { ReactNode } from 'react';
import type { ProductSeatOffer } from '../platform/billing';
export interface SeatPaywallProps {
    /** Human product name shown in the headline, e.g. "Creative". */
    product: string;
    /** Fired when the user clicks the unlock CTA — route them to checkout. When
     *  it returns a promise the button shows a pending state and ignores repeat
     *  clicks until it settles (no double-charge on a slow checkout open). */
    onCheckout: () => void | Promise<void>;
    /** Monthly seat price in whole dollars. Default 100. */
    priceUsd?: number;
    /** Included monthly AI usage in whole dollars. Default 50. */
    includedUsageUsd?: number;
    /** Platform catalog terms. When present, these override the legacy dollar
     * props and show any introductory period without product-local price copy. */
    offer?: ProductSeatOffer;
    /** Optional one-line value prop under the headline. */
    tagline?: string;
    /** CTA label. Default "Continue to checkout". */
    ctaLabel?: string;
    /** Value-prop bullets. Default = product/usage-derived only; pass your own to
     *  supply product-specific value props (the shell bakes no GTM copy). */
    benefits?: ReactNode[];
    /** Optional fine print under the CTA (e.g. "Cancel anytime."). Omitted by default. */
    footnote?: ReactNode;
}
/**
 * Centered card paywall. The price line reads
 * "$100/mo · includes $50/mo of AI usage" so the included allowance anchors the
 * value without ever exposing the ratio — and says it ONCE: the default
 * benefits don't restate the usage line the subline already carries, and the
 * CTA is the next step ("Continue to checkout"), not a third repeat of the
 * eyebrow + headline's "Unlock {product}".
 */
export declare function SeatPaywall({ product, onCheckout, priceUsd, includedUsageUsd, offer, tagline, ctaLabel, benefits, footnote, }: SeatPaywallProps): ReactNode;
