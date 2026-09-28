import type { Meta, StoryObj } from '@storybook/react'
import { LineBilling } from '../../hosted-agent/react'
import { billingUnverified, billingVerified } from './fixtures'

const meta: Meta<typeof LineBilling> = {
  title: 'Hosted agent/Lines/Billing',
  component: LineBilling,
  parameters: { layout: 'padded' },
  decorators: [(Story) => <div style={{ maxWidth: 760, padding: 16 }}><Story /></div>],
}

export default meta
type Story = StoryObj<typeof LineBilling>

export const PayerUnverified: Story = { args: { view: billingUnverified } }
export const WorkspaceAndMemberPay: Story = { args: { view: billingVerified } }
export const AllowanceUnavailable: Story = { args: { view: { ...billingUnverified, allowance: null } } }
