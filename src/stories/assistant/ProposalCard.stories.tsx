import type { Meta, StoryObj } from '@storybook/react'
import type { ReactNode } from 'react'
import { ProposalCard } from '../../assistant'
import type { PendingProposal } from '../../assistant/types'
import { apiKeyProposal, workflowProposal, workflowYaml } from './fixtures'

/** The card's in-transcript width (the panel's transcript padding around it). */
function Frame({ children }: { children: ReactNode }) {
  return <div className="w-[380px]">{children}</div>
}

/**
 * The confirmation card for a mutating assistant action. Presentational — each
 * story is one card state; Confirm/Cancel/Connect log to the console.
 */
const meta: Meta<typeof ProposalCard> = {
  title: 'Assistant/ProposalCard',
  component: ProposalCard,
  parameters: { layout: 'centered' },
}

export default meta
type Story = StoryObj<typeof ProposalCard>

const log = {
  onConfirm: () => console.log('[story] confirm'),
  onCancel: () => console.log('[story] cancel'),
  navigate: (path: string) => console.log('[story] navigate', path),
}

/** Stand-in for the host's workflow-graph renderer, so the Graph/YAML toggle
 *  has both panes. */
const renderGraph = (_yaml: string) => (
  <div className="flex h-full flex-col items-center justify-center gap-2 bg-secondary p-3">
    <div className="rounded-md border border-border bg-card px-3 py-1.5 text-foreground text-xs">
      Schedule — Mondays 09:00
    </div>
    <div className="h-3 w-px bg-border" />
    <div className="rounded-md border border-border bg-card px-3 py-1.5 text-foreground text-xs">
      canvas/export — page-1 → png
    </div>
    <div className="h-3 w-px bg-border" />
    <div className="rounded-md border border-primary/40 bg-card px-3 py-1.5 text-foreground text-xs">
      slack/send-message — #launch
    </div>
  </div>
)

/** Workflow author, no graph renderer wired: the YAML shows as a text preview. */
export const WorkflowYaml: Story = {
  name: 'Workflow (YAML preview)',
  decorators: [(Story) => <Frame><Story /></Frame>],
  args: {
    proposal: workflowProposal,
    confirming: false,
    ...log,
  },
}

/** With the host's graph renderer: the card opens on the Graph tab, YAML one
 *  click away. */
export const WorkflowGraph: Story = {
  name: 'Workflow (graph + YAML toggle)',
  decorators: [(Story) => <Frame><Story /></Frame>],
  args: {
    proposal: workflowProposal,
    confirming: false,
    renderGraph,
    ...log,
  },
}

/** Integration requirements: one unconnected (in-place Connect, busy state on
 *  click), one GitHub App not installed (Install target), one connected. */
export const WithRequirements: Story = {
  name: 'With Integration Requirements',
  decorators: [(Story) => <Frame><Story /></Frame>],
  args: {
    proposal: {
      ...workflowProposal,
      requirements: [
        {
          provider: 'slack',
          kind: 'integration',
          connected: false,
          connectUrl: '/app/integrations/slack',
        },
        { provider: 'github', kind: 'github_app', connected: false, connectUrl: null },
        { provider: 'github', kind: 'integration', connected: true },
      ],
    } satisfies PendingProposal,
    confirming: false,
    onConnect: (requirement) => console.log('[story] connect', requirement.provider),
    ...log,
  },
}

/** Confirmation in flight — both buttons disabled, "Confirming…" label. */
export const Confirming: Story = {
  name: 'Confirming',
  decorators: [(Story) => <Frame><Story /></Frame>],
  args: {
    proposal: workflowProposal,
    confirming: true,
    ...log,
  },
}

/** A retryable confirm failure (unconnected integration): the card stays, with
 *  the server's message on it, so the user can connect and confirm again. */
export const RetryError: Story = {
  name: 'Retry Error',
  decorators: [(Story) => <Frame><Story /></Frame>],
  args: {
    proposal: {
      ...workflowProposal,
      retryError: 'Slack isn’t connected. Connect it, then confirm again.',
    },
    confirming: false,
    onConnect: (requirement) => console.log('[story] connect', requirement.provider),
    ...log,
  },
}

/** A scalar-fields action (no body preview): create API key. */
export const ApiKey: Story = {
  name: 'API Key (scalar fields)',
  decorators: [(Story) => <Frame><Story /></Frame>],
  args: {
    proposal: apiKeyProposal,
    confirming: false,
    ...log,
  },
}

/** author_workflow: the YAML plus the new skills minted alongside it. */
export const AuthorWithSkills: Story = {
  name: 'Author Workflow + Skills',
  decorators: [(Story) => <Frame><Story /></Frame>],
  args: {
    proposal: {
      proposalId: 'prop-3',
      callId: 'call-3',
      name: 'author_workflow',
      args: {
        yaml: workflowYaml,
        skills: [
          { name: 'poster-copy', description: 'Writes launch-poster captions in the house tone' },
          { name: 'schedule-check', description: null },
        ],
      },
    } satisfies PendingProposal,
    confirming: false,
    renderGraph,
    ...log,
  },
}

function CardCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <div className="w-[340px]">{children}</div>
    </div>
  )
}

/** The card's main variants side by side. */
export const AllCards: Story = {
  name: 'All Cards',
  parameters: { layout: 'padded' },
  render: () => (
    <div className="grid grid-cols-3 gap-4">
      <CardCell label="Workflow — YAML">
        <ProposalCard proposal={workflowProposal} confirming={false} {...log} />
      </CardCell>
      <CardCell label="Workflow — graph">
        <ProposalCard
          proposal={workflowProposal}
          confirming={false}
          renderGraph={renderGraph}
          {...log}
        />
      </CardCell>
      <CardCell label="Requirements">
        <ProposalCard
          proposal={workflowProposal}
          confirming={false}
          onConnect={(r) => console.log('[story] connect', r.provider)}
          {...log}
        />
      </CardCell>
      <CardCell label="Confirming">
        <ProposalCard proposal={workflowProposal} confirming {...log} />
      </CardCell>
      <CardCell label="Retry error">
        <ProposalCard
          proposal={{
            ...workflowProposal,
            retryError: 'Slack isn’t connected. Connect it, then confirm again.',
          }}
          confirming={false}
          {...log}
        />
      </CardCell>
      <CardCell label="API key">
        <ProposalCard proposal={apiKeyProposal} confirming={false} {...log} />
      </CardCell>
    </div>
  ),
}
