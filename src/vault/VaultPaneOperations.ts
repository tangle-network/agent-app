import { operationMessage } from './VaultPaneStates'
import { collectTreePaths, resolveTreePath } from './vault-tree-paths'
import type { VaultEditorMode, VaultFile, VaultMarkdownCodec, VaultOperation,
  VaultOperationFailure, VaultOperationPhase, VaultPaneProps, VaultRichParts, VaultTreeNode } from './contracts'

export interface VaultSaveScope { key: object; port: VaultPaneProps['port']; path: string | null; canWrite: boolean; historyOpen: boolean }

export type VaultPendingNavigation = { path: string; request?: VaultPendingOpen } | null

export type VaultPendingOpen = {
  path: string
  fromPath: string | null
  resolve: (opened: boolean) => void
  loaded: boolean
  selected: boolean
}

export interface VaultTreeRefreshContext {
  operation: Extract<VaultOperation, 'list' | 'create' | 'delete'>
  phase: VaultOperationPhase
  path?: string
  selectAfterRecovery?: string
}

export interface VaultTreeFailureState {
  failure: VaultOperationFailure
  context: VaultTreeRefreshContext
}

export function finishVaultPendingOpen(opened: boolean, clearNavigation = true, { pendingOpenRef,
  setPendingNav }: { pendingOpenRef: { current: VaultPendingOpen | null }; setPendingNav: (value: VaultPendingNavigation | ((current: VaultPendingNavigation) => VaultPendingNavigation)) => void }) {
    const pending = pendingOpenRef.current
    if (!pending) return
    pendingOpenRef.current = null
    if (!opened && clearNavigation) {
      setPendingNav((current) => current?.request === pending ? null : current)
    }
    pending.resolve(opened)
  }

export function commitVaultPath(next: string | null, { controlled, onSelectedPathChange,
  setInternalPath }: { controlled: boolean;
  onSelectedPathChange: VaultPaneProps['onSelectedPathChange']; setInternalPath: (value: string | null | ((current: string | null) => string | null)) => void }) {
      if (controlled) {
        const decision: unknown = onSelectedPathChange?.(next)
        return decision !== false
      }
      setInternalPath(next)
      onSelectedPathChange?.(next)
      return true
    }

export function reportVaultOperationFailure(operation: VaultOperation, phase: VaultOperationPhase,
  error: unknown, fallback: string, path: string | undefined, { onOperationErrorRef }: { onOperationErrorRef: { current: VaultPaneProps['onOperationError'] } }) {
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
  }

export async function refreshVaultTree(context: VaultTreeRefreshContext = { operation: 'list',
  phase: 'operation' }, { treeRequestRef, setTreeLoading, setTreeError, port, setTree, setTreeLoaded,
  reportFailure, label }: { treeRequestRef: { current: number };
  setTreeLoading: (value: boolean | ((current: boolean) => boolean)) => void;
  setTreeError: (value: VaultTreeFailureState | null | ((current: VaultTreeFailureState | null) => VaultTreeFailureState | null)) => void;
  port: VaultPaneProps['port'];
  setTree: (value: VaultTreeNode[] | ((current: VaultTreeNode[]) => VaultTreeNode[])) => void;
  setTreeLoaded: (value: boolean | ((current: boolean) => boolean)) => void;
  reportFailure: (operation: VaultOperation, phase: VaultOperationPhase, error: unknown,
  fallback: string, path?: string) => VaultOperationFailure; label: string }) {
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
  }

