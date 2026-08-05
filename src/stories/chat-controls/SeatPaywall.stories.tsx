import type { Meta, StoryObj } from '@storybook/react'

import { SeatPaywall } from '../../web-react'
import { seatOffer } from './fixtures'

/**
 * The "unlock this product" screen. The checkout CTA here returns a slow
 * promise on purpose: clicking shows the pending state ("Opening checkout…")
 * for ~2s — the double-charge guard the component exists for.
 */

const slowCheckout = async () => {
  console.log('checkout clicked')
  await new Promise((resolve) => setTimeout(resolve, 2000))
  console.log('checkout route ready')
}

const meta: Meta<typeof SeatPaywall> = {
  title: 'ChatControls/SeatPaywall',
  component: SeatPaywall,
  parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof SeatPaywall>

/** Defaults — $100/mo, $50/mo usage included, product-derived benefits. */
export const Default: Story = {
  args: { product: 'Creative', onCheckout: slowCheckout },
}

/** Platform offer with a discounted first month — intro price leads. */
export const WithOffer: Story = {
  name: 'With offer (intro pricing)',
  args: { product: 'Creative', onCheckout: slowCheckout, offer: seatOffer },
}

/** Full copy control: tagline, own benefits, custom CTA, footnote. */
export const CustomCopy: Story = {
  name: 'Custom copy',
  args: {
    product: 'Tax',
    onCheckout: slowCheckout,
    priceUsd: 150,
    includedUsageUsd: 75,
    tagline: 'Drafts, workpapers, and review queues — with every number traced to source.',
    ctaLabel: 'Start your Tax seat',
    benefits: [
      'Unlimited matters and workpapers',
      '$75/mo of AI usage included, every month',
      'Evidence lineage on every figure',
      'Cancel anytime — exports stay yours',
    ],
    footnote: 'Cancel anytime. Unused usage does not roll over.',
  },
}

/** Default vs intro-offer vs custom copy, side by side for the pricing audit. */
export const AllStates: Story = {
  name: 'All states',
  render: () => (
    <div className="grid gap-4 p-4 lg:grid-cols-2">
      <div className="rounded-xl border border-border">
        <SeatPaywall product="Creative" onCheckout={slowCheckout} />
      </div>
      <div className="rounded-xl border border-border">
        <SeatPaywall product="Creative" onCheckout={slowCheckout} offer={seatOffer} />
      </div>
      <div className="rounded-xl border border-border lg:col-span-2">
        <SeatPaywall
          product="Tax"
          onCheckout={slowCheckout}
          priceUsd={150}
          includedUsageUsd={75}
          tagline="Drafts, workpapers, and review queues — with every number traced to source."
          ctaLabel="Start your Tax seat"
          benefits={[
            'Unlimited matters and workpapers',
            '$75/mo of AI usage included, every month',
            'Evidence lineage on every figure',
          ]}
          footnote="Cancel anytime. Unused usage does not roll over."
        />
      </div>
    </div>
  ),
}
