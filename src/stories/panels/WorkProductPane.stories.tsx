import type { Meta, StoryObj } from '@storybook/react'
import { WorkProductPane } from '../../work-product-react'
import type { WorkProductPaneProps } from '../../work-product-react'
import { BACKTEST_PASS, DRAFT_RECORD, FIELDS_RECORD, REDLINE_RECORD, VERSION_BODIES } from './fixtures'

const meta: Meta<typeof WorkProductPane> = {
  title: 'WorkProduct/WorkProductPane',
  component: WorkProductPane,
  parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof WorkProductPane>

/** The review pane fills a workbench column — page margins + a readable cap. */
function PaneFrame({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-4xl p-6">{children}</div>
}

const resolveSourceUrl: WorkProductPaneProps['resolveSourceUrl'] = (entry) =>
  `https://vault.tangle.example/${entry.sourceRef}`

const loadVersionBody: WorkProductPaneProps['loadVersionBody'] = async (ref) => {
  console.log('loadVersionBody', ref)
  return VERSION_BODIES[ref] ?? null
}

/** The legal redline: diff-first, the way a legal product mounts it. */
export const RedlineDiff: Story = {
  name: 'Redline — diff tab',
  decorators: [(Story) => <PaneFrame><Story /></PaneFrame>],
  args: { workProduct: REDLINE_RECORD, defaultTab: 'diff' },
}

export const ArtifactTab: Story = {
  name: 'Artifact tab',
  decorators: [(Story) => <PaneFrame><Story /></PaneFrame>],
  args: { workProduct: REDLINE_RECORD, defaultTab: 'artifact' },
}

export const LineageTab: Story = {
  name: 'Lineage tab',
  decorators: [(Story) => <PaneFrame><Story /></PaneFrame>],
  args: { workProduct: REDLINE_RECORD, defaultTab: 'lineage', resolveSourceUrl },
}

/** History rows with the version-compare seam wired — click "Compare v1 → v2"
 *  to load the frozen bodies through `loadVersionBody`. */
export const HistoryTab: Story = {
  name: 'History tab (version compare)',
  decorators: [(Story) => <PaneFrame><Story /></PaneFrame>],
  args: { workProduct: REDLINE_RECORD, defaultTab: 'history', loadVersionBody },
}

export const WithBacktest: Story = {
  name: 'Provenance with backtest',
  decorators: [(Story) => <PaneFrame><Story /></PaneFrame>],
  args: { workProduct: REDLINE_RECORD, defaultTab: 'lineage', resolveSourceUrl, backtest: BACKTEST_PASS },
}

/** A blocked record: unresolved blocking exception — the header calls it out
 *  and the exceptions tab leads. */
export const BlockedWithExceptions: Story = {
  name: 'Blocked — exceptions tab',
  decorators: [(Story) => <PaneFrame><Story /></PaneFrame>],
  args: {
    workProduct: { ...REDLINE_RECORD, status: 'blocked' },
    defaultTab: 'exceptions',
  },
}

export const ChecksTab: Story = {
  name: 'Checks tab (mixed verdicts)',
  decorators: [(Story) => <PaneFrame><Story /></PaneFrame>],
  args: { workProduct: REDLINE_RECORD, defaultTab: 'checks' },
}

/** An accumulating draft: no artifact, no evidence, no history yet. */
export const EmptyDraft: Story = {
  name: 'Empty draft',
  decorators: [(Story) => <PaneFrame><Story /></PaneFrame>],
  args: { workProduct: DRAFT_RECORD },
}

/** The tax shape: a structured fields package (JSON artifact), lineage-first. */
export const TaxFieldsPackage: Story = {
  name: 'Tax fields package — lineage first',
  decorators: [(Story) => <PaneFrame><Story /></PaneFrame>],
  args: { workProduct: FIELDS_RECORD, defaultTab: 'lineage', resolveSourceUrl },
}

/** The pane across its record shapes, side by side. */
export const AllStates: Story = {
  name: 'All states',
  render: () => (
    <div className="flex flex-col gap-10 p-6">
      {(
        [
          [
            'Ready — redline (diff tab)',
            <WorkProductPane key="ready" workProduct={REDLINE_RECORD} defaultTab="diff" backtest={BACKTEST_PASS} />,
          ],
          [
            'Blocked — exceptions tab',
            <WorkProductPane key="blocked" workProduct={{ ...REDLINE_RECORD, status: 'blocked' }} defaultTab="exceptions" />,
          ],
          [
            'Approved — fields package (lineage tab)',
            <WorkProductPane key="fields" workProduct={FIELDS_RECORD} defaultTab="lineage" resolveSourceUrl={resolveSourceUrl} />,
          ],
          ['Draft — no artifact yet', <WorkProductPane key="draft" workProduct={DRAFT_RECORD} />],
        ] as const
      ).map(([label, pane]) => (
        <div key={label}>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">{label}</p>
          <div className="rounded-xl border border-border p-4">{pane}</div>
        </div>
      ))}
    </div>
  ),
}