export function openVaultFile(rawPath: string, resolve: ((opened: boolean) => void) | undefined,
  { treePaths, finishPendingOpen, setPendingNav, selectedPath, selectedFile, displayReadyPath,
  showDocument, pendingOpenRef, fileLoading, readError, treeError, treeLoaded, setReloadNonce,
  isDirty, commitPath }: { treePaths: ReturnType<typeof collectTreePaths>;
  finishPendingOpen: (opened: boolean, clearNavigation?: boolean) => void;
  setPendingNav: (value: VaultPendingNavigation | ((current: VaultPendingNavigation) => VaultPendingNavigation)) => void;
  selectedPath: string | null; selectedFile: VaultFile | null; displayReadyPath: string | null;
  showDocument: () => void; pendingOpenRef: { current: VaultPendingOpen | null };
  fileLoading: boolean; readError: string | null; treeError: VaultTreeFailureState | null;
  treeLoaded: boolean; setReloadNonce: (value: number | ((current: number) => number)) => void;
  isDirty: boolean; commitPath: (next: string | null) => boolean }) {
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
      const pending: VaultPendingOpen = {
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
  }

export function discardVaultDraft({ pendingNav, setPendingNav, pendingOpenRef, commitPath,
  finishPendingOpen, setIsDirty, showDocument }: { pendingNav: VaultPendingNavigation;
  setPendingNav: (value: VaultPendingNavigation | ((current: VaultPendingNavigation) => VaultPendingNavigation)) => void;
  pendingOpenRef: { current: VaultPendingOpen | null }; commitPath: (next: string | null) => boolean;
  finishPendingOpen: (opened: boolean, clearNavigation?: boolean) => void;
  setIsDirty: (value: boolean | ((current: boolean) => boolean)) => void; showDocument: () => void }) {
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
  }

export function showVaultRichMode({ setEditorMode, activeCodec, sourceDraft, draftContentRef,
  dirtyRef, savedContentRef, editorModeRef, setRichDraft,
  setIsDirty }: { setEditorMode: (value: VaultEditorMode | ((current: VaultEditorMode) => VaultEditorMode)) => void;
  activeCodec: VaultMarkdownCodec; sourceDraft: string; draftContentRef: { current: string };
  dirtyRef: { current: boolean }; savedContentRef: { current: string };
  editorModeRef: { current: VaultEditorMode };
  setRichDraft: (value: VaultRichParts | ((current: VaultRichParts) => VaultRichParts)) => void; setIsDirty: (value: boolean | ((current: boolean) => boolean)) => void }) {
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
  }

export function showVaultSourceMode({ setEditorMode, isDirty, activeCodec, richDraft,
  savedContentRef, draftContentRef, dirtyRef, editorModeRef, setSourceDraft,
  setIsDirty }: { setEditorMode: (value: VaultEditorMode | ((current: VaultEditorMode) => VaultEditorMode)) => void;
  isDirty: boolean; activeCodec: VaultMarkdownCodec; richDraft: VaultRichParts;
  savedContentRef: { current: string }; draftContentRef: { current: string };
  dirtyRef: { current: boolean }; editorModeRef: { current: VaultEditorMode };
  setSourceDraft: (value: string | ((current: string) => string)) => void; setIsDirty: (value: boolean | ((current: boolean) => boolean)) => void }) {
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
  }

export function changeVaultSource(next: string, { mountedRef, editorModeRef, saveScopeRef,
  saveScopeKey, draftContentRef, dirtyRef, savedContentRef, setSourceDraft,
  setIsDirty }: { mountedRef: { current: boolean }; editorModeRef: { current: VaultEditorMode };
  saveScopeRef: { current: VaultSaveScope }; saveScopeKey: object;
  draftContentRef: { current: string }; dirtyRef: { current: boolean };
  savedContentRef: { current: string };
  setSourceDraft: (value: string | ((current: string) => string)) => void; setIsDirty: (value: boolean | ((current: boolean) => boolean)) => void }) {
    if (!mountedRef.current || editorModeRef.current !== 'source' || saveScopeRef.current.key !== saveScopeKey
      || !saveScopeRef.current.canWrite || saveScopeRef.current.historyOpen) return
    draftContentRef.current = next
    dirtyRef.current = next !== savedContentRef.current
    setSourceDraft(next)
    setIsDirty(dirtyRef.current)
  }

export function changeVaultRichDraft(next: VaultRichParts, { mountedRef, editorModeRef,
  saveScopeRef, saveScopeKey, draftContentRef, activeCodec, dirtyRef, savedContentRef, setRichDraft,
  setIsDirty }: { mountedRef: { current: boolean }; editorModeRef: { current: VaultEditorMode };
  saveScopeRef: { current: VaultSaveScope }; saveScopeKey: object;
  draftContentRef: { current: string }; activeCodec: VaultMarkdownCodec;
  dirtyRef: { current: boolean }; savedContentRef: { current: string };
  setRichDraft: (value: VaultRichParts | ((current: VaultRichParts) => VaultRichParts)) => void; setIsDirty: (value: boolean | ((current: boolean) => boolean)) => void }) {
    if (!mountedRef.current || editorModeRef.current !== 'rich' || saveScopeRef.current.key !== saveScopeKey
      || !saveScopeRef.current.canWrite || saveScopeRef.current.historyOpen) return
    draftContentRef.current = activeCodec.serialize(next)
    dirtyRef.current = draftContentRef.current !== savedContentRef.current
    setRichDraft(next)
    setIsDirty(dirtyRef.current)
  }

export async function saveVaultFile({ saveScopeRef, mountedRef, selectedFile, dirtyRef,
  saveScopeKey, port, saveRequestRef, draftContentRef, setSaving, setSaveError, savedContentRef,
  savedResultRef, setSelectedFile, setIsDirty, setSourceDraft, setRichDraft, activeCodec,
  reportFailure, loadedPathRef }: { saveScopeRef: { current: VaultSaveScope };
  mountedRef: { current: boolean }; selectedFile: VaultFile | null; dirtyRef: { current: boolean };
  saveScopeKey: object; port: VaultPaneProps['port']; saveRequestRef: { current: object | null };
  draftContentRef: { current: string };
  setSaving: (value: boolean | ((current: boolean) => boolean)) => void;
  setSaveError: (value: VaultOperationFailure | null | ((current: VaultOperationFailure | null) => VaultOperationFailure | null)) => void;
  savedContentRef: { current: string }; savedResultRef: { current: VaultFile | null };
  setSelectedFile: (value: VaultFile | null | ((current: VaultFile | null) => VaultFile | null)) => void;
  setIsDirty: (value: boolean | ((current: boolean) => boolean)) => void;
  setSourceDraft: (value: string | ((current: string) => string)) => void;
  setRichDraft: (value: VaultRichParts | ((current: VaultRichParts) => VaultRichParts)) => void;
  activeCodec: VaultMarkdownCodec; reportFailure: (operation: VaultOperation,
  phase: VaultOperationPhase, error: unknown, fallback: string,
  path?: string) => VaultOperationFailure; loadedPathRef: { current: string | null } }) {
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
  }

export async function createVaultFile({ newPath, setCreating, setCreateError, port, setCreateOpen,
  setNewPath, refresh, commitPath, reportFailure }: { newPath: string;
  setCreating: (value: boolean | ((current: boolean) => boolean)) => void;
  setCreateError: (value: VaultOperationFailure | null | ((current: VaultOperationFailure | null) => VaultOperationFailure | null)) => void;
  port: VaultPaneProps['port'];
  setCreateOpen: (value: boolean | ((current: boolean) => boolean)) => void;
  setNewPath: (value: string | ((current: string) => string)) => void;
  refresh: (context?: VaultTreeRefreshContext) => Promise<boolean>;
  commitPath: (next: string | null) => boolean; reportFailure: (operation: VaultOperation,
  phase: VaultOperationPhase, error: unknown, fallback: string, path?: string) => VaultOperationFailure }) {
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
  }

export async function deleteVaultFile({ selectedFile, setDeleting, setDeleteError, port,
  setDeleteOpen, setIsDirty, commitPath, setSelectedFile, refresh,
  reportFailure }: { selectedFile: VaultFile | null;
  setDeleting: (value: boolean | ((current: boolean) => boolean)) => void;
  setDeleteError: (value: VaultOperationFailure | null | ((current: VaultOperationFailure | null) => VaultOperationFailure | null)) => void;
  port: VaultPaneProps['port'];
  setDeleteOpen: (value: boolean | ((current: boolean) => boolean)) => void;
  setIsDirty: (value: boolean | ((current: boolean) => boolean)) => void;
  commitPath: (next: string | null) => boolean;
  setSelectedFile: (value: VaultFile | null | ((current: VaultFile | null) => VaultFile | null)) => void;
  refresh: (context?: VaultTreeRefreshContext) => Promise<boolean>;
  reportFailure: (operation: VaultOperation, phase: VaultOperationPhase, error: unknown,
  fallback: string, path?: string) => VaultOperationFailure }) {
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
  }

export async function restoreVaultRevision(content: string, { saveScopeRef, mountedRef,
  selectedFile, saveScopeKey, port, dirtyRef, saveRequestRef, setSaving, setHistoryOpen,
  setReloadNonce }: { saveScopeRef: { current: VaultSaveScope }; mountedRef: { current: boolean };
  selectedFile: VaultFile | null; saveScopeKey: object; port: VaultPaneProps['port'];
  dirtyRef: { current: boolean }; saveRequestRef: { current: object | null };
  setSaving: (value: boolean | ((current: boolean) => boolean)) => void;
  setHistoryOpen: (value: boolean | ((current: boolean) => boolean)) => void; setReloadNonce: (value: number | ((current: number) => number)) => void }) {
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
  }

export function readVaultSelectedFile({ selectedPath, setSelectedFile, setFileLoading,
  setReadError, loadedPathRef, treeError, pendingOpenRef, treeLoading, treeLoaded, isDirty, saving,
  resolvedSelectedPath, finishPendingOpen, commitPath, port, dirtyRef,
  reportFailure }: { selectedPath: string | null;
  setSelectedFile: (value: VaultFile | null | ((current: VaultFile | null) => VaultFile | null)) => void;
  setFileLoading: (value: boolean | ((current: boolean) => boolean)) => void;
  setReadError: (value: string | null | ((current: string | null) => string | null)) => void;
  loadedPathRef: { current: string | null }; treeError: VaultTreeFailureState | null;
  pendingOpenRef: { current: VaultPendingOpen | null }; treeLoading: boolean; treeLoaded: boolean;
  isDirty: boolean; saving: boolean; resolvedSelectedPath: string | null;
  finishPendingOpen: (opened: boolean, clearNavigation?: boolean) => void;
  commitPath: (next: string | null) => boolean; port: VaultPaneProps['port'];
  dirtyRef: { current: boolean }; reportFailure: (operation: VaultOperation,
  phase: VaultOperationPhase, error: unknown, fallback: string, path?: string) => VaultOperationFailure }) {
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
  }

export function reconcileVaultSelectedFile({ selectedFile, loadedPathRef, setDisplayReadyPath,
  savedContentRef, draftContentRef, setRichDraft, setSourceDraft, setEditorMode, setIsDirty,
  setSaveError, savedResultRef, activeCodec, setDockOpen }: { selectedFile: VaultFile | null;
  loadedPathRef: { current: string | null };
  setDisplayReadyPath: (value: string | null | ((current: string | null) => string | null)) => void;
  savedContentRef: { current: string }; draftContentRef: { current: string };
  setRichDraft: (value: VaultRichParts | ((current: VaultRichParts) => VaultRichParts)) => void;
  setSourceDraft: (value: string | ((current: string) => string)) => void;
  setEditorMode: (value: VaultEditorMode | ((current: VaultEditorMode) => VaultEditorMode)) => void;
  setIsDirty: (value: boolean | ((current: boolean) => boolean)) => void;
  setSaveError: (value: VaultOperationFailure | null | ((current: VaultOperationFailure | null) => VaultOperationFailure | null)) => void;
  savedResultRef: { current: VaultFile | null }; activeCodec: VaultMarkdownCodec; setDockOpen: (value: boolean | ((current: boolean) => boolean)) => void }) {
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
  }

export function completeVaultPendingOpen({ pendingOpenRef, selectedPath, selectedFile,
  displayReadyPath, sourceDraft, fileLoading,
  finishPendingOpen }: { pendingOpenRef: { current: VaultPendingOpen | null };
  selectedPath: string | null; selectedFile: VaultFile | null; displayReadyPath: string | null;
  sourceDraft: string; fileLoading: boolean; finishPendingOpen: (opened: boolean, clearNavigation?: boolean) => void }) {
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
  }

export async function retryVaultTreeRefresh({ treeError, refresh,
  commitPath }: { treeError: VaultTreeFailureState | null;
  refresh: (context?: VaultTreeRefreshContext) => Promise<boolean>; commitPath: (next: string | null) => boolean }) {
    if (!treeError) return
    const { context } = treeError
    const recovered = await refresh(context)
    if (recovered && context.selectAfterRecovery) commitPath(context.selectAfterRecovery)
  }
