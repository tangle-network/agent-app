import { useMemo, useRef, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { VaultPane } from '../../vault/VaultPane'
import type { VaultDataPort, VaultPaneHandle, VaultTreeNode } from '../../vault/contracts'

const files: VaultTreeNode[] = [{ name: 'brief.md', path: 'brief.md', type: 'file' }]
const content = '# Release brief\n\nReview the current evidence before approving the release.\n\nKeep this document open while refreshing.'
const codec = { parse: (raw: string) => raw, serialize: (value: unknown) => String(value) }

/** Builds folder nodes from flat file paths, as a product's port does. */
function nestPaths(paths: string[]): VaultTreeNode[] {
  const top: VaultTreeNode[] = []
  const folders = new Map<string, VaultTreeNode>()
  for (const path of paths) {
    const parts = path.split('/')
    let siblings = top
    parts.forEach((name, i) => {
      const at = parts.slice(0, i + 1).join('/')
      if (i === parts.length - 1) {
        siblings.push({ name, path: at, type: 'file' })
        return
      }
      let folder = folders.get(at)
      if (!folder) {
        folder = { name, path: at, type: 'directory', children: [] }
        folders.set(at, folder)
        siblings.push(folder)
      }
      siblings = folder.children ?? []
    })
  }
  return top
}

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


function ResponsiveVault({ externalNavigation = false, initialWidth, empty = false }: { externalNavigation?: boolean; initialWidth?: number; empty?: boolean }) {
  const paneRef = useRef<VaultPaneHandle>(null)
  const [width, setWidth] = useState(initialWidth ?? (externalNavigation ? 960 : 390))
  const [path, setPath] = useState<string | null>(empty ? null : 'brief.md')
  const [navigationResult, setNavigationResult] = useState('')
  const port = useMemo<VaultDataPort>(() => {
    const documents = new Map(empty ? [] : [
      ['brief.md', content],
      ['notes.md', '# Notes\n\nKeep unsaved work while browsing files.'],
      ['playbooks/launch.md', '# Launch playbook'],
      ['playbooks/q4/pipeline-review.md', '# Q4 pipeline review'],
      ['research/competitors/landscape.md', '# Competitive landscape'],
    ])
    return {
      async listTree() {
        return nestPaths([...documents.keys()])
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
  }, [empty])
  async function openNewArtifact() {
    const nextPath = await port.createFile('artifact.md')
    await port.writeFile(nextPath, '# Fresh artifact\n\nThis file was created after the tree was loaded.')
    const opened = await paneRef.current?.openFile(nextPath)
    setNavigationResult(opened ? `Opened ${nextPath}` : `Could not open ${nextPath}`)
  }
  return (
    <div className="flex h-[700px] max-w-full flex-col gap-3 p-3" style={{ width }}>
      {externalNavigation && (
        <div className="flex flex-wrap gap-3">
          <button type="button" className="rounded border border-border px-3 py-2" onClick={() => void openNewArtifact()}>
            Open new artifact
          </button>
          <button type="button" className="rounded border border-border px-3 py-2" onClick={() => {
            void paneRef.current?.openFile('missing.md').then((opened) => {
              setNavigationResult(opened ? 'Opened missing.md' : 'Could not open missing.md')
            })
          }}>
            Open missing file
          </button>
          <span role="status" className="self-center text-sm" aria-live="polite">{navigationResult}</span>
        </div>
      )}
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
        ref={paneRef}
        port={port}
        selectedPath={path}
        onSelectedPathChange={setPath}
        codec={codec}
        treeStateKey="storybook:responsive-vault"
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

export const ExternalFileNavigation: StoryObj<typeof RefreshingVault> = {
  render: () => <ResponsiveVault externalNavigation />,
  parameters: {
    docs: {
      description: {
        story: 'An in-memory component fixture. External navigation reports completion after a new file appears, reports failed reads, and asks before discarding a dirty draft. This does not prove backend persistence.',
      },
    },
  },
}

export const DesktopHeaders: StoryObj<typeof RefreshingVault> = {
  render: () => <ResponsiveVault initialWidth={960} />,
}

export const EmptyVault: StoryObj<typeof RefreshingVault> = {
  render: () => <ResponsiveVault empty initialWidth={960} />,
}

export const EmptyVaultNarrow: StoryObj<typeof RefreshingVault> = {
  render: () => <ResponsiveVault empty initialWidth={390} />,
}
