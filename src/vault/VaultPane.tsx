import { retryVaultTreeRefresh, completeVaultPendingOpen, finishVaultPendingOpen, commitVaultPath,
  reportVaultOperationFailure, refreshVaultTree, openVaultFile, discardVaultDraft, showVaultRichMode,
  showVaultSourceMode, changeVaultSource, changeVaultRichDraft, saveVaultFile, createVaultFile,
  deleteVaultFile, restoreVaultRevision, readVaultSelectedFile, reconcileVaultSelectedFile,
  type VaultPendingNavigation, type VaultPendingOpen, type VaultTreeRefreshContext,
    type VaultTreeFailureState, type VaultSaveScope } from './VaultPaneOperations'
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



/** How many recent files the empty document pane offers. */
const RECENT_SHOWN = 5
function useVaultPaneViewState(props: VaultPaneProps, ref: import('react').ForwardedRef<VaultPaneHandle>) {
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
  const [treeError, setTreeError] = useState<VaultTreeFailureState | null>(null)
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
  const { showDocument } = useVaultDocumentFocus({ setFilesOpen, documentRef })
  const { selectedFile, setSelectedFile, displayReadyPath, setDisplayReadyPath, fileLoading,
    setFileLoading, readError, setReadError, reloadNonce, setReloadNonce, saving, setSaving, saveError,
    setSaveError, editorMode, setEditorMode, richDraft, setRichDraft, sourceDraft, setSourceDraft,
    isDirty, setIsDirty } = useVaultDocumentState()

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
  const [pendingNav, setPendingNav] = useState<VaultPendingNavigation>(null)
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
  const pendingOpenRef = useRef<VaultPendingOpen | null>(null)
  const previousPortRef = useRef(port)
  const { finishPendingOpen } = useVaultPendingOpenCompletion({ pendingOpenRef, setPendingNav, previousPortRef, port, selectedPath })
  const { treePaths, resolvedSelectedPath, activeFolderNode, activeFolder, treeRoot, query,
    onQueryChange, visibleRoot, canSearchContent, contentResults,
    retryContentSearch } = useVaultTreeProjection({ tree, selectedPath, folderPath, label, port })

  const commitPath = useCallback(
    (next: string | null) => commitVaultPath(next, { controlled, onSelectedPathChange, setInternalPath }),
    [controlled, onSelectedPathChange],
  )

  const reportFailure = useCallback((operation: VaultOperation, phase: VaultOperationPhase,
    error: unknown, fallback: string, path?: string) => reportVaultOperationFailure(operation, phase,
    error, fallback, path, { onOperationErrorRef }), [])

  const refresh = useCallback((context?: VaultTreeRefreshContext) => refreshVaultTree(context,
    { treeRequestRef, setTreeLoading, setTreeError, port, setTree, setTreeLoaded, reportFailure,
    label }), [port, reportFailure, label])

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

  const retryTree = useCallback(() => retryVaultTreeRefresh({ treeError, refresh, commitPath }), [treeError, refresh, commitPath])

  useEffect(() => readVaultSelectedFile({ selectedPath, setSelectedFile, setFileLoading,
    setReadError, loadedPathRef, treeError, pendingOpenRef, treeLoading, treeLoaded, isDirty, saving,
    resolvedSelectedPath, finishPendingOpen, commitPath, port, dirtyRef, reportFailure }), [port,
    selectedPath, resolvedSelectedPath, treeLoading, treeLoaded, treeError, isDirty, saving,
    reloadNonce, commitPath, reportFailure, finishPendingOpen])

  useEffect(() => reconcileVaultSelectedFile({ selectedFile, loadedPathRef, setDisplayReadyPath,
    savedContentRef, draftContentRef, setRichDraft, setSourceDraft, setEditorMode, setIsDirty,
    setSaveError, savedResultRef, activeCodec, setDockOpen }), [selectedFile?.path,
    selectedFile?.content, activeCodec])

  useEffect(() => completeVaultPendingOpen({ pendingOpenRef, selectedPath, selectedFile,
    displayReadyPath, sourceDraft, fileLoading, finishPendingOpen }), [selectedPath, selectedFile,
    displayReadyPath, sourceDraft, fileLoading, finishPendingOpen])

  const guardedOpen = useCallback((rawPath: string,
    resolve?: (opened: boolean) => void) => openVaultFile(rawPath, resolve, { treePaths,
    finishPendingOpen, setPendingNav, selectedPath, selectedFile, displayReadyPath, showDocument,
    pendingOpenRef, fileLoading, readError, treeError, treeLoaded, setReloadNonce, isDirty,
    commitPath }), [finishPendingOpen, treePaths, selectedPath, selectedFile, displayReadyPath,
    fileLoading, showDocument, readError, treeError, treeLoaded, isDirty, commitPath])

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

  const confirmDiscard = useCallback(() => discardVaultDraft({ pendingNav, setPendingNav,
    pendingOpenRef, commitPath, finishPendingOpen, setIsDirty, showDocument }), [pendingNav,
    commitPath, showDocument, finishPendingOpen])
  const { showRichMode, showSourceMode, onSourceChange, onRichChange,
    saveCurrent } = useVaultDraftEditing({ setEditorMode, activeCodec, sourceDraft, draftContentRef,
    dirtyRef, savedContentRef, editorModeRef, setRichDraft, setIsDirty, isDirty, richDraft,
    setSourceDraft, mountedRef, saveScopeRef, saveScopeKey, selectedFile, port, saveRequestRef,
    setSaving, setSaveError, savedResultRef, setSelectedFile, reportFailure, loadedPathRef })

  const handleCreate = useCallback(() => createVaultFile({ newPath, setCreating, setCreateError,
    port, setCreateOpen, setNewPath, refresh, commitPath, reportFailure }), [newPath, port, refresh,
    commitPath, reportFailure])

  const handleDelete = useCallback(() => deleteVaultFile({ selectedFile, setDeleting,
    setDeleteError, port, setDeleteOpen, setIsDirty, commitPath, setSelectedFile, refresh,
    reportFailure }), [selectedFile, port, refresh, commitPath, reportFailure])

  // History belongs to the open file; another file starts with the document.
  const historyPath = selectedFile?.path ?? null
  useEffect(() => { setHistoryOpen(false) }, [historyPath])
  const canShowHistory = typeof port.listRevisions === 'function' && typeof port.readRevision === 'function'
  const listRevisions = useCallback((path: string) => port.listRevisions!(path), [port])
  const readRevision = useCallback((path: string, id: string) => port.readRevision!(path, id), [port])
  const restoreRevision = useCallback((content: string) => restoreVaultRevision(content,
    { saveScopeRef, mountedRef, selectedFile, saveScopeKey, port, dirtyRef, saveRequestRef, setSaving,
    setHistoryOpen, setReloadNonce }), [port, selectedFile, saveScopeKey])

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
 return { treeLoaded, treeLoading, treeError, label, retryTree, noun, setTreeError, vaultEmpty,
   trimmedQuery, treeEmptyState, canCreate, openCreate, nameMatches, contentResults, onQueryChange,
   renderTree, visibleRoot, resolvedSelectedPath, handleTreeSelect, activeFolder, handleFolderToggle,
   treeStateKey, guardedOpen, retryContentSearch, commitPath, setSelectedFile, rootRef, className,
   selectedPath, showFiles, showFileList, showDocument, treeHeadingId, headerActions, refresh,
   setFolderPath, query, canSearchContent, searchRef, documentRef, selectedFile, pathBarClassName,
   canWrite, isMarkdownCapable, editorMode, showRichMode, showSourceMode, canShowHistory, historyOpen,
   isDirty, setHistoryOpen, renderDock, persistentDock, dockInline, dockButtonLabel, dockOpen,
   dockBlockedByDraft, dockLabel, dockToggleCfg, setDockOpen, onDownloadFile, canDelete,
   setDeleteError, setDeleteOpen, fileActions, saveError, saveCurrent, setSaveError, readError,
   setReloadNonce, setReadError, fileLoading, listRevisions, readRevision, renderArtifact,
   activeCodec, restoreRevision, sourceDraft, saving, onSourceChange, richDraft, savedRichDraft,
   onRichChange, emptyState, recentToOffer, createOpen, newPath, creating, createError, setNewPath,
   handleCreate, cancelCreate, deleteOpen, deleting, handleDelete, deleteError, pendingNav,
   confirmDiscard, finishPendingOpen, setPendingNav }
}
type VaultPaneViewState = ReturnType<typeof useVaultPaneViewState>
export const VaultPane = forwardRef<VaultPaneHandle, VaultPaneProps>(function VaultPane(props, ref) {
 const view = useVaultPaneViewState(props, ref)
 return <VaultPaneView {...view} />
})
function VaultPaneView({ treeLoaded, treeLoading, treeError, label, retryTree, noun, setTreeError,
  vaultEmpty, trimmedQuery, treeEmptyState, canCreate, openCreate, nameMatches, contentResults,
  onQueryChange, renderTree, visibleRoot, resolvedSelectedPath, handleTreeSelect, activeFolder,
  handleFolderToggle, treeStateKey, guardedOpen, retryContentSearch, commitPath, setSelectedFile,
  rootRef, className, selectedPath, showFiles, showFileList, showDocument, treeHeadingId,
  headerActions, refresh, setFolderPath, query, canSearchContent, searchRef, documentRef,
  selectedFile, pathBarClassName, canWrite, isMarkdownCapable, editorMode, showRichMode,
  showSourceMode, canShowHistory, historyOpen, isDirty, setHistoryOpen, renderDock, persistentDock,
  dockInline, dockButtonLabel, dockOpen, dockBlockedByDraft, dockLabel, dockToggleCfg, setDockOpen,
  onDownloadFile, canDelete, setDeleteError, setDeleteOpen, fileActions, saveError, saveCurrent,
  setSaveError, readError, setReloadNonce, setReadError, fileLoading, listRevisions, readRevision,
  renderArtifact, activeCodec, restoreRevision, sourceDraft, saving, onSourceChange, richDraft,
  savedRichDraft, onRichChange, emptyState, recentToOffer, createOpen, newPath, creating,
  createError, setNewPath, handleCreate, cancelCreate, deleteOpen, deleting, handleDelete,
  deleteError, pendingNav, confirmDiscard, finishPendingOpen, setPendingNav }: VaultPaneViewState) {

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

}


