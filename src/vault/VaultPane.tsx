/**
 * The shared 3-pane vault: tree | artifact viewer | optional agent dock. This is
 * pure shell MECHANISM — selection, the dirty-guard + pending-nav state machine,
 * rich/source editor modes, create/delete/refresh, skeletons, and an error
 * boundary. It renders NO file tree and NO artifact viewer of its own:
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
import { Download, Folder, Trash2 } from 'lucide-react'
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

interface TreePaths {
  files: Set<string>
  directories: Set<string>
}

// Directories are collected alongside files because a click on one has to be
// RECOGNIZED to be answered — dropping them here is what made a folder row a
// dead target: the path resolved to nothing and every downstream branch was
// keyed on a file.
function collectTreePaths(nodes: VaultTreeNode[], into: TreePaths): TreePaths {
  for (const node of nodes) {
    if (node.type === 'file') into.files.add(node.path)
    else into.directories.add(node.path)
    if (node.children) collectTreePaths(node.children, into)
  }
  return into
}

function resolveFilePath(rawPath: string, filePaths: Set<string>): string | null {
  if (filePaths.has(rawPath)) return rawPath
  const path = rawPath.replace(/^\/+|\/+$/g, '')
  return filePaths.has(path) ? path : null
}

function resolveTreePath(rawPath: string, paths: TreePaths): { path: string; type: 'file' | 'directory' } | null {
  const file = resolveFilePath(rawPath, paths.files)
  if (file) return { path: file, type: 'file' }
  if (paths.directories.has(rawPath)) return { path: rawPath, type: 'directory' }
  const trimmed = rawPath.replace(/^\/+|\/+$/g, '')
  return paths.directories.has(trimmed) ? { path: trimmed, type: 'directory' } : null
}

function findDirectory(nodes: VaultTreeNode[], path: string): VaultTreeNode | null {
  for (const node of nodes) {
    if (node.type === 'directory' && node.path === path) return node
    const found = node.children ? findDirectory(node.children, path) : null
    if (found) return found
  }
  return null
}

/** The clicked tree row, files and directories alike. The type travels with the
 *  path so the caller routes on it instead of discarding everything that is not
 *  a file. */
