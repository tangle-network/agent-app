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
  type MouseEvent,
  type ReactNode,
} from 'react'
import { Download, Trash2 } from 'lucide-react'
import { ConfirmDialog } from './ConfirmDialog'
import type {
  VaultEditorMode,
  VaultFile,
  VaultMarkdownCodec,
  VaultOperation,
  VaultOperationFailure,
  VaultOperationPhase,
  VaultPaneProps,
  VaultRichParts,
  VaultTreeNode,
} from './contracts'

const IDENTITY_CODEC: VaultMarkdownCodec = {
  parse: (raw) => raw,
  serialize: (parts) => (typeof parts === 'string' ? parts : String(parts ?? '')),
}

type PendingNav = { type: 'open'; path: string } | { type: 'close' } | null

interface TreeRefreshContext {
  operation: Extract<VaultOperation, 'list' | 'create' | 'delete'>
  phase: VaultOperationPhase
  path?: string
  selectAfterRecovery?: string
}

interface TreeFailureState {
  failure: VaultOperationFailure
  context: TreeRefreshContext
}

const LIST_CONTEXT: TreeRefreshContext = { operation: 'list', phase: 'operation' }

function operationMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function treeFailureMessage(failure: VaultOperationFailure): string {
  if (failure.phase !== 'post-mutation-refresh') return failure.message
  const completed = failure.operation === 'create' ? 'created' : 'deleted'
  return `The file was ${completed}, but the Vault couldn't refresh. ${failure.message}`
}

function collectFilePaths(nodes: VaultTreeNode[], into: Set<string>): Set<string> {
  for (const node of nodes) {
    if (node.type === 'file') into.add(node.path)
    if (node.children) collectFilePaths(node.children, into)
  }
  return into
}

function resolveFilePath(rawPath: string, filePaths: Set<string>): string | null {
  if (filePaths.has(rawPath)) return rawPath
  const path = rawPath.replace(/^\/+|\/+$/g, '')
  return filePaths.has(path) ? path : null
}

function treeClickPath(event: MouseEvent<HTMLElement>): string | null {
  const path = event.nativeEvent.composedPath?.() ?? []
  for (const item of path) {
    if (!(item instanceof HTMLElement)) continue
    if (item.dataset.type !== 'item') continue
    if (item.dataset.itemType !== 'file') return null
    return item.dataset.itemPath ?? null
  }

  const target = event.target instanceof HTMLElement
    ? event.target.closest('[data-type="item"]')
    : null
  if (!(target instanceof HTMLElement)) return null
  if (target.dataset.itemType !== 'file') return null
  return target.dataset.itemPath ?? null
}

// Case-insensitive name filter over the tree: files survive when their name
// matches; a directory survives whole (with all its children) when its own name
// matches, otherwise only when some descendant survives.
function filterNodes(nodes: VaultTreeNode[], q: string): VaultTreeNode[] {
  const out: VaultTreeNode[] = []
  for (const node of nodes) {
    if (node.type === 'file') {
      if (node.name.toLowerCase().includes(q)) out.push(node)
    } else if (node.name.toLowerCase().includes(q)) {
      out.push(node)
    } else {
      const children = filterNodes(node.children ?? [], q)
      if (children.length > 0) out.push({ ...node, children })
    }
  }
  return out
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

function ReadErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div>
        <h3 className="text-sm font-medium text-foreground">Couldn't open this file</h3>
        <p className="mt-1 max-w-md text-xs text-muted-foreground">{message}</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
      >
        Retry
      </button>
    </div>
  )
}

function TreeErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div>
        <h3 className="text-sm font-medium text-foreground">Couldn't load the Vault</h3>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">{message}</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
      >
        Retry
      </button>
    </div>
  )
}