function useVaultTreeProjection({ tree, selectedPath, folderPath, label,
  port }: { tree: VaultTreeNode[]; selectedPath: string | null; folderPath: string | null;
  label: string; port: VaultPaneProps['port'] }) {

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
  return { treePaths, resolvedSelectedPath, activeFolderNode, activeFolder, treeRoot, query,
    onQueryChange, visibleRoot, canSearchContent, contentResults, retryContentSearch }
}


function useVaultDocumentFocus({ setFilesOpen, documentRef }: { setFilesOpen: (open: boolean) => void; documentRef: { current: HTMLDivElement | null } }) {

  const showDocument = useCallback(() => {
    const focused = document.activeElement
    setFilesOpen(false)
    requestAnimationFrame(() => {
      if (document.activeElement === focused || document.activeElement === document.body) {
        documentRef.current?.focus({ preventScroll: true })
      }
    })
  }, [])
  return { showDocument }
}


function useVaultPendingOpenCompletion({ pendingOpenRef, setPendingNav, previousPortRef, port,
  selectedPath }: { previousPortRef: { current: VaultPaneProps['port'] };
  port: VaultPaneProps['port']; selectedPath: string | null;
  pendingOpenRef: { current: VaultPendingOpen | null }; setPendingNav: (value: VaultPendingNavigation | ((current: VaultPendingNavigation) => VaultPendingNavigation)) => void }) {

  const finishPendingOpen = useCallback((opened: boolean,
    clearNavigation = true) => finishVaultPendingOpen(opened, clearNavigation, { pendingOpenRef,
    setPendingNav }), [])
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
  return { finishPendingOpen }
}