function treeClickTarget(event: MouseEvent<HTMLElement>): { path: string; type: string } | null {
  const read = (el: HTMLElement) => {
    const path = el.dataset.itemPath
    return path ? { path, type: el.dataset.itemType ?? '' } : null
  }

  const path = event.nativeEvent.composedPath?.() ?? []
  for (const item of path) {
    if (!(item instanceof HTMLElement)) continue
    if (item.dataset.type !== 'item') continue
    return read(item)
  }

  const target = event.target instanceof HTMLElement
    ? event.target.closest('[data-type="item"]')
    : null
  return target instanceof HTMLElement ? read(target) : null
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
            className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * A skeleton is a picture of a wait, and a picture is exactly what a screen
 * reader cannot see. `aria-hidden` on the shimmer bars is right — they carry no
 * information — but hiding them without saying anything else is what left the
 * whole load silent. The container announces the wait instead: `aria-busy` for
 * the state, a `status` live region so arrival is reported, and a real text
 * label, since a live region with only decorative children announces nothing.
 */
function SkeletonRegion({ label, className, children }: { label: string; className: string; children: ReactNode }) {
  // The live region is a SIBLING of the shimmer, not a wrapper around it: the
  // shimmer container keeps its exact classes and its exact position in the
  // parent's layout, so adding the announcement cannot move a pixel. Wrapping
  // it would put a new box between `space-y-*` and the bars it spaces.
  return (
    <>
      <span role="status" aria-live="polite" aria-busy={true} className="sr-only">
        {label}
      </span>
      <div className={className} aria-hidden="true">
        {children}
      </div>
    </>
  )
}

function TreeSkeleton() {
  return (
    <SkeletonRegion label="Loading files…" className="space-y-2 p-4">
      {[32, 48, 40, 52].map((w, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-muted" style={{ width: `${w * 4}px` }} />
      ))}
    </SkeletonRegion>
  )
}

function EditorSkeleton() {
  return (
    <SkeletonRegion label="Loading file…" className="space-y-3 p-8">
      <div className="h-5 w-1/2 animate-pulse rounded bg-muted" />
      <div className="h-4 w-full animate-pulse rounded bg-muted" />
      <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
    </SkeletonRegion>
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
        className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
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
        className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
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
  const [folderPath, setFolderPath] = useState<string | null>(null)

  const savedContentRef = useRef('')
  const loadedPathRef = useRef<string | null>(null)
  const onOperationErrorRef = useRef(onOperationError)
  onOperationErrorRef.current = onOperationError

  const treePaths = useMemo(
    () => collectTreePaths(tree, { files: new Set<string>(), directories: new Set<string>() }),
    [tree],
  )
  const filePaths = treePaths.files
  const resolvedSelectedPath = useMemo(
    () => selectedPath ? resolveFilePath(selectedPath, filePaths) : null,
    [selectedPath, filePaths],
  )
  // The clicked folder, resolved against the CURRENT tree — a folder that a
  // refresh removed stops being the active one on its own, so neither the
  // search scope nor the create target can point at a directory that is gone.
  const activeFolderNode = useMemo(
    () => (folderPath ? findDirectory(tree, folderPath) : null),
    [tree, folderPath],
  )
  const activeFolder = activeFolderNode?.path ?? null
  const treeRoot = useMemo<VaultTreeNode>(
    () => ({ name: 'Vault', path: '', type: 'directory', children: tree }),
    [tree],
  )
  // With no query the whole vault stays on screen: the tree renderer owns
  // expansion (both sandbox-ui trees keep it internal), so re-rooting on a
  // plain folder click would fight the expand the click already performs. The
  // folder scopes the SEARCH, which is where a narrowed list is what the reader
  // asked for.
  const visibleRoot = useMemo<VaultTreeNode>(() => {
    const q = query.trim().toLowerCase()
    if (!q) return treeRoot
    const base = activeFolderNode ?? treeRoot
    return { ...base, children: filterNodes(base.children ?? [], q) }
  }, [treeRoot, activeFolderNode, query])

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

  // Clicking a folder makes it the vault's active folder: the search narrows to
  // it and a new file lands inside it. Clicking it again clears that — the same
  // row is the way back out, so the gesture is reversible where it was made.
  const toggleFolder = useCallback((path: string) => {
    setFolderPath((current) => (current === path ? null : path))
  }, [])

  // Some tree models keep their original selection callback while resetting
  // paths internally. Keep the callable stable, but have it execute the latest
  // path validation and dirty-guard logic.
  const selectFileRef = useRef<(path: string) => void>(() => {})
  selectFileRef.current = (rawPath: string) => {
    const target = resolveTreePath(rawPath, treePaths)
    if (!target) return
    if (target.type === 'file') {
      guardedOpen(target.path)
      return
    }
    toggleFolder(target.path)
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
    // Same rule as the confirm button, enforced here too: the dialog can also be
    // confirmed by keyboard, and a directory path is not a file to create.
    if (!trimmed || !(trimmed.split('/').pop()?.trim())) return
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

  const createFileName = newPath.trim().split('/').pop()?.trim() ?? ''

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
                placeholder={activeFolder ? `Search ${activeFolder}…` : 'Search…'}
                aria-label="Search vault"
                className="h-8 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {headerActions}
              <button
                type="button"
                aria-label="Refresh vault"
                onClick={() => void refresh()}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                ↻
              </button>
              {canWrite && (
                <button
                  type="button"
                  aria-label={activeFolder ? `New vault file in ${activeFolder}` : 'New vault file'}
                  onClick={() => { setCreateError(null); setNewPath(activeFolder ? `${activeFolder}/` : ''); setCreateOpen(true) }}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  +
                </button>
              )}
            </div>
          </div>
          {activeFolder && (
            <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-4 py-1.5 text-xs">
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span data-vault-folder className="min-w-0 flex-1 truncate font-medium text-foreground" title={activeFolder}>
                {activeFolder}
              </span>
              <button
                type="button"
                aria-label="Clear the active folder"
                onClick={() => setFolderPath(null)}
 className="shrink-0 rounded px-1 text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
              >
                Clear
              </button>
            </div>
          )}
          <div
            className="flex-1 overflow-y-auto"
            onClickCapture={(event) => {
              const target = treeClickTarget(event)
              if (target) handleTreeSelect(target.path)
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
            ) : null}
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
          description={activeFolder ? `Add a new document to ${activeFolder}.` : 'Add a new document to this vault.'}
          confirmLabel={creating ? 'Creating…' : 'Create'}
          // A prefilled folder is a path with no file name yet, so emptiness is
          // not the test — `folder/` would otherwise be sent to the port as a
          // file to create.
          confirmDisabled={creating || !createFileName}
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
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
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
        <p className="truncate font-mono text-xs text-muted-foreground">{path}</p>
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
        // Full-bleed editor: keep the floor's ring but draw it inside the border
        // box, since an outward ring on a `flex-1` pane child is clipped.
        className="min-h-0 flex-1 resize-none border-0 bg-background p-4 font-mono text-sm leading-6 text-foreground focus-visible:[outline-offset:-2px]"
      />
    </div>
  )
}
