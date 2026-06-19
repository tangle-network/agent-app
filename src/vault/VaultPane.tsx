/**
 * The shared 3-pane vault: tree | artifact viewer | optional agent dock. This is
 * pure shell MECHANISM — selection, the dirty-guard + pending-nav state machine,
 * rich/source editor modes, create/delete/refresh, skeletons, an error boundary,
 * and an empty state. It renders NO file tree and NO artifact viewer of its own:
 * those arrive through the `renderTree` / `renderArtifact` / `renderDock` seams,
 * so a product wires sandbox-ui's RichFileTree + FileArtifactPane in ~10 lines.
 *
 * Data flows exclusively through `port` (a `VaultDataPort`). The pane never
 * imports a fetch client, a router, a toast system, or a markdown library — the
 * optional `codec` seam supplies rich/source parsing (identity passthrough by
 * default). Chrome uses the shared theme tokens (bg-card, border-border, …).
 */

import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import { ConfirmDialog } from './ConfirmDialog'
import type {
  VaultEditorMode,
  VaultFile,
  VaultMarkdownCodec,
  VaultPaneProps,
  VaultRichParts,
  VaultTreeNode,
} from './contracts'

const IDENTITY_CODEC: VaultMarkdownCodec = {
  parse: (raw) => raw,
  serialize: (parts) => (typeof parts === 'string' ? parts : String(parts ?? '')),
}

type PendingNav = { type: 'open'; path: string } | { type: 'close' } | null

function collectFilePaths(nodes: VaultTreeNode[], into: Set<string>): Set<string> {
  for (const node of nodes) {
    if (node.type === 'file') into.add(node.path)
    if (node.children) collectFilePaths(node.children, into)
  }
  return into
}

function countFiles(nodes: VaultTreeNode[]): number {
  return nodes.reduce(
    (sum, node) => (node.type === 'file' ? sum + 1 : sum + countFiles(node.children ?? [])),
    0,
  )
}