function OperationErrorAlert({
  message,
  retryLabel,
  onRetry,
  onDismiss,
}: {
  message: string
  retryLabel: string
  onRetry: () => void
  onDismiss: () => void
}) {
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
    >
      <span className="min-w-0 flex-1">{message}</span>
      <div className="flex shrink-0 items-center gap-3">
        <button type="button" aria-label={retryLabel} onClick={onRetry} className="font-medium underline-offset-2 hover:underline">
          Retry
        </button>
        <button type="button" onClick={onDismiss} className="underline-offset-2 hover:underline">
          Dismiss
        </button>
      </div>
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
    onOperationError,
    codec,
    className,
    dockToggle,
    refreshKey,
    headerActions,
    onDownloadFile,
    pathBarClassName,
  } = props

  const activeCodec = codec ?? IDENTITY_CODEC
  const controlled = controlledPath !== undefined
  const isMarkdownCapable = codec !== undefined
  // `false` → a persistent dock (no toggle, always open with the selected file).
  const persistentDock = dockToggle === false
  const dockToggleCfg = dockToggle ? dockToggle : { label: 'Discuss', disabledWhenDirty: true }

  const [tree, setTree] = useState<VaultTreeNode[]>([])
  const [treeLoading, setTreeLoading] = useState(true)
  const [treeLoaded, setTreeLoaded] = useState(false)
  const [treeError, setTreeError] = useState<TreeFailureState | null>(null)
  const [internalPath, setInternalPath] = useState<string | null>(null)
  const selectedPath = controlled ? (controlledPath ?? null) : internalPath

  const [selectedFile, setSelectedFile] = useState<VaultFile | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<VaultOperationFailure | null>(null)

  const [editorMode, setEditorMode] = useState<VaultEditorMode>('rich')
  const [richDraft, setRichDraft] = useState<VaultRichParts>('')
  const [sourceDraft, setSourceDraft] = useState('')
  const [isDirty, setIsDirty] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<VaultOperationFailure | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<VaultOperationFailure | null>(null)
  const [dockOpen, setDockOpen] = useState(false)
  const [pendingNav, setPendingNav] = useState<PendingNav>(null)
  const [query, setQuery] = useState('')

  const savedContentRef = useRef('')
  const loadedPathRef = useRef<string | null>(null)
  const onOperationErrorRef = useRef(onOperationError)
  onOperationErrorRef.current = onOperationError

  const filePaths = useMemo(() => collectFilePaths(tree, new Set<string>()), [tree])
  const resolvedSelectedPath = useMemo(
    () => selectedPath ? resolveFilePath(selectedPath, filePaths) : null,
    [selectedPath, filePaths],
  )
  const treeRoot = useMemo<VaultTreeNode>(
    () => ({ name: 'Vault', path: '', type: 'directory', children: tree }),
    [tree],
  )
  const visibleRoot = useMemo<VaultTreeNode>(() => {
    const q = query.trim().toLowerCase()
    if (!q) return treeRoot
    return { ...treeRoot, children: filterNodes(tree, q) }
  }, [treeRoot, tree, query])

  const commitPath = useCallback(
    (next: string | null) => {
      if (!controlled) setInternalPath(next)
      onSelectedPathChange?.(next)
    },
    [controlled, onSelectedPathChange],
  )

  const reportFailure = useCallback((
    operation: VaultOperation,
    phase: VaultOperationPhase,
    error: unknown,
    fallback: string,
    path?: string,
  ): VaultOperationFailure => {
    const failure: VaultOperationFailure = {
      operation,
      phase,
      path,
      message: operationMessage(error, fallback),
      cause: error,
    }
    try {
      onOperationErrorRef.current?.(failure)
    } catch (callbackError) {
      console.error('Vault onOperationError callback failed:', callbackError)
    }
    return failure
  }, [])

  const refresh = useCallback(async (context: TreeRefreshContext = LIST_CONTEXT): Promise<boolean> => {
    setTreeLoading(true)
    setTreeError(null)
    try {
      setTree(await port.listTree())
      setTreeLoaded(true)
      return true
    } catch (error) {
      const failure = reportFailure(
        context.operation,
        context.phase,
        error,
        'Failed to load the Vault',
        context.path,
      )
      setTreeError({ failure, context })
      return false
    } finally {
      setTreeLoading(false)
    }
  }, [port, reportFailure])

  useEffect(() => {
    setTree([])
    setTreeLoaded(false)
    setTreeError(null)
  }, [port])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshKey])

  const retryTree = useCallback(async () => {
    if (!treeError) return
    const { context } = treeError
    const recovered = await refresh(context)
    if (recovered && context.selectAfterRecovery) commitPath(context.selectAfterRecovery)
  }, [treeError, refresh, commitPath])

  useEffect(() => {
    if (!selectedPath) {
      setSelectedFile(null)
      setFileLoading(false)
      setReadError(null)
      loadedPathRef.current = null
      return
    }
    if (treeLoading || !treeLoaded) return
    if (!resolvedSelectedPath) {
      commitPath(null)
      setSelectedFile(null)
      setFileLoading(false)
      setReadError(null)
      loadedPathRef.current = null
      return
    }
    let cancelled = false
    const path = resolvedSelectedPath
    if (path !== selectedPath) commitPath(path)
    setFileLoading(true)
    setReadError(null)
    void (async () => {
      try {
        const file = await port.readFile(path)
        if (!cancelled) setSelectedFile(file)
      } catch (err) {
        // Surface read failures instead of making them indistinguishable from
        // the intentionally empty "no file selected" state.
        if (!cancelled) {
          const failure = reportFailure('read', 'operation', err, 'Failed to read file', path)
          setSelectedFile(null)
          setReadError(failure.message)
        }
      } finally {
        if (!cancelled) setFileLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [port, selectedPath, resolvedSelectedPath, treeLoading, treeLoaded, refreshKey, reloadNonce, commitPath, reportFailure])

  useEffect(() => {
    if (!selectedFile) {
      loadedPathRef.current = null
      savedContentRef.current = ''
      setRichDraft('')
      setSourceDraft('')
      setEditorMode('rich')
      setIsDirty(false)
      setSaveError(null)
      return
    }
    const pathChanged = loadedPathRef.current !== selectedFile.path
    loadedPathRef.current = selectedFile.path
    savedContentRef.current = selectedFile.content
    setRichDraft(activeCodec.parse(selectedFile.content))
    setSourceDraft(selectedFile.content)
    if (pathChanged) setEditorMode('rich')
    setIsDirty(false)
    setSaveError(null)
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

  // Some tree models keep their original selection callback while resetting
  // paths internally. Keep the callable stable, but have it execute the latest
  // file-path validation and dirty-guard logic.
  const selectFileRef = useRef<(path: string) => void>(() => {})
  selectFileRef.current = (rawPath: string) => {
    const path = resolveFilePath(rawPath, filePaths)
    if (path) {
      guardedOpen(path)
      return
    }
  }
  const handleTreeSelect = useCallback((path: string) => selectFileRef.current(path), [])

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
    setSaveError(null)
    try {
      await port.writeFile(selectedFile.path, content)
      savedContentRef.current = content
      setSelectedFile({ ...selectedFile, content })
      setSourceDraft(content)
      setRichDraft(activeCodec.parse(content))
      setIsDirty(false)
    } catch (error) {
      setSaveError(reportFailure('save', 'operation', error, 'Failed to save file', selectedFile.path))
    } finally {
      setSaving(false)
    }
  }, [selectedFile, editorMode, sourceDraft, richDraft, activeCodec, port, reportFailure])

  const handleCreate = useCallback(async () => {
    const trimmed = newPath.trim()
    if (!trimmed) return
    setCreating(true)
    setCreateError(null)
    try {
      const created = await port.createFile(trimmed)
      setCreateOpen(false)
      setNewPath('')
      const refreshed = await refresh({
        operation: 'create',
        phase: 'post-mutation-refresh',
        path: created,
        selectAfterRecovery: created,
      })
      if (refreshed) commitPath(created)
    } catch (error) {
      setCreateError(reportFailure('create', 'operation', error, 'Failed to create file', trimmed))
    } finally {
      setCreating(false)
    }
  }, [newPath, port, refresh, commitPath, reportFailure])

  const handleDelete = useCallback(async () => {
    if (!selectedFile) return
    const path = selectedFile.path
    setDeleting(true)
    setDeleteError(null)
    try {
      await port.deleteFile(path)
      setDeleteOpen(false)
      setIsDirty(false)
      commitPath(null)
      setSelectedFile(null)
      await refresh({ operation: 'delete', phase: 'post-mutation-refresh', path })
    } catch (error) {
      setDeleteError(reportFailure('delete', 'operation', error, 'Failed to delete file', path))
    } finally {
      setDeleting(false)
    }
  }, [selectedFile, port, refresh, commitPath, reportFailure])

  let treeContent: ReactNode
  if (treeLoading || (!treeLoaded && !treeError)) {
    treeContent = <TreeSkeleton />
  } else if (!treeLoaded && treeError) {
    treeContent = <TreeErrorState message={treeFailureMessage(treeError.failure)} onRetry={() => void retryTree()} />
  } else {
    treeContent = (
      <>
        {treeError && (
          <OperationErrorAlert
            message={treeFailureMessage(treeError.failure)}
            retryLabel="Retry vault refresh"
            onRetry={() => void retryTree()}
            onDismiss={() => setTreeError(null)}
          />
        )}
        {renderTree({
          root: visibleRoot,
          selectedPath: resolvedSelectedPath ?? undefined,
          onSelect: handleTreeSelect,
        })}
      </>
    )
  }

  return (
    <EditorErrorBoundary onReset={() => { commitPath(null); setSelectedFile(null) }}>
      <div className={`flex min-h-0 flex-1 overflow-hidden ${className ?? ''}`}>
        <div className="flex w-[23rem] min-w-[23rem] flex-col border-r border-border bg-background">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <div className="min-w-0 flex-1">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                aria-label="Search vault"
                className="h-8 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-primary/60"
              />
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
                  onClick={() => { setCreateError(null); setCreateOpen(true) }}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                >
                  +
                </button>
              )}
            </div>
          </div>
          <div
            className="flex-1 overflow-y-auto"
            onClickCapture={(event) => {
              const path = treeClickPath(event)
              if (path) handleTreeSelect(path)
            }}
          >
            {treeContent}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {selectedFile && (
            <div className={`flex shrink-0 items-center justify-between border-b border-border px-4 py-1.5 ${pathBarClassName ?? 'bg-card'}`}>
              <span data-vault-path className="truncate text-xs font-medium text-foreground">{selectedFile.path}</span>
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
                {onDownloadFile && (
                  <button
                    type="button"
                    aria-label="Download this file"
                    title="Download file"
                    onClick={() => onDownloadFile(selectedFile)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Download className="h-4 w-4" />
                  </button>
                )}
                {canWrite && (
                  <button
                    type="button"
                    aria-label="Delete this file"
                    title="Delete file"
                    onClick={() => { setDeleteError(null); setDeleteOpen(true) }}
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-destructive/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          )}
          {selectedFile && saveError && (
            <OperationErrorAlert
              message={saveError.message}
              retryLabel="Retry save"
              onRetry={() => void saveCurrent()}
              onDismiss={() => setSaveError(null)}
            />
          )}
          <div className="flex-1 overflow-hidden">
            {fileLoading ? (
              <EditorSkeleton />
            ) : readError ? (
              <ReadErrorState message={readError} onRetry={() => setReloadNonce((n) => n + 1)} />
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
          onCancel={() => { setCreateOpen(false); setNewPath(''); setCreateError(null) }}
        >
          <div className="space-y-2">
            <input
              value={newPath}
              autoFocus
              onChange={(e) => setNewPath(e.target.value)}
              placeholder="e.g. playbooks/new-strategy.md"
              aria-label="New file path"
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-primary/60"
            />
            {createError && <p role="alert" className="text-xs text-destructive">{createError.message}</p>}
          </div>
        </ConfirmDialog>

        <ConfirmDialog
          open={deleteOpen}
          title="Delete file?"
          description={`This permanently removes ${selectedFile?.path ?? 'this file'} from the vault.`}
          confirmLabel={deleting ? 'Deleting…' : 'Delete file'}
          confirmDisabled={deleting}
          destructive
          onConfirm={() => void handleDelete()}
          onCancel={() => { setDeleteOpen(false); setDeleteError(null) }}
        >
          {deleteError && <p role="alert" className="text-xs text-destructive">{deleteError.message}</p>}
        </ConfirmDialog>

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