function useVaultDraftEditing({ setEditorMode, activeCodec, sourceDraft, draftContentRef, dirtyRef,
  savedContentRef, editorModeRef, setRichDraft, setIsDirty, isDirty, richDraft, setSourceDraft,
  mountedRef, saveScopeRef, saveScopeKey, selectedFile, port, saveRequestRef, setSaving,
  setSaveError, savedResultRef, setSelectedFile, reportFailure,
  loadedPathRef }: { setEditorMode: (value: VaultEditorMode | ((current: VaultEditorMode) => VaultEditorMode)) => void;
  activeCodec: VaultMarkdownCodec; sourceDraft: string; draftContentRef: { current: string };
  dirtyRef: { current: boolean }; savedContentRef: { current: string };
  editorModeRef: { current: VaultEditorMode };
  setRichDraft: (value: VaultRichParts | ((current: VaultRichParts) => VaultRichParts)) => void;
  setIsDirty: (value: boolean | ((current: boolean) => boolean)) => void; isDirty: boolean;
  richDraft: VaultRichParts; setSourceDraft: (value: string | ((current: string) => string)) => void;
  mountedRef: { current: boolean }; saveScopeRef: { current: VaultSaveScope }; saveScopeKey: object;
  selectedFile: VaultFile | null; port: VaultPaneProps['port'];
  saveRequestRef: { current: object | null };
  setSaving: (value: boolean | ((current: boolean) => boolean)) => void;
  setSaveError: (value: VaultOperationFailure | null | ((current: VaultOperationFailure | null) => VaultOperationFailure | null)) => void;
  savedResultRef: { current: VaultFile | null };
  setSelectedFile: (value: VaultFile | null | ((current: VaultFile | null) => VaultFile | null)) => void; reportFailure: (operation: VaultOperation,
  phase: VaultOperationPhase, error: unknown, fallback: string, path?: string) => VaultOperationFailure; loadedPathRef: { current: string | null } }) {

  const showRichMode = useCallback(() => showVaultRichMode({ setEditorMode, activeCodec,
    sourceDraft, draftContentRef, dirtyRef, savedContentRef, editorModeRef, setRichDraft,
    setIsDirty }), [activeCodec, sourceDraft])

  const showSourceMode = useCallback(() => showVaultSourceMode({ setEditorMode, isDirty,
    activeCodec, richDraft, savedContentRef, draftContentRef, dirtyRef, editorModeRef, setSourceDraft,
    setIsDirty }), [activeCodec, isDirty, richDraft])

  const onSourceChange = useCallback((next: string) => changeVaultSource(next, { mountedRef,
    editorModeRef, saveScopeRef, saveScopeKey, draftContentRef, dirtyRef, savedContentRef,
    setSourceDraft, setIsDirty }), [saveScopeKey])

  const onRichChange = useCallback((next: VaultRichParts) => changeVaultRichDraft(next,
    { mountedRef, editorModeRef, saveScopeRef, saveScopeKey, draftContentRef, activeCodec, dirtyRef,
    savedContentRef, setRichDraft, setIsDirty }), [activeCodec, saveScopeKey])

  const saveCurrent = useCallback(() => saveVaultFile({ saveScopeRef, mountedRef, selectedFile,
    dirtyRef, saveScopeKey, port, saveRequestRef, draftContentRef, setSaving, setSaveError,
    savedContentRef, savedResultRef, setSelectedFile, setIsDirty, setSourceDraft, setRichDraft,
    activeCodec, reportFailure, loadedPathRef }), [selectedFile, activeCodec, port, reportFailure, saveScopeKey])
  return { showRichMode, showSourceMode, onSourceChange, onRichChange, saveCurrent }
}


function useVaultDocumentState() {

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
  return { selectedFile, setSelectedFile, displayReadyPath, setDisplayReadyPath, fileLoading,
    setFileLoading, readError, setReadError, reloadNonce, setReloadNonce, saving, setSaving, saveError,
    setSaveError, editorMode, setEditorMode, richDraft, setRichDraft, sourceDraft, setSourceDraft,
    isDirty, setIsDirty }
}
