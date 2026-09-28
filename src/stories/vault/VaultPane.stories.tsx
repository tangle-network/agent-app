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


function ResponsiveVault() {
  const [width, setWidth] = useState(390)
  const [path, setPath] = useState<string | null>('brief.md')
  const port = useMemo<VaultDataPort>(() => {
    const documents = new Map([
      ['brief.md', content],
      ['notes.md', '# Notes\n\nKeep unsaved work while browsing files.'],
    ])
    return {
      async listTree() {
        return [...documents.keys()].map((path) => ({ name: path, path, type: 'file' as const }))
      },
      async readFile(path) {
        const content = documents.get(path)
        if (content === undefined) throw new Error('File not found')
        return { path, content }
      },
      async writeFile(path, next) { documents.set(path, next) },
      async createFile(path) { documents.set(path, ''); return path },
      async deleteFile(path) { documents.delete(path) },
    }
  }, [])
  return (
    <div className="flex h-[700px] max-w-full flex-col gap-3 p-3" style={{ width }}>
      <label className="flex items-center gap-3 text-sm">
        Pane width
        <input
          aria-label="Pane width"
          type="range"
          min={320}
          max={960}
          value={width}
          onChange={(event) => setWidth(Number(event.target.value))}
          className="min-w-0 flex-1"
        />
        <span>{width}px</span>
      </label>
      <VaultPane
        port={port}
        selectedPath={path}
        onSelectedPathChange={setPath}
        codec={codec}
        renderTree={({ root, onSelect }) => (
          <div className="flex flex-col p-2">
            {root.children?.map((file) => (
              <button key={file.path} type="button" className="rounded p-3 text-left hover:bg-muted" onClick={() => onSelect(file.path)}>
                {file.name}
              </button>
            ))}
          </div>
        )}
        renderArtifact={({ richDraft, onRichChange, onSave, dirty }) => (
          <div className="flex h-full min-h-0 flex-col gap-3 p-3">
            <textarea
              aria-label="Document text"
              value={String(richDraft)}
              onChange={(event) => onRichChange(event.target.value)}
              className="min-h-0 w-full flex-1 resize-none rounded border border-border bg-background p-3"
            />
            <button type="button" disabled={!dirty} onClick={onSave} className="self-end rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50">
              Save document
            </button>
          </div>
        )}
      />
    </div>
  )
}

export const ResponsiveNavigation: StoryObj<typeof RefreshingVault> = {
  render: () => <ResponsiveVault />,
}
