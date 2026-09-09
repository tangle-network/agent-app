import { useMemo, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { VaultPane } from '../../vault/VaultPane'
import type { VaultDataPort, VaultTreeNode } from '../../vault/contracts'

const files: VaultTreeNode[] = [{ name: 'brief.md', path: 'brief.md', type: 'file' }]
const content = '# Release brief\n\nReview the current evidence before approving the release.\n\nKeep this document open while refreshing.'
const codec = { parse: (raw: string) => raw, serialize: (value: unknown) => String(value) }

function RefreshingVault() {
  const [refreshKey, setRefreshKey] = useState(0)
  const port = useMemo<VaultDataPort>(() => {
    let reads = 0
    let lists = 0
    const delay = () => new Promise<void>((resolve) => window.setTimeout(resolve, 1500))
    return {
      async listTree() {
        if (lists++ > 0) await delay()
        return files
      },
      async readFile(path) {
        if (reads++ > 0) await delay()
        return { path, content }
      },
      async writeFile() { throw new Error('Read-only fixture') },
      async createFile() { throw new Error('Read-only fixture') },
      async deleteFile() { throw new Error('Read-only fixture') },
    }
  }, [])
  return (
    <div className="flex h-[640px] flex-col">
      <button type="button" className="self-start p-3" onClick={() => setRefreshKey((key) => key + 1)}>
        Refresh in background
      </button>
      <VaultPane
        port={port}
        selectedPath="brief.md"
        refreshKey={refreshKey}
        codec={codec}
        canWrite={false}
        renderTree={({ root }) => <div className="p-3">{root.children?.map((file) => <div key={file.path}>{file.name}</div>)}</div>}
        renderArtifact={({ file }) => <div className="h-full overflow-auto whitespace-pre-wrap p-5">{file?.content}</div>}
      />
    </div>
  )
}

const meta: Meta<typeof RefreshingVault> = {
  title: 'Vault/Background refresh',
  component: RefreshingVault,
  parameters: { layout: 'fullscreen' },
}
export default meta
export const ExistingDocument: StoryObj<typeof RefreshingVault> = {}
