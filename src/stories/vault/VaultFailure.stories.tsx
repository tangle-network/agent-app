import type { Meta, StoryObj } from '@storybook/react'

import { VaultPane } from '../../vault/VaultPane'
import type { VaultDataPort, VaultTreeNode } from '../../vault/contracts'

const file: VaultTreeNode = { name: 'evidence.md', path: 'evidence.md', type: 'file' }

const port: VaultDataPort = {
  listTree: async () => [file],
  readFile: async (path) => ({ path, content: '# Evidence\n\nThe current draft remains available.' }),
  writeFile: async () => { throw new Error('Save failed. Your draft is still here.') },
  createFile: async (path) => path,
  deleteFile: async () => {},
}

const meta: Meta<typeof VaultPane> = {
  title: 'Vault/Failure',
  component: VaultPane,
  parameters: { layout: 'centered' },
}

export default meta
type Story = StoryObj<typeof VaultPane>

/** Open the file, then try to save it. The alert and delete icon use the danger text role. */
export const FailedSave: Story = {
  render: () => (
    <div className="h-[440px] max-w-[660px] min-w-[280px] overflow-hidden rounded-lg border border-border bg-background" style={{ width: 'calc(100vw - 2rem)' }}>
      <VaultPane
        port={port}
        renderTree={({ onSelect }) => (
          <button type="button" onClick={() => onSelect(file.path)} className="p-3 text-sm text-foreground">
            {file.name}
          </button>
        )}
        renderArtifact={({ file: selected, onSave }) => selected && (
          <div className="flex flex-col gap-3 p-4 text-sm text-foreground">
            <p>{selected.content}</p>
            <button type="button" onClick={() => void onSave()} className="w-fit rounded border border-border px-3 py-2">
              Simulate failed save
            </button>
          </div>
        )}
      />
    </div>
  ),
}
