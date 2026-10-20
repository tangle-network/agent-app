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

import { forwardRef, useCallback, useEffect, useImperativeHandle, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { VaultTree } from '@tangle-network/sandbox-ui/vault-tree'
import { ConfirmDialog } from './ConfirmDialog'
import { SourceEditor } from './SourceEditor'
import { VaultHistoryPanel } from './VaultHistoryPanel'
import { VaultContentResults } from './VaultContentResults'
import { DocumentEmptyState, EditorErrorBoundary, EditorSkeleton, OperationErrorAlert, ReadErrorState, TreeEmptyState, TreeErrorState, TreeNoMatchState, TreeSkeleton, treeFailureMessage, operationMessage } from './VaultPaneStates'
import { VaultDocumentToolbar } from './VaultDocumentToolbar'
import { VaultTreePanel } from './VaultTreePanel'
import { VaultPaneNavigation } from './VaultPaneNavigation'
import { VaultCreateDialog } from './VaultCreateDialog'
import { useVaultSearch } from './useVaultSearch'
import { useVaultDockPlacement } from './useVaultDockPlacement'
import { readRecentFiles, recordRecentFile } from './recent-files'
import { collectTreePaths, findDirectory, resolveTreePath } from './vault-tree-paths'
import type { VaultEditorMode, VaultFile, VaultMarkdownCodec, VaultOperation, VaultOperationFailure, VaultOperationPhase, VaultPaneHandle, VaultPaneProps, VaultRichParts, VaultTreeNode } from './contracts'

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

/** How many recent files the empty document pane offers. */
const RECENT_SHOWN = 5

/**
 * Browse and edit files in the available pane width.
 * Below 60rem, Files and the selected document share one pane, so an open
 * document gets the whole width: beside a 23rem tree, a narrower pane left a
 * GTM call sheet's table about 385px and hid its third column.
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
  const { rootRef, dockInline } = useVaultDockPlacement(renderDock)
  const [pendingNav, setPendingNav] = useState<PendingNav>(null)
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  const dirtyRef = useRef(isDirty)
  dirtyRef.current = isDirty
  const treeRequestRef = useRef(0)
  const savedContentRef = useRef('')
  const draftContentRef = useRef('')
  const savedResultRef = useRef<VaultFile | null>(null)
  const saveRequestRef = useRef<object | null>(null)
  const saveScopeKey = useMemo(() => ({}), [port, selectedPath, canWrite, historyOpen])
  const saveScopeRef = useRef({ key: saveScopeKey, port, path: selectedPath, canWrite, historyOpen })
  saveScopeRef.current = { key: saveScopeKey, port, path: selectedPath, canWrite, historyOpen }
  const mountedRef = useRef(true)
  const editorModeRef = useRef(editorMode)
  editorModeRef.current = editorMode
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      saveRequestRef.current = null
    }
  }, [])
  const savedRichDraft = useMemo(
    () => selectedFile ? activeCodec.parse(selectedFile.content) : undefined,
    [selectedFile?.content, activeCodec],
  )
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
  const { query, onQueryChange, visibleRoot, canSearchContent, contentResults, retry: retryContentSearch } = useVaultSearch({ port, treeRoot })

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
      draftContentRef.current = ''
      setRichDraft('')
      setSourceDraft('')
      setEditorMode('rich')
      setIsDirty(false)
      setSaveError(null)
      return
    }
    // A completed write advances the persisted baseline, but must not replace
    // edits typed while that write was in flight with its older submitted text.
    if (savedResultRef.current === selectedFile) {
      savedResultRef.current = null
      return
    }
    const pathChanged = loadedPathRef.current !== selectedFile.path
    loadedPathRef.current = selectedFile.path
    setDisplayReadyPath(selectedFile.path)
    savedContentRef.current = selectedFile.content
    draftContentRef.current = selectedFile.content
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
      const rich = activeCodec.parse(sourceDraft)
      const content = activeCodec.serialize(rich)
      draftContentRef.current = content
      dirtyRef.current = content !== savedContentRef.current
      editorModeRef.current = 'rich'
      setRichDraft(rich)
      setIsDirty(dirtyRef.current)
      return 'rich'
    })
  }, [activeCodec, sourceDraft])

  const showSourceMode = useCallback(() => {
    setEditorMode((mode) => {
      if (mode === 'source') return mode
      const content = isDirty ? activeCodec.serialize(richDraft) : savedContentRef.current
      draftContentRef.current = content
      dirtyRef.current = content !== savedContentRef.current
      editorModeRef.current = 'source'
      setSourceDraft(content)
      setIsDirty(dirtyRef.current)
      return 'source'
    })
  }, [activeCodec, isDirty, richDraft])

  const onSourceChange = useCallback((next: string) => {
    if (!mountedRef.current || editorModeRef.current !== 'source' || saveScopeRef.current.key !== saveScopeKey
      || !saveScopeRef.current.canWrite || saveScopeRef.current.historyOpen) return
    draftContentRef.current = next
    dirtyRef.current = next !== savedContentRef.current
    setSourceDraft(next)
    setIsDirty(dirtyRef.current)
  }, [saveScopeKey])

  const onRichChange = useCallback((next: VaultRichParts) => {
    if (!mountedRef.current || editorModeRef.current !== 'rich' || saveScopeRef.current.key !== saveScopeKey
      || !saveScopeRef.current.canWrite || saveScopeRef.current.historyOpen) return
    draftContentRef.current = activeCodec.serialize(next)
    dirtyRef.current = draftContentRef.current !== savedContentRef.current
    setRichDraft(next)
    setIsDirty(dirtyRef.current)
  }, [activeCodec, saveScopeKey])

  const saveCurrent = useCallback(async () => {
    const scope = saveScopeRef.current
    if (!mountedRef.current || !selectedFile || !scope.canWrite || scope.historyOpen || !dirtyRef.current
      || scope.key !== saveScopeKey || scope.port !== port
      || scope.path !== selectedFile.path || saveRequestRef.current) return
    const content = draftContentRef.current
    const request = {}
    // Set before React renders: even retained callbacks or two synchronous
    // clicks share one write. Disabled buttons are presentation, not admission.
    saveRequestRef.current = request
    const isCurrent = () => mountedRef.current && saveRequestRef.current === request
      && saveScopeRef.current.key === saveScopeKey
      && saveScopeRef.current.port === port
      && saveScopeRef.current.path === selectedFile.path
      && saveScopeRef.current.canWrite
    setSaving(true)
    setSaveError(null)
    try {
      await port.writeFile(selectedFile.path, content)
      if (!isCurrent()) return
      savedContentRef.current = content
      const savedFile = { ...selectedFile, content }
      savedResultRef.current = savedFile
      setSelectedFile(savedFile)
      // The current draft can have moved on while persistence was pending.
      const dirty = draftContentRef.current !== content
      dirtyRef.current = dirty
      setIsDirty(dirty)
      if (!dirty) {
        setSourceDraft(content)
        setRichDraft(activeCodec.parse(content))
      }
    } catch (error) {
      if (isCurrent()) setSaveError(reportFailure('save', 'operation', error, 'Failed to save file', selectedFile.path))
    } finally {
      if (saveRequestRef.current === request) {
        saveRequestRef.current = null
        // A controlled selection can replace this file while its write is
        // pending. Release the old file's dirty barrier, never a newer draft.
        if (saveScopeRef.current.path !== selectedFile.path
          && loadedPathRef.current === selectedFile.path) {
          dirtyRef.current = false
          setIsDirty(false)
        }
        setSaving(false)
      }
    }
  }, [selectedFile, activeCodec, port, reportFailure, saveScopeKey])

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

  // History belongs to the open file; another file starts with the document.
  const historyPath = selectedFile?.path ?? null
  useEffect(() => { setHistoryOpen(false) }, [historyPath])
  const canShowHistory = typeof port.listRevisions === 'function' && typeof port.readRevision === 'function'
  const listRevisions = useCallback((path: string) => port.listRevisions!(path), [port])
  const readRevision = useCallback((path: string, id: string) => port.readRevision!(path, id), [port])
  const restoreRevision = useCallback(async (content: string) => {
    const scope = saveScopeRef.current
    if (!mountedRef.current || !selectedFile || !scope.canWrite || !scope.historyOpen
      || scope.key !== saveScopeKey || scope.port !== port || scope.path !== selectedFile.path
      || dirtyRef.current || saveRequestRef.current) {
      throw new Error('This file is no longer available to restore.')
    }
    const request = {}
    saveRequestRef.current = request
    setSaving(true)
    try {
      await port.writeFile(selectedFile.path, content)
      if (!mountedRef.current || saveRequestRef.current !== request
        || saveScopeRef.current.key !== saveScopeKey) return
      setHistoryOpen(false)
      setReloadNonce((n) => n + 1)
    } finally {
      if (saveRequestRef.current === request) {
        saveRequestRef.current = null
        setSaving(false)
      }
    }
  }, [port, selectedFile, saveScopeKey])

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

  const dockButtonLabel = persistentDock ? dockLabel : dockToggleCfg.label
  const dockBlockedByDraft = !persistentDock && (dockToggleCfg.disabledWhenDirty ?? true) && isDirty
  const openCreate = () => { setCreateError(null); setNewPath(activeFolder ? `${activeFolder}/` : ''); setCreateOpen(true) }
  // Loading, empty and filled vaults share one geometry (tree column, search,
  // document pane), so the pane never jumps when the first listing answers: an
  // empty-vault layout measured CLS 0.38 on Hospitality's Files page.
  const vaultEmpty = treeLoaded && treePaths.files.size === 0 && treePaths.directories.size === 0
  const trimmedQuery = query.trim()
  const nameMatches = (visibleRoot.children?.length ?? 0) > 0
  const showFileList = () => {
    const focused = document.activeElement
    setFilesOpen(true)
    requestAnimationFrame(() => {
      if (document.activeElement === focused || document.activeElement === document.body) {
        searchRef.current?.focus()
      }
    })
  }

  const cancelCreate = () => { setCreateOpen(false); setNewPath(''); setCreateError(null) }

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
          : trimmedQuery && !nameMatches && (contentResults.status === 'idle' || (contentResults.status === 'done' && contentResults.matches.length === 0))
            ? <TreeNoMatchState query={trimmedQuery} onClear={() => onQueryChange('')} />
            : trimmedQuery && !nameMatches
              ? null
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
        {trimmedQuery && contentResults.status !== 'idle' && (
          <VaultContentResults
            state={contentResults}
            selectedPath={resolvedSelectedPath}
            onOpen={(path) => guardedOpen(path)}
            onRetry={retryContentSearch}
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
          <VaultPaneNavigation label={label} selectedPath={selectedPath} showFiles={showFiles} onShowFiles={showFileList} onShowDocument={showDocument} />
          <div className="flex min-h-0 min-w-0 flex-1">
            <div data-vault-tree className={`${showFiles ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col p-2 @[60rem]/vault:flex @[60rem]/vault:p-3 @[60rem]/vault:w-[23rem] @[60rem]/vault:min-w-[23rem] @[60rem]/vault:flex-none`}>
              {/* The tree is its own surface: a card on the page background,
                  so the file list reads as a finished panel rather than
                  text floating on the canvas. */}
              <VaultTreePanel label={label} treeHeadingId={treeHeadingId} headerActions={headerActions} onRefresh={() => void refresh()} onCreate={canCreate ? openCreate : undefined} activeFolder={activeFolder} onClearFolder={() => setFolderPath(null)} query={query} onQueryChange={onQueryChange} canSearchContent={canSearchContent} empty={vaultEmpty} searchRef={searchRef}>
                {treeContent}
              </VaultTreePanel>
            </div>

            <div
              ref={documentRef}
              role="region"
              aria-label={`${label} document`}
              tabIndex={-1}
              className={`${showFiles ? 'hidden' : 'flex'} min-w-0 flex-1 flex-col overflow-hidden @[60rem]/vault:flex`}
            >
              {selectedFile && (
                <VaultDocumentToolbar
                  file={selectedFile}
                  className={pathBarClassName}
                  editing={canWrite && isMarkdownCapable ? { value: editorMode, onRich: showRichMode, onSource: showSourceMode } : undefined}
                  history={canShowHistory ? { open: historyOpen, dirty: isDirty, onToggle: () => setHistoryOpen((open) => !open) } : undefined}
                  dock={renderDock && (!persistentDock || dockInline) ? { label: dockButtonLabel, open: dockOpen, blocked: dockBlockedByDraft, title: persistentDock ? dockLabel : (dockToggleCfg.title ?? dockToggleCfg.label), onToggle: () => setDockOpen((v) => !v) } : undefined}
                  onDownloadFile={onDownloadFile}
                  onDelete={canDelete ? () => { setDeleteError(null); setDeleteOpen(true) } : undefined}
                >
                  {fileActions?.(selectedFile)}
                </VaultDocumentToolbar>
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
                ) : selectedFile && historyOpen && canShowHistory ? (
                  <VaultHistoryPanel
                    path={selectedFile.path}
                    listRevisions={listRevisions}
                    readRevision={readRevision}
                    canRestore={canWrite}
                    renderPreview={(content, revision) => renderArtifact({
                      file: { ...selectedFile, content },
                      loading: false,
                      mode: 'rich',
                      canWrite: false,
                      richDraft: activeCodec.parse(content),
                      savedRichDraft: activeCodec.parse(content),
                      dirty: false,
                      onRichChange: () => {},
                      onSave: () => {},
                      saving: false,
                      revision,
                    })}
                    onRestore={restoreRevision}
                    onClose={() => setHistoryOpen(false)}
                  />
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
                    savedRichDraft,
                    dirty: isDirty,
                    onRichChange,
                    onSave: () => void saveCurrent(),
                    saving,
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

        <VaultCreateDialog open={createOpen} path={newPath} label={label} folder={activeFolder} busy={creating} error={createError} onPathChange={setNewPath} onConfirm={() => void handleCreate()} onCancel={cancelCreate} />

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