class EditorErrorBoundary extends Component<{ children: ReactNode; onReset?: () => void }, { error: unknown }> {
  state: { error: unknown } = { error: null }
  static getDerivedStateFromError(error: unknown) {
    return { error }
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Vault crashed:', error, info)
  }
  render() {
    if (this.state.error) {
      const msg = this.state.error instanceof Error
        ? this.state.error.message
        : typeof this.state.error === 'string'
          ? this.state.error
          : 'Something went wrong loading the vault'
      return (
        <div className="flex h-full flex-1 flex-col items-center justify-center p-8 text-center">
          <h3 className="mb-1 text-sm font-medium text-foreground">Vault failed to load</h3>
          <p className="mb-4 max-w-xs text-xs text-muted-foreground">{String(msg)}</p>
          <button
            type="button"
            onClick={() => { this.setState({ error: null }); this.props.onReset?.() }}
            className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function TreeSkeleton() {
  return (
    <div className="space-y-2 p-4" aria-hidden="true">
      {[32, 48, 40, 52].map((w, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-muted" style={{ width: `${w * 4}px` }} />
      ))}
    </div>
  )
}

function EditorSkeleton() {
  return (
    <div className="space-y-3 p-8" aria-hidden="true">
      <div className="h-5 w-1/2 animate-pulse rounded bg-muted" />
      <div className="h-4 w-full animate-pulse rounded bg-muted" />
      <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center p-8 text-center">
      <h3 className="text-sm font-medium text-foreground">Open a vault document</h3>
      <p className="mt-1 max-w-xs text-xs text-muted-foreground">
        Select a file from the directory, or create a new one.
      </p>
    </div>
  )
}

export function VaultPane(props: VaultPaneProps) {
  const {
    port,
    renderTree,
    renderArtifact,
    renderDock,
    canWrite = true,
    selectedPath: controlledPath,
    onSelectedPathChange,
    codec,
    className,
    dockToggle,
    refreshKey,
    headerActions,
  } = props

  const activeCodec = codec ?? IDENTITY_CODEC
  const controlled = controlledPath !== undefined
  const isMarkdownCapable = codec !== undefined
  // `false` → a persistent dock (no toggle, always open with the selected file).
  const persistentDock = dockToggle === false
  const dockToggleCfg = dockToggle ? dockToggle : { label: 'Discuss', disabledWhenDirty: true }

  const [tree, setTree] = useState<VaultTreeNode[]>([])
  const [treeLoading, setTreeLoading] = useState(true)
  const [internalPath, setInternalPath] = useState<string | null>(null)
  const selectedPath = controlled ? (controlledPath ?? null) : internalPath

  const [selectedFile, setSelectedFile] = useState<VaultFile | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const [editorMode, setEditorMode] = useState<VaultEditorMode>('rich')
  const [richDraft, setRichDraft] = useState<VaultRichParts>('')
  const [sourceDraft, setSourceDraft] = useState('')
  const [isDirty, setIsDirty] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [creating, setCreating] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [dockOpen, setDockOpen] = useState(false)
  const [pendingNav, setPendingNav] = useState<PendingNav>(null)

  const savedContentRef = useRef('')
  const loadedPathRef = useRef<string | null>(null)

  const filePaths = useMemo(() => collectFilePaths(tree, new Set<string>()), [tree])
  const treeRoot = useMemo<VaultTreeNode>(
    () => ({ name: 'Vault', path: '', type: 'directory', children: tree }),
    [tree],
  )
  const fileCount = useMemo(() => countFiles(tree), [tree])

  const commitPath = useCallback(
    (next: string | null) => {
      if (!controlled) setInternalPath(next)
      onSelectedPathChange?.(next)
    },
    [controlled, onSelectedPathChange],
  )

  const refresh = useCallback(async () => {
    setTreeLoading(true)
    try {
      setTree(await port.listTree())
    } finally {
      setTreeLoading(false)
    }
  }, [port])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshKey])

  useEffect(() => {
    if (!selectedPath) {
      setSelectedFile(null)
      setFileLoading(false)
      loadedPathRef.current = null
      return
    }
    let cancelled = false
    const path = selectedPath
    setFileLoading(true)
    void (async () => {
      try {
        const file = await port.readFile(path)
        if (!cancelled) setSelectedFile(file)
      } catch {
        if (!cancelled) setSelectedFile(null)
      } finally {
        if (!cancelled) setFileLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [port, selectedPath, refreshKey])

  useEffect(() => {
    if (!selectedFile) {
      loadedPathRef.current = null
      savedContentRef.current = ''
      setRichDraft('')
      setSourceDraft('')
      setEditorMode('rich')
      setIsDirty(false)
      return
    }
    const pathChanged = loadedPathRef.current !== selectedFile.path
    loadedPathRef.current = selectedFile.path
    savedContentRef.current = selectedFile.content
    setRichDraft(activeCodec.parse(selectedFile.content))
    setSourceDraft(selectedFile.content)
    if (pathChanged) setEditorMode('rich')
    setIsDirty(false)
    setDockOpen(false)
  }, [selectedFile, activeCodec])

  const guardedOpen = useCallback(
    (path: string) => {
      if (path === selectedPath) return
      if (isDirty) {
        setPendingNav({ type: 'open', path })
        return
      }
      commitPath(path)
    },
    [isDirty, selectedPath, commitPath],
  )

  const guardedClose = useCallback(() => {
    if (isDirty) {
      setPendingNav({ type: 'close' })
      return
    }
    commitPath(null)
    setSelectedFile(null)
  }, [isDirty, commitPath])

  const confirmDiscard = useCallback(() => {
    const nav = pendingNav
    setPendingNav(null)
    setIsDirty(false)
    if (!nav) return
    if (nav.type === 'open') {
      commitPath(nav.path)
    } else {
      commitPath(null)
      setSelectedFile(null)
    }
  }, [pendingNav, commitPath])

  const showRichMode = useCallback(() => {
    setEditorMode((mode) => {
      if (mode === 'rich') return mode
      setRichDraft(activeCodec.parse(sourceDraft))
      setIsDirty(sourceDraft !== savedContentRef.current)
      return 'rich'
    })
  }, [activeCodec, sourceDraft])

  const showSourceMode = useCallback(() => {
    setEditorMode((mode) => {
      if (mode === 'source') return mode
      const content = isDirty ? activeCodec.serialize(richDraft) : savedContentRef.current
      setSourceDraft(content)
      setIsDirty(content !== savedContentRef.current)
      return 'source'
    })
  }, [activeCodec, isDirty, richDraft])

  const onSourceChange = useCallback((next: string) => {
    setSourceDraft(next)
    setIsDirty(next !== savedContentRef.current)
  }, [])

  const onRichChange = useCallback((next: VaultRichParts) => {
    setRichDraft(next)
    setIsDirty(activeCodec.serialize(next) !== savedContentRef.current)
  }, [activeCodec])

  const saveCurrent = useCallback(async () => {
    if (!selectedFile) return
    const content = editorMode === 'source' ? sourceDraft : activeCodec.serialize(richDraft)
    setSaving(true)
    try {
      await port.writeFile(selectedFile.path, content)
      savedContentRef.current = content
      setSelectedFile({ ...selectedFile, content })
      setSourceDraft(content)
      setRichDraft(activeCodec.parse(content))
      setIsDirty(false)
    } finally {
      setSaving(false)
    }
  }, [selectedFile, editorMode, sourceDraft, richDraft, activeCodec, port])

  const handleCreate = useCallback(async () => {
    const trimmed = newPath.trim()
    if (!trimmed) return
    setCreating(true)
    try {
      const created = await port.createFile(trimmed)
      setCreateOpen(false)
      setNewPath('')
      await refresh()
      commitPath(created)
    } finally {
      setCreating(false)
    }
  }, [newPath, port, refresh, commitPath])

  const handleDelete = useCallback(async () => {
    if (!selectedFile) return
    setDeleting(true)
    try {
      await port.deleteFile(selectedFile.path)
      setDeleteOpen(false)
      setIsDirty(false)
      commitPath(null)
      setSelectedFile(null)
      await refresh()
    } finally {
      setDeleting(false)
    }
  }, [selectedFile, port, refresh, commitPath])

  return (
    <EditorErrorBoundary onReset={() => { commitPath(null); setSelectedFile(null) }}>
      <div className={`flex min-h-0 flex-1 overflow-hidden ${className ?? ''}`}>
        <div className="flex w-[23rem] min-w-[23rem] flex-col border-r border-border bg-background">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-sm font-semibold text-foreground">Vault</span>
              <span className="text-xs text-muted-foreground">
                {fileCount} file{fileCount === 1 ? '' : 's'}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {headerActions}
              <button
                type="button"
                aria-label="Refresh vault"
                onClick={() => void refresh()}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
              >
                ↻
              </button>
              {canWrite && (
                <button
                  type="button"
                  aria-label="New vault file"
                  onClick={() => setCreateOpen(true)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                >
                  +
                </button>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {treeLoading ? (
              <TreeSkeleton />
            ) : (
              renderTree({
                root: treeRoot,
                selectedPath: selectedPath ?? undefined,
                onSelect: (path) => { if (filePaths.has(path)) guardedOpen(path) },
              })
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {selectedFile && (
            <div className="flex shrink-0 items-center justify-between border-b border-border bg-card px-4 py-1.5">
              <span data-vault-path className="truncate text-xs text-muted-foreground">{selectedFile.path}</span>
              <div className="flex items-center gap-1">
                {canWrite && isMarkdownCapable && (
                  <div className="mr-1 flex items-center gap-1">
                    <button
                      type="button"
                      aria-label="Edit as rich text"
                      aria-pressed={editorMode === 'rich'}
                      onClick={showRichMode}
                      className={`inline-flex h-7 items-center rounded px-2 text-xs transition-colors ${
                        editorMode === 'rich'
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      Rich
                    </button>
                    <button
                      type="button"
                      aria-label="Edit as source"
                      aria-pressed={editorMode === 'source'}
                      onClick={showSourceMode}
                      className={`inline-flex h-7 items-center rounded px-2 text-xs transition-colors ${
                        editorMode === 'source'
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      Source
                    </button>
                  </div>
                )}
                {renderDock && !persistentDock && (
                  <button
                    type="button"
                    aria-label={dockToggleCfg.label}
                    aria-pressed={dockOpen}
                    disabled={(dockToggleCfg.disabledWhenDirty ?? true) && isDirty}
                    title={(dockToggleCfg.disabledWhenDirty ?? true) && isDirty ? 'Save your changes first' : (dockToggleCfg.title ?? dockToggleCfg.label)}
                    onClick={() => setDockOpen((v) => !v)}
                    className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors disabled:pointer-events-none disabled:opacity-40 ${
                      dockOpen
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    {dockToggleCfg.label}
                  </button>
                )}
                {canWrite && (
                  <button
                    type="button"
                    aria-label="Delete this file"
                    title="Delete file"
                    onClick={() => setDeleteOpen(true)}
                    className="p-1 text-muted-foreground transition-colors hover:text-destructive"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          )}
          <div className="flex-1 overflow-hidden">
            {fileLoading ? (
              <EditorSkeleton />
            ) : selectedFile && canWrite && isMarkdownCapable && editorMode === 'source' ? (
              <SourceEditor
                path={selectedFile.path}
                content={sourceDraft}
                saving={saving}
                dirty={isDirty}
                onChange={onSourceChange}
                onSave={() => void saveCurrent()}
              />
            ) : selectedFile ? (
              renderArtifact({
                file: selectedFile,
                loading: false,
                mode: editorMode,
                canWrite,
                richDraft,
                dirty: isDirty,
                onRichChange,
                onSave: () => void saveCurrent(),
              })
            ) : (
              <EmptyState />
            )}
          </div>
        </div>

        {renderDock && selectedFile && renderDock({
          file: selectedFile,
          open: persistentDock ? true : dockOpen,
          onClose: persistentDock ? () => {} : () => setDockOpen(false),
        })}

        <ConfirmDialog
          open={createOpen}
          title="Create vault file"
          description="Add a new document to this vault."
          confirmLabel={creating ? 'Creating…' : 'Create'}
          confirmDisabled={creating || !newPath.trim()}
          onConfirm={() => void handleCreate()}
          onCancel={() => { setCreateOpen(false); setNewPath('') }}
        >
          <input
            value={newPath}
            autoFocus
            onChange={(e) => setNewPath(e.target.value)}
            placeholder="e.g. playbooks/new-strategy.md"
            aria-label="New file path"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-primary/60"
          />
        </ConfirmDialog>

        <ConfirmDialog
          open={deleteOpen}
          title="Delete file?"
          description={`This permanently removes ${selectedFile?.path ?? 'this file'} from the vault.`}
          confirmLabel={deleting ? 'Deleting…' : 'Delete file'}
          confirmDisabled={deleting}
          destructive
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteOpen(false)}
        />

        <ConfirmDialog
          open={pendingNav !== null}
          title="Discard unsaved changes?"
          description="Your edits to this document haven't been saved. Continue and lose them?"
          confirmLabel="Discard changes"
          destructive
          onConfirm={confirmDiscard}
          onCancel={() => setPendingNav(null)}
        />
      </div>
    </EditorErrorBoundary>
  )
}

function SourceEditor({
  path,
  content,
  saving,
  dirty,
  onChange,
  onSave,
}: {
  path: string
  content: string
  saving: boolean
  dirty: boolean
  onChange: (content: string) => void
  onSave: () => void
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <p className="truncate font-mono text-[11px] text-muted-foreground">{path}</p>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground">
            {dirty ? 'Unsaved changes' : 'Saved'}
          </span>
          <button
            type="button"
            onClick={onSave}
            disabled={saving || !dirty}
            className="inline-flex h-7 items-center rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <textarea
        value={content}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        aria-label="Source editor"
        className="min-h-0 flex-1 resize-none border-0 bg-background p-4 font-mono text-sm leading-6 text-foreground outline-none"
      />
    </div>
  )
}
