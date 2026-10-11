/**
 * The shared 3-pane vault: tree | artifact viewer | optional agent dock. This is
 * shell mechanism — selection, the dirty-guard + pending-nav state machine,
 * rich/source editor modes, create/delete/refresh, skeletons, and an error
 * boundary — plus the vault's tree (sandbox-ui's `VaultTree`) in a contained surface. It
 * renders no artifact viewer of its own: that arrives through the
 * `renderArtifact` / `renderDock` seams, and `renderTree` can replace the tree.
 *
 * Data flows exclusively through `port` (a `VaultDataPort`). The pane never
 * imports a fetch client, a router, a toast system, or a markdown library — the
 * optional `codec` seam supplies rich/source parsing (identity passthrough by
 * default). Chrome uses the shared theme tokens (bg-card, border-border, …).
 */

import {
  Component,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import { Download, FileText, Folder, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { ConfirmDialog } from './ConfirmDialog'
import { readRecentFiles, recordRecentFile } from './recent-files'
import { filterFileNodes, VaultTree } from '@tangle-network/sandbox-ui/vault-tree'
import type {
  VaultEditorMode,
  VaultFile,
  VaultMarkdownCodec,
  VaultOperation,
  VaultOperationFailure,
  VaultOperationPhase,
  VaultPaneHandle,
  VaultPaneProps,
  VaultRichParts,
  VaultTreeNode,
} from './contracts'
import { ShellHeader } from '@tangle-network/sandbox-ui/workspace'

/** Narrowest pane that places a dock beside the document rather than in it. */
const DOCK_SIDE_MIN_PX = 960

/** Square header action on the control scale's small step, a touch target on coarse pointers. */
const TREE_ICON_BUTTON = 'inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:size-10'

const IDENTITY_CODEC: VaultMarkdownCodec = {
  parse: (raw) => raw,
  serialize: (parts) => (typeof parts === 'string' ? parts : String(parts ?? '')),
}

type PendingNav = { path: string; request?: PendingOpen } | null
type PendingOpen = {
  path: string
  fromPath: string | null
  resolve: (opened: boolean) => void
  loaded: boolean
  selected: boolean
}

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

function treeFailureMessage(failure: VaultOperationFailure, label: string): string {
  if (failure.phase !== 'post-mutation-refresh') return failure.message
  const completed = failure.operation === 'create' ? 'created' : 'deleted'
  return `The file was ${completed}, but ${label} couldn't refresh. ${failure.message}`
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

class EditorErrorBoundary extends Component<{ children: ReactNode; label: string; onReset?: () => void }, { error: unknown }> {
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
          : `${this.props.label} did not load. Reload the page to try again.`
      return (
        <div className="flex h-full flex-1 flex-col items-center justify-center p-8 text-center">
          <h3 className="mb-1 text-sm font-medium text-foreground">{this.props.label} failed to load</h3>
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

function TreeErrorState({ label, message, onRetry }: { label: string; message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div>
        <h3 className="text-sm font-medium text-foreground">Couldn't load {label}</h3>
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

/**
 * The tree pane when the vault holds nothing at all. It sits under the header
 * whose controls add files, so it names the state and offers the same action
 * instead of leaving a blank column under a search box with nothing to search.
 */
function TreeEmptyState({ canCreate, onCreate }: { canCreate: boolean; onCreate: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div>
        <h3 className="text-sm font-medium text-foreground">No files yet</h3>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
          {canCreate ? 'Create a file to start.' : 'Files appear here once they are added.'}
        </p>
      </div>
      {canCreate && (
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          New file
        </button>
      )}
    </div>
  )
}

function TreeNoMatchState({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 p-6 text-center">
      <p className="max-w-xs break-words text-xs text-muted-foreground">No files match “{query}”.</p>
      <button
        type="button"
        onClick={onClear}
        className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
      >
        Clear search
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
      className="flex shrink-0 items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-[var(--surface-danger-text)]"
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

/** How many recent files the empty document pane offers. */
const RECENT_SHOWN = 5

/**
 * The document pane with nothing open: says what to do, and offers the files
 * this reader opened last in this vault so returning work is one click away.
 */
function DocumentEmptyState({ label, recent, onOpen }: { label: string; recent: string[]; onOpen: (path: string) => void }) {
  const recentHeadingId = useId()
  return (
    <div data-vault-document-empty className="flex h-full items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-sm text-center">
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <FileText className="size-5" aria-hidden="true" />
        </span>
        <h3 className="mt-4 text-base font-semibold text-foreground">Select a file</h3>
        <p className="mt-1 text-sm text-muted-foreground">Choose a file in {label} to open it here.</p>
        {recent.length > 0 && (
          <section aria-labelledby={recentHeadingId} className="mt-8 text-left">
            <h4 id={recentHeadingId} className="text-xs font-medium text-muted-foreground">Recently opened</h4>
            <ul className="mt-2 overflow-hidden rounded-xl border border-border bg-card shadow-raised">
              {recent.map((path) => {
                const slash = path.lastIndexOf('/')
                return (
                  <li key={path} className="border-b border-border last:border-b-0">
                    <button
                      type="button"
                      onClick={() => onOpen(path)}
                      title={path}
                      className="flex min-h-10 w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 truncate font-medium">{path.slice(slash + 1)}</span>
                      {slash > 0 && <span className="ml-auto min-w-0 shrink truncate text-xs text-muted-foreground">{path.slice(0, slash)}</span>}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}

/**
 * Browse and edit files in the available pane width.
 * Below 45rem, Files and the selected document share one pane.
 * Switching panes keeps the editor mounted and preserves unsaved changes.
 */
export const VaultPane = forwardRef<VaultPaneHandle, VaultPaneProps>(function VaultPane(props, ref) {
  const {
    port,
    renderTree,
    treeStateKey,
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
    label = 'Vault',
    emptyState,
    treeEmptyState,
    dockLabel = 'Details',
    fileActions,
  } = props
  const noun = label.toLowerCase()
  const canCreate = canWrite && (props.canCreate ?? true)
  const canDelete = canWrite && (props.canDelete ?? true)

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
  const [filesOpen, setFilesOpen] = useState(false)
  const showFiles = filesOpen || !selectedPath
  const searchRef = useRef<HTMLInputElement>(null)
  const documentRef = useRef<HTMLDivElement>(null)
  const treeHeadingId = useId()
  const [recentFiles, setRecentFiles] = useState(() => ({ key: treeStateKey, paths: readRecentFiles(treeStateKey) }))
  if (recentFiles.key !== treeStateKey) setRecentFiles({ key: treeStateKey, paths: readRecentFiles(treeStateKey) })

  useEffect(() => {
    setFilesOpen(false)
  }, [selectedPath])

  const showDocument = useCallback(() => {
    const focused = document.activeElement
    setFilesOpen(false)
    requestAnimationFrame(() => {
      if (document.activeElement === focused || document.activeElement === document.body) {
        documentRef.current?.focus({ preventScroll: true })
      }
    })
  }, [])

  const [selectedFile, setSelectedFile] = useState<VaultFile | null>(null)
  const [displayReadyPath, setDisplayReadyPath] = useState<string | null>(null)
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
  // Below DOCK_SIDE_MIN_PX of pane width a side dock squeezes the document to
  // nothing (measured on Legal at 390px: the review panel took the whole width
  // and the document and its Files switcher were unreachable). There the dock
  // opens IN the document pane instead, behind a path-bar toggle. Measured, not
  // a media query: the pane is often a drawer or a split inside a wide window.
  const rootRef = useRef<HTMLDivElement>(null)
  const [dockInline, setDockInline] = useState(false)
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || !renderDock || typeof ResizeObserver === 'undefined') return
    const apply = (width: number) => { if (width > 0) setDockInline(width < DOCK_SIDE_MIN_PX) }
    apply(root.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => apply(entries[0]?.contentRect.width ?? 0))
    observer.observe(root)
    return () => observer.disconnect()
  }, [renderDock])
  const [pendingNav, setPendingNav] = useState<PendingNav>(null)
  const [query, setQuery] = useState('')
  const [folderPath, setFolderPath] = useState<string | null>(null)

  const dirtyRef = useRef(isDirty)
  dirtyRef.current = isDirty
  const treeRequestRef = useRef(0)
  const savedContentRef = useRef('')
  const loadedPathRef = useRef<string | null>(null)
  const onOperationErrorRef = useRef(onOperationError)
  onOperationErrorRef.current = onOperationError
  const pendingOpenRef = useRef<PendingOpen | null>(null)
  const previousPortRef = useRef(port)

  const finishPendingOpen = useCallback((opened: boolean, clearNavigation = true) => {
    const pending = pendingOpenRef.current
    if (!pending) return
    pendingOpenRef.current = null
    if (!opened && clearNavigation) {
      setPendingNav((current) => current?.request === pending ? null : current)
    }
    pending.resolve(opened)
  }, [])

  useEffect(() => () => finishPendingOpen(false, false), [finishPendingOpen])

  useEffect(() => {
    if (previousPortRef.current !== port) finishPendingOpen(false)
    previousPortRef.current = port
  }, [port, finishPendingOpen])

  useEffect(() => {
    const pending = pendingOpenRef.current
    if (!pending) return
    if (selectedPath === pending.path) pending.selected = true
    else if (pending.selected || selectedPath !== pending.fromPath) finishPendingOpen(false)
  }, [selectedPath, finishPendingOpen])

  const treePaths = useMemo(
    () => collectTreePaths(tree, { files: new Set<string>(), directories: new Set<string>() }),
    [tree],
  )
  const resolvedSelectedPath = useMemo(() => {
    if (!selectedPath) return null
    const listed = resolveTreePath(selectedPath, treePaths)
    if (listed?.type === 'directory') return null
    // A committed file can be readable before an older tree snapshot lists it.
    // The data port owns validation and missing-file errors for explicit paths.
    return listed?.path ?? selectedPath
  }, [selectedPath, treePaths])
  // The clicked folder, resolved against the CURRENT tree — a folder that a
  // refresh removed stops being the active one on its own, so neither the
  // search scope nor the create target can point at a directory that is gone.
  const activeFolderNode = useMemo(
    () => (folderPath ? findDirectory(tree, folderPath) : null),
    [tree, folderPath],
  )
  const activeFolder = activeFolderNode?.path ?? null
  const treeRoot = useMemo<VaultTreeNode>(
    () => ({ name: label, path: '', type: 'directory', children: tree }),
    [tree, label],
  )
  // With no query the whole vault stays on screen: the tree owns expansion, so
  // re-rooting on a plain folder click would fight the expand the click already
  // performs. The folder scopes the SEARCH, which is where a narrowed list is
  // what the reader asked for.
  const visibleRoot = useMemo<VaultTreeNode>(() => {
    const q = query.trim().toLowerCase()
    if (!q) return treeRoot
    const base = activeFolderNode ?? treeRoot
    return { ...base, children: filterFileNodes(base.children ?? [], q) }
  }, [treeRoot, activeFolderNode, query])

  const commitPath = useCallback(
    (next: string | null) => {
      if (controlled) {
        const decision: unknown = onSelectedPathChange?.(next)
        return decision !== false
      }
      setInternalPath(next)
      onSelectedPathChange?.(next)
      return true
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
    const request = ++treeRequestRef.current
    setTreeLoading(true)
    setTreeError(null)
    try {
      const nextTree = await port.listTree()
      if (request !== treeRequestRef.current) return false
      setTree(nextTree)
      setTreeLoaded(true)
      return true
    } catch (error) {
      if (request !== treeRequestRef.current) return false
      const failure = reportFailure(
        context.operation,
        context.phase,
        error,
        `Failed to load ${label}`,
        context.path,
      )
      setTreeError({ failure, context })
      return false
    } finally {
      if (request === treeRequestRef.current) setTreeLoading(false)
    }
  }, [port, reportFailure, label])

  useEffect(() => {
    setTree([])
    setTreeLoaded(false)
    setTreeError(null)
    setSelectedFile(null)
  }, [port])

  useEffect(() => {
    void refresh()
    return () => { treeRequestRef.current += 1 }
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
    // An external path can be read after listing fails; the data port still validates access.
    const explicitOpenAfterTreeError = !!treeError && pendingOpenRef.current?.path === selectedPath
    if (treeLoading || (!treeLoaded && !explicitOpenAfterTreeError) || isDirty || saving) return
    if (!resolvedSelectedPath) {
      finishPendingOpen(false)
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
        if (file.path !== path) throw new Error(`Vault returned ${file.path} for ${path}`)
        if (!cancelled && !dirtyRef.current) {
          const pending = pendingOpenRef.current
          if (pending?.path === path) pending.loaded = true
          setSelectedFile(file)
        } else if (!cancelled && pendingOpenRef.current?.path === path) {
          finishPendingOpen(false)
        }
      } catch (err) {
        // Surface read failures instead of making them indistinguishable from
        // the intentionally empty "no file selected" state.
        if (!cancelled) {
          if (pendingOpenRef.current?.path === path) finishPendingOpen(false)
          const failure = reportFailure('read', 'operation', err, 'Failed to read file', path)
          setSelectedFile((current) => current?.path === path ? current : null)
          setReadError(failure.message)
        }
      } finally {
        if (!cancelled) setFileLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [port, selectedPath, resolvedSelectedPath, treeLoading, treeLoaded, treeError, isDirty, saving, reloadNonce, commitPath, reportFailure, finishPendingOpen])

  useEffect(() => {
    if (!selectedFile) {
      loadedPathRef.current = null
      setDisplayReadyPath(null)
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
    setDisplayReadyPath(selectedFile.path)
    savedContentRef.current = selectedFile.content
    setRichDraft(activeCodec.parse(selectedFile.content))
    setSourceDraft(selectedFile.content)
    if (pathChanged) setEditorMode('rich')
    setIsDirty(false)
    setSaveError(null)
    setDockOpen(false)
  }, [selectedFile?.path, selectedFile?.content, activeCodec])

  useEffect(() => {
    const pending = pendingOpenRef.current
    if (
      pending?.loaded &&
      pending.path === selectedPath &&
      selectedFile?.path === pending.path &&
      displayReadyPath === pending.path &&
      sourceDraft === selectedFile.content &&
      !fileLoading
    ) {
      finishPendingOpen(true)
    }
  }, [selectedPath, selectedFile, displayReadyPath, sourceDraft, fileLoading, finishPendingOpen])

  const guardedOpen = useCallback((rawPath: string, resolve?: (opened: boolean) => void) => {
    const target = resolveTreePath(rawPath, treePaths)
    if (!rawPath.trim() || target?.type === 'directory') {
      resolve?.(false)
      return
    }
    const path = target?.path ?? rawPath
    finishPendingOpen(false)
    setPendingNav(null)
    if (path === selectedPath && selectedFile?.path === path && displayReadyPath === path) {
      showDocument()
      resolve?.(true)
      return
    }
    if (resolve) {
      const pending: PendingOpen = {
        path,
        fromPath: selectedPath,
        resolve,
        loaded: false,
        selected: path === selectedPath,
      }
      pendingOpenRef.current = pending
    }
    if (path === selectedPath) {
      showDocument()
      if (!fileLoading && (readError || (treeError && !treeLoaded))) setReloadNonce((nonce) => nonce + 1)
      return
    }
    if (isDirty) {
      setPendingNav({ path, request: resolve ? pendingOpenRef.current ?? undefined : undefined })
      return
    }
    showDocument()
    if (commitPath(path) === false) finishPendingOpen(false)
  }, [finishPendingOpen, treePaths, selectedPath, selectedFile, displayReadyPath, fileLoading, showDocument, readError, treeError, treeLoaded, isDirty, commitPath])

  useImperativeHandle(ref, () => ({
    openFile: (path) => new Promise<boolean>((resolve) => guardedOpen(path, resolve)),
  }), [guardedOpen])

  // Clicking a folder makes it the vault's active folder: the search narrows to
  // it and a new file lands inside it. Clicking it again clears that — the same
  // row is the way back out, so the gesture is reversible where it was made.
  const toggleFolder = useCallback((path: string) => {
    setFolderPath((current) => (current === path ? null : path))
  }, [])
  // The built-in tree reports the folder's new state: expanding a folder makes
  // it active, and collapsing the active folder or one around it clears it.
  const handleFolderToggle = useCallback((path: string, expanded: boolean) => {
    setFolderPath((current) => {
      if (expanded) return path
      return current && (current === path || current.startsWith(`${path}/`)) ? null : current
    })
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

  const confirmDiscard = useCallback(() => {
    const nav = pendingNav
    setPendingNav(null)
    if (!nav) return
    if (nav.request && pendingOpenRef.current !== nav.request) return
    if (!commitPath(nav.path)) {
      finishPendingOpen(false)
      return
    }
    setIsDirty(false)
    showDocument()
  }, [pendingNav, commitPath, showDocument, finishPendingOpen])

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
    dirtyRef.current = next !== savedContentRef.current
    setSourceDraft(next)
    setIsDirty(dirtyRef.current)
  }, [])

  const onRichChange = useCallback((next: VaultRichParts) => {
    dirtyRef.current = activeCodec.serialize(next) !== savedContentRef.current
    setRichDraft(next)
    setIsDirty(dirtyRef.current)
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

  // A file counts as opened once it is on screen, not when it is requested.
  // It is recorded in the commit that first shows it: `displayReadyPath` trails
  // that commit by one render, so a pane closed right after showing a file
  // (or a reader who navigates away at once) lost the record.
  const shownPath = selectedFile?.path ?? null
  useEffect(() => {
    if (!shownPath || !treeStateKey) return
    setRecentFiles({ key: treeStateKey, paths: recordRecentFile(treeStateKey, shownPath) })
  }, [shownPath, treeStateKey])
  const recentToOffer = recentFiles.paths
    .filter((path) => path !== selectedPath && treePaths.files.has(path))
    .slice(0, RECENT_SHOWN)

  const createFileName = newPath.trim().split('/').pop()?.trim() ?? ''
  const dockButtonLabel = persistentDock ? dockLabel : dockToggleCfg.label
  const dockBlockedByDraft = !persistentDock && (dockToggleCfg.disabledWhenDirty ?? true) && isDirty
  const openCreate = () => { setCreateError(null); setNewPath(activeFolder ? `${activeFolder}/` : ''); setCreateOpen(true) }
  // Loading, empty and filled vaults share one geometry (tree column, search,
  // document pane), so the pane never jumps when the first listing answers: an
  // empty-vault layout measured CLS 0.38 on Hospitality's Files page.
  const vaultEmpty = treeLoaded && treePaths.files.size === 0 && treePaths.directories.size === 0
  const trimmedQuery = query.trim()

  let treeContent: ReactNode
  if (!treeLoaded && (treeLoading || !treeError)) {
    treeContent = <TreeSkeleton />
  } else if (!treeLoaded && treeError) {
    treeContent = <TreeErrorState label={label} message={treeFailureMessage(treeError.failure, label)} onRetry={() => void retryTree()} />
  } else {
    treeContent = (
      <>
        {treeError && (
          <OperationErrorAlert
            message={treeFailureMessage(treeError.failure, label)}
            retryLabel={`Retry ${noun} refresh`}
            onRetry={() => void retryTree()}
            onDismiss={() => setTreeError(null)}
          />
        )}
        {vaultEmpty && !trimmedQuery
          ? (treeEmptyState !== undefined ? treeEmptyState : <TreeEmptyState canCreate={canCreate} onCreate={openCreate} />)
          : trimmedQuery && (visibleRoot.children?.length ?? 0) === 0
            ? <TreeNoMatchState query={trimmedQuery} onClear={() => setQuery('')} />
            : renderTree
              ? renderTree({
                root: visibleRoot,
                selectedPath: resolvedSelectedPath ?? undefined,
                onSelect: handleTreeSelect,
              })
              : (
                <VaultTree
                  root={visibleRoot}
                  selectedPath={resolvedSelectedPath ?? undefined}
                  activeFolder={activeFolder}
                  onSelect={handleTreeSelect}
                  onFolderToggle={handleFolderToggle}
                  storageKey={treeStateKey}
                  expandAll={!!trimmedQuery}
                  label={label}
                />
              )}
      </>
    )
  }

  return (
    <EditorErrorBoundary label={label} onReset={() => { commitPath(null); setSelectedFile(null) }}>
      <div ref={rootRef} className={`flex min-h-0 min-w-0 flex-1 overflow-hidden ${className ?? ''}`}>
        <div className="@container/vault flex min-w-0 flex-1 flex-col">
          {/* The pane switcher exists only while there is a document to switch
              to; with nothing selected the Files pane is already all there is,
              and a lone Files chip would be a control that does nothing. */}
          {selectedPath && (
          <nav aria-label={`${label} navigation`} className="flex shrink-0 items-center gap-1 border-b border-border p-2 @[45rem]/vault:hidden">
            <button
              type="button"
              aria-pressed={showFiles}
              onClick={() => {
                const focused = document.activeElement
                setFilesOpen(true)
                requestAnimationFrame(() => {
                  if (document.activeElement === focused || document.activeElement === document.body) {
                    searchRef.current?.focus()
                  }
                })
              }}
              className={`shrink-0 rounded-md px-3 py-2 text-sm ${showFiles ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted'}`}
            >
              Files
            </button>
            {selectedPath && (
              <button
                type="button"
                aria-pressed={!showFiles}
                onClick={showDocument}
                title={selectedPath}
                className={`min-w-0 truncate rounded-md px-3 py-2 text-sm ${!showFiles ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted'}`}
              >
                {selectedPath.split('/').pop()}
              </button>
            )}
          </nav>
          )}
          <div className="flex min-h-0 min-w-0 flex-1">
            <div data-vault-tree className={`${showFiles ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col p-2 @[45rem]/vault:flex @[45rem]/vault:p-3 @[45rem]/vault:w-[23rem] @[45rem]/vault:min-w-[23rem] @[45rem]/vault:flex-none`}>
              {/* The tree is its own surface: a card on the page background,
                  so the file list reads as a finished panel rather than
                  text floating on the canvas. */}
              <section
                aria-labelledby={treeHeadingId}
                data-vault-tree-surface
                className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-raised"
              >
                <div className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-3">
                  <h2 id={treeHeadingId} className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                    {label}
                  </h2>
                  <div className="flex shrink-0 items-center gap-1">
                    {headerActions}
                    <button
                      type="button"
                      aria-label={`Refresh ${noun}`}
                      title="Refresh"
                      onClick={() => void refresh()}
                      className={`${TREE_ICON_BUTTON} text-muted-foreground hover:bg-muted hover:text-foreground`}
                    >
                      <RefreshCw className="size-4" aria-hidden="true" />
                    </button>
                    {canCreate && (
                      <button
                        type="button"
                        title="New file"
                        aria-label={activeFolder ? `New file in ${activeFolder}` : 'New file'}
                        onClick={openCreate}
                        className={`${TREE_ICON_BUTTON} bg-primary text-primary-foreground hover:bg-primary/90`}
                      >
                        <Plus className="size-4" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
                <div className="shrink-0 px-3 pb-2">
                  <input
                    ref={searchRef}
                    type="search"
                    disabled={vaultEmpty}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={activeFolder ? `Search ${activeFolder}…` : `Search ${noun}…`}
                    aria-label={`Search ${noun}`}
                    className="h-8 w-full rounded-md border border-border bg-input px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:text-base"
                  />
                </div>
                {activeFolder && (
                  <div className="mx-3 mb-2 flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs">
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span data-vault-folder className="min-w-0 flex-1 truncate font-medium text-foreground" title={activeFolder}>
                      {activeFolder}
                    </span>
                    <button
                      type="button"
                      aria-label="Clear the active folder"
                      onClick={() => setFolderPath(null)}
                      className="shrink-0 rounded px-1 text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Clear
                    </button>
                  </div>
                )}
                <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-1.5 py-1.5">
                  {treeContent}
                </div>
              </section>
            </div>

            <div
              ref={documentRef}
              role="region"
              aria-label={`${label} document`}
              tabIndex={-1}
              className={`${showFiles ? 'hidden' : 'flex'} min-w-0 flex-1 flex-col overflow-hidden @[45rem]/vault:flex`}
            >
              {selectedFile && (
                <ShellHeader className={`justify-between gap-2 px-4 ${pathBarClassName ?? 'bg-card'}`}>
                  <span data-vault-path className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{selectedFile.path}</span>
                  <div className="flex shrink-0 items-center gap-1">
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
                    {renderDock && (!persistentDock || dockInline) && (
                      <button
                        type="button"
                        aria-label={dockButtonLabel}
                        aria-pressed={dockOpen}
                        disabled={dockBlockedByDraft}
                        title={dockBlockedByDraft ? 'Save your changes first' : (persistentDock ? dockLabel : (dockToggleCfg.title ?? dockToggleCfg.label))}
                        onClick={() => setDockOpen((v) => !v)}
                        className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors disabled:pointer-events-none disabled:opacity-40 ${
                          dockOpen
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                        }`}
                      >
                        {dockButtonLabel}
                      </button>
                    )}
                    {fileActions?.(selectedFile)}
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
                    {canDelete && (
                      <button
                        type="button"
                        aria-label="Delete this file"
                        title="Delete file"
                        onClick={() => { setDeleteError(null); setDeleteOpen(true) }}
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--surface-danger-text)] transition-colors hover:bg-destructive/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </ShellHeader>
              )}
              {selectedFile && saveError && (
                <OperationErrorAlert
                  message={saveError.message}
                  retryLabel="Retry save"
                  onRetry={() => void saveCurrent()}
                  onDismiss={() => setSaveError(null)}
                />
              )}
              {readError && selectedFile?.path === resolvedSelectedPath && (
                <OperationErrorAlert
                  message={readError}
                  retryLabel="Retry file refresh"
                  onRetry={() => setReloadNonce((n) => n + 1)}
                  onDismiss={() => setReadError(null)}
                />
              )}
              <div className="flex-1 overflow-hidden">
                {fileLoading && selectedFile?.path !== resolvedSelectedPath ? (
                  <EditorSkeleton />
                ) : readError && selectedFile?.path !== resolvedSelectedPath ? (
                  <ReadErrorState message={readError} onRetry={() => setReloadNonce((n) => n + 1)} />
                ) : selectedFile && renderDock && dockInline && dockOpen ? (
                  <div data-vault-dock="inline" className="flex h-full min-h-0 flex-col overflow-y-auto">
                    {renderDock({ file: selectedFile, open: true, onClose: () => setDockOpen(false), placement: 'inline' })}
                  </div>
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
                ) : emptyState !== undefined ? emptyState : (
                  <DocumentEmptyState label={label} recent={recentToOffer} onOpen={(path) => guardedOpen(path)} />
                )}
              </div>
            </div>
          </div>
        </div>

        {renderDock && selectedFile && !dockInline && renderDock({
          file: selectedFile,
          open: persistentDock ? true : dockOpen,
          onClose: persistentDock ? () => {} : () => setDockOpen(false),
          placement: 'side',
        })}

        <ConfirmDialog
          open={createOpen}
          title="Create file"
          description={activeFolder ? `Add a new document to ${activeFolder}.` : `Add a new document to ${label}.`}
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
            {createError && <p role="alert" className="text-xs text-[var(--surface-danger-text)]">{createError.message}</p>}
          </div>
        </ConfirmDialog>

        <ConfirmDialog
          open={deleteOpen}
          title="Delete file?"
          description={`This permanently removes ${selectedFile?.path ?? 'this file'} from ${label}.`}
          confirmLabel={deleting ? 'Deleting…' : 'Delete file'}
          confirmDisabled={deleting}
          destructive
          onConfirm={() => void handleDelete()}
          onCancel={() => { setDeleteOpen(false); setDeleteError(null) }}
        >
          {deleteError && <p role="alert" className="text-xs text-[var(--surface-danger-text)]">{deleteError.message}</p>}
        </ConfirmDialog>

        <ConfirmDialog
          open={pendingNav !== null}
          title="Discard unsaved changes?"
          description="Your edits to this document haven't been saved. Continue and lose them?"
          confirmLabel="Discard changes"
          destructive
          onConfirm={confirmDiscard}
          onCancel={() => { finishPendingOpen(false); setPendingNav(null) }}
        />
      </div>
    </EditorErrorBoundary>
  )
})

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
