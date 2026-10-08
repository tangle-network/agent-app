import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { VaultTree } from '@tangle-network/sandbox-ui/vault-tree'
import type { VaultTreeNode } from '../../vault/contracts'

const root: VaultTreeNode = {
  name: 'Vault',
  path: '',
  type: 'directory',
  children: [
    { name: 'README.md', path: 'README.md', type: 'file' },
    {
      name: 'playbooks',
      path: 'playbooks',
      type: 'directory',
      children: [
        { name: 'launch.md', path: 'playbooks/launch.md', type: 'file' },
        {
          name: 'q4',
          path: 'playbooks/q4',
          type: 'directory',
          children: [
            { name: 'pipeline-review.md', path: 'playbooks/q4/pipeline-review.md', type: 'file' },
            { name: 'a-very-long-file-name-that-has-to-truncate-inside-the-panel.md', path: 'playbooks/q4/a-very-long-file-name-that-has-to-truncate-inside-the-panel.md', type: 'file' },
          ],
        },
      ],
    },
    {
      name: 'research',
      path: 'research',
      type: 'directory',
      children: [
        { name: 'icp.md', path: 'research/icp.md', type: 'file' },
        { name: 'accounts.csv', path: 'research/accounts.csv', type: 'file' },
      ],
    },
    {
      name: 'exports',
      path: 'exports',
      type: 'directory',
      children: Array.from({ length: 320 }, (_, i) => ({ name: `batch-${i + 1}.json`, path: `exports/batch-${i + 1}.json`, type: 'file' as const })),
    },
  ],
}

function Panel({ initialPath }: { initialPath?: string }) {
  const [selected, setSelected] = useState(initialPath)
  return (
    <div className="h-[560px] w-[23rem] max-w-full bg-background p-3">
      <div className="h-full overflow-y-auto rounded-xl border border-border bg-card p-1.5 shadow-raised">
        <VaultTree root={root} selectedPath={selected} onSelect={setSelected} label="Vault" />
      </div>
    </div>
  )
}

const meta: Meta<typeof Panel> = {
  title: 'Vault/Tree',
  component: Panel,
  parameters: { layout: 'fullscreen' },
}
export default meta

/** Every folder starts closed. */
export const Collapsed: StoryObj<typeof Panel> = {}

/** A linked file opens only the folders on its path. */
export const RevealedFile: StoryObj<typeof Panel> = {
  args: { initialPath: 'playbooks/q4/pipeline-review.md' },
}
