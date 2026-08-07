import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { MembersPanel } from '../../teams-react'
import type { MembersPanelProps, MemberView } from '../../teams-react'
import { MEMBERS } from './fixtures'

const meta: Meta<typeof MembersPanel> = {
  title: 'Teams/MembersPanel',
  component: MembersPanel,
}

export default meta
type Story = StoryObj<typeof MembersPanel>

/** The panel is a plain section that fills its parent — constrain it to the
 *  width a settings sidebar would give it. */
function PanelFrame({ children }: { children: React.ReactNode }) {
  return <div className="w-[440px] p-4">{children}</div>
}

const onInvite: MembersPanelProps['onInvite'] = async (input) => {
  console.log('onInvite', input)
}
const onChangeRole: MembersPanelProps['onChangeRole'] = async (input) => {
  console.log('onChangeRole', input)
}
const onRemove: MembersPanelProps['onRemove'] = async (input) => {
  console.log('onRemove', input)
}
const onNotice: MembersPanelProps['onNotice'] = (notice) => {
  console.log('onNotice', notice)
}

const baseProps = {
  members: MEMBERS,
  currentRole: 'admin',
  onInvite,
  onChangeRole,
  onRemove,
  onNotice,
} satisfies MembersPanelProps

export const Populated: Story = {
  name: 'Populated (admin)',
  decorators: [(Story) => <PanelFrame><Story /></PanelFrame>],
  args: {
    members: MEMBERS,
    currentRole: 'admin',
    onInvite,
    onChangeRole,
    onRemove,
    onNotice,
  },
}

export const ReadOnly: Story = {
  name: 'Read-only (viewer)',
  decorators: [(Story) => <PanelFrame><Story /></PanelFrame>],
  args: {
    ...Populated.args,
    currentRole: 'viewer',
  },
}

export const ListOnly: Story = {
  name: 'List only (invite form off)',
  decorators: [(Story) => <PanelFrame><Story /></PanelFrame>],
  args: {
    ...Populated.args,
    showInviteForm: false,
  },
}

export const Empty: Story = {
  decorators: [(Story) => <PanelFrame><Story /></PanelFrame>],
  args: {
    ...Populated.args,
    members: [],
  },
}

/** Fully wired: invite appends a pending row, role select and remove mutate
 *  the roster through the async callbacks. */
export const Interactive: Story = {
  decorators: [(Story) => <PanelFrame><Story /></PanelFrame>],
  render: function InteractiveMembers() {
    const [members, setMembers] = useState<MemberView[]>(MEMBERS)
    return (
      <MembersPanel
        members={members}
        currentRole="admin"
        onNotice={onNotice}
        onInvite={async (input) => {
          console.log('onInvite', input)
          setMembers((prev) => [
            ...prev,
            {
              id: `mem-${input.email}`,
              userId: null,
              role: input.role,
              name: null,
              email: input.email,
              acceptedAt: null,
            },
          ])
        }}
        onChangeRole={async (input) => {
          console.log('onChangeRole', input)
          setMembers((prev) =>
            prev.map((member) => (member.id === input.memberId ? { ...member, role: input.role } : member)),
          )
        }}
        onRemove={async (input) => {
          console.log('onRemove', input)
          setMembers((prev) => prev.filter((member) => member.id !== input.memberId))
        }}
      />
    )
  },
}

/** Every roster state side by side — the spacing/role-gating comparison. */
export const AllStates: Story = {
  name: 'All states',
  render: () => (
    <div className="grid gap-8 p-4 lg:grid-cols-2">
      {(
        [
          ['Admin — manages roles', <MembersPanel key="admin" {...baseProps} currentRole="admin" />],
          ['Viewer — read-only', <MembersPanel key="viewer" {...baseProps} currentRole="viewer" />],
          ['List only — pairs with InvitationsPanel', <MembersPanel key="list" {...baseProps} showInviteForm={false} />],
          ['Empty roster', <MembersPanel key="empty" {...baseProps} members={[]} />],
        ] as const
      ).map(([label, panel]) => (
        <div key={label} className="w-[440px]">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">{label}</p>
          <div className="rounded-lg border border-border p-4">{panel}</div>
        </div>
      ))}
    </div>
  ),
}
