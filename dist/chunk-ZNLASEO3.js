// src/vault/VaultPane.tsx
import {
  Component,
  useCallback,
  useEffect as useEffect2,
  useMemo,
  useRef as useRef2,
  useState
} from "react";
import { Download, Folder, Trash2 } from "lucide-react";

// src/vault/ConfirmDialog.tsx
import { useEffect, useRef } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
  children
}) {
  const panelRef = useRef(null);
  const confirmRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
  }, [open]);
  if (!open) return null;
  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Enter" && !confirmDisabled) {
      event.preventDefault();
      onConfirm();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = panelRef.current?.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  return /* @__PURE__ */ jsx(
    "div",
    {
      className: "fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4",
      onMouseDown: (e) => {
        if (e.target === e.currentTarget) onCancel();
      },
      children: /* @__PURE__ */ jsxs(
        "div",
        {
          ref: panelRef,
          role: "dialog",
          "aria-modal": "true",
          "aria-label": title,
          onKeyDown,
          className: "w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg",
          children: [
            /* @__PURE__ */ jsx("h2", { className: "text-sm font-semibold text-foreground", children: title }),
            description && /* @__PURE__ */ jsx("p", { className: "mt-1.5 text-xs text-muted-foreground", children: description }),
            children && /* @__PURE__ */ jsx("div", { className: "mt-3", children }),
            /* @__PURE__ */ jsxs("div", { className: "mt-5 flex justify-end gap-2", children: [
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  onClick: onCancel,
                  className: "inline-flex h-8 items-center rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  children: cancelLabel
                }
              ),
              /* @__PURE__ */ jsx(
                "button",
                {
                  ref: confirmRef,
                  type: "button",
                  onClick: onConfirm,
                  disabled: confirmDisabled,
                  className: `inline-flex h-8 items-center rounded-md px-3 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ${destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : "bg-primary text-primary-foreground hover:bg-primary/90"}`,
                  children: confirmLabel
                }
              )
            ] })
          ]
        }
      )
    }
  );
}

// src/vault/VaultPane.tsx
import { Fragment, jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var IDENTITY_CODEC = {
  parse: (raw) => raw,
  serialize: (parts) => typeof parts === "string" ? parts : String(parts ?? "")
};
var LIST_CONTEXT = { operation: "list", phase: "operation" };
function operationMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}
function treeFailureMessage(failure) {
  if (failure.phase !== "post-mutation-refresh") return failure.message;
  const completed = failure.operation === "create" ? "created" : "deleted";
  return `The file was ${completed}, but the Vault couldn't refresh. ${failure.message}`;
}
function collectTreePaths(nodes, into) {
  for (const node of nodes) {
    if (node.type === "file") into.files.add(node.path);
    else into.directories.add(node.path);
    if (node.children) collectTreePaths(node.children, into);
  }
  return into;
}
function resolveFilePath(rawPath, filePaths) {
  if (filePaths.has(rawPath)) return rawPath;
  const path = rawPath.replace(/^\/+|\/+$/g, "");
  return filePaths.has(path) ? path : null;
}
function resolveTreePath(rawPath, paths) {
  const file = resolveFilePath(rawPath, paths.files);
  if (file) return { path: file, type: "file" };
  if (paths.directories.has(rawPath)) return { path: rawPath, type: "directory" };
  const trimmed = rawPath.replace(/^\/+|\/+$/g, "");
  return paths.directories.has(trimmed) ? { path: trimmed, type: "directory" } : null;
}
function findDirectory(nodes, path) {
  for (const node of nodes) {
    if (node.type === "directory" && node.path === path) return node;
    const found = node.children ? findDirectory(node.children, path) : null;
    if (found) return found;
  }
  return null;
}
function treeClickTarget(event) {
  const read = (el) => {
    const path2 = el.dataset.itemPath;
    return path2 ? { path: path2, type: el.dataset.itemType ?? "" } : null;
  };
  const path = event.nativeEvent.composedPath?.() ?? [];
  for (const item of path) {
    if (!(item instanceof HTMLElement)) continue;
    if (item.dataset.type !== "item") continue;
    return read(item);
  }
  const target = event.target instanceof HTMLElement ? event.target.closest('[data-type="item"]') : null;
  return target instanceof HTMLElement ? read(target) : null;
}
function filterNodes(nodes, q) {
  const out = [];
  for (const node of nodes) {
    if (node.type === "file") {
      if (node.name.toLowerCase().includes(q)) out.push(node);
    } else if (node.name.toLowerCase().includes(q)) {
      out.push(node);
    } else {
      const children = filterNodes(node.children ?? [], q);
      if (children.length > 0) out.push({ ...node, children });
    }
  }
  return out;
}
var EditorErrorBoundary = class extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("Vault crashed:", error, info);
  }
  render() {
    if (this.state.error) {
      const msg = this.state.error instanceof Error ? this.state.error.message : typeof this.state.error === "string" ? this.state.error : "Something went wrong loading the vault";
      return /* @__PURE__ */ jsxs2("div", { className: "flex h-full flex-1 flex-col items-center justify-center p-8 text-center", children: [
        /* @__PURE__ */ jsx2("h3", { className: "mb-1 text-sm font-medium text-foreground", children: "Vault failed to load" }),
        /* @__PURE__ */ jsx2("p", { className: "mb-4 max-w-xs text-xs text-muted-foreground", children: String(msg) }),
        /* @__PURE__ */ jsx2(
          "button",
          {
            type: "button",
            onClick: () => {
              this.setState({ error: null });
              this.props.onReset?.();
            },
            className: "inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted",
            children: "Try again"
          }
        )
      ] });
    }
    return this.props.children;
  }
};
function SkeletonRegion({ label, className, children }) {
  return /* @__PURE__ */ jsxs2(Fragment, { children: [
    /* @__PURE__ */ jsx2("span", { role: "status", "aria-live": "polite", "aria-busy": true, className: "sr-only", children: label }),
    /* @__PURE__ */ jsx2("div", { className, "aria-hidden": "true", children })
  ] });
}
function TreeSkeleton() {
  return /* @__PURE__ */ jsx2(SkeletonRegion, { label: "Loading files\u2026", className: "space-y-2 p-4", children: [32, 48, 40, 52].map((w, i) => /* @__PURE__ */ jsx2("div", { className: "h-4 animate-pulse rounded bg-muted", style: { width: `${w * 4}px` } }, i)) });
}
function EditorSkeleton() {
  return /* @__PURE__ */ jsxs2(SkeletonRegion, { label: "Loading file\u2026", className: "space-y-3 p-8", children: [
    /* @__PURE__ */ jsx2("div", { className: "h-5 w-1/2 animate-pulse rounded bg-muted" }),
    /* @__PURE__ */ jsx2("div", { className: "h-4 w-full animate-pulse rounded bg-muted" }),
    /* @__PURE__ */ jsx2("div", { className: "h-4 w-3/4 animate-pulse rounded bg-muted" }),
    /* @__PURE__ */ jsx2("div", { className: "h-4 w-2/3 animate-pulse rounded bg-muted" })
  ] });
}
function ReadErrorState({ message, onRetry }) {
  return /* @__PURE__ */ jsxs2("div", { className: "flex h-full flex-col items-center justify-center gap-3 p-8 text-center", children: [
    /* @__PURE__ */ jsxs2("div", { children: [
      /* @__PURE__ */ jsx2("h3", { className: "text-sm font-medium text-foreground", children: "Couldn't open this file" }),
      /* @__PURE__ */ jsx2("p", { className: "mt-1 max-w-md text-xs text-muted-foreground", children: message })
    ] }),
    /* @__PURE__ */ jsx2(
      "button",
      {
        type: "button",
        onClick: onRetry,
        className: "inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted",
        children: "Retry"
      }
    )
  ] });
}
function TreeErrorState({ message, onRetry }) {
  return /* @__PURE__ */ jsxs2("div", { role: "alert", className: "flex h-full flex-col items-center justify-center gap-3 p-6 text-center", children: [
    /* @__PURE__ */ jsxs2("div", { children: [
      /* @__PURE__ */ jsx2("h3", { className: "text-sm font-medium text-foreground", children: "Couldn't load the Vault" }),
      /* @__PURE__ */ jsx2("p", { className: "mt-1 max-w-xs text-xs text-muted-foreground", children: message })
    ] }),
    /* @__PURE__ */ jsx2(
      "button",
      {
        type: "button",
        onClick: onRetry,
        className: "inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted",
        children: "Retry"
      }
    )
  ] });
}
function OperationErrorAlert({
  message,
  retryLabel,
  onRetry,
  onDismiss
}) {
  return /* @__PURE__ */ jsxs2(
    "div",
    {
      role: "alert",
      className: "flex shrink-0 items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive",
      children: [
        /* @__PURE__ */ jsx2("span", { className: "min-w-0 flex-1", children: message }),
        /* @__PURE__ */ jsxs2("div", { className: "flex shrink-0 items-center gap-3", children: [
          /* @__PURE__ */ jsx2("button", { type: "button", "aria-label": retryLabel, onClick: onRetry, className: "font-medium underline-offset-2 hover:underline", children: "Retry" }),
          /* @__PURE__ */ jsx2("button", { type: "button", onClick: onDismiss, className: "underline-offset-2 hover:underline", children: "Dismiss" })
        ] })
      ]
    }
  );
}
function VaultPane(props) {
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
    pathBarClassName
  } = props;
  const activeCodec = codec ?? IDENTITY_CODEC;
  const controlled = controlledPath !== void 0;
  const isMarkdownCapable = codec !== void 0;
  const persistentDock = dockToggle === false;
  const dockToggleCfg = dockToggle ? dockToggle : { label: "Discuss", disabledWhenDirty: true };
  const [tree, setTree] = useState([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeLoaded, setTreeLoaded] = useState(false);
  const [treeError, setTreeError] = useState(null);
  const [internalPath, setInternalPath] = useState(null);
  const selectedPath = controlled ? controlledPath ?? null : internalPath;
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [readError, setReadError] = useState(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [editorMode, setEditorMode] = useState("rich");
  const [richDraft, setRichDraft] = useState("");
  const [sourceDraft, setSourceDraft] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [dockOpen, setDockOpen] = useState(false);
  const [pendingNav, setPendingNav] = useState(null);
  const [query, setQuery] = useState("");
  const [folderPath, setFolderPath] = useState(null);
  const dirtyRef = useRef2(isDirty);
  dirtyRef.current = isDirty;
  const treeRequestRef = useRef2(0);
  const savedContentRef = useRef2("");
  const loadedPathRef = useRef2(null);
  const onOperationErrorRef = useRef2(onOperationError);
  onOperationErrorRef.current = onOperationError;
  const treePaths = useMemo(
    () => collectTreePaths(tree, { files: /* @__PURE__ */ new Set(), directories: /* @__PURE__ */ new Set() }),
    [tree]
  );
  const filePaths = treePaths.files;
  const resolvedSelectedPath = useMemo(
    () => selectedPath ? resolveFilePath(selectedPath, filePaths) : null,
    [selectedPath, filePaths]
  );
  const activeFolderNode = useMemo(
    () => folderPath ? findDirectory(tree, folderPath) : null,
    [tree, folderPath]
  );
  const activeFolder = activeFolderNode?.path ?? null;
  const treeRoot = useMemo(
    () => ({ name: "Vault", path: "", type: "directory", children: tree }),
    [tree]
  );
  const visibleRoot = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return treeRoot;
    const base = activeFolderNode ?? treeRoot;
    return { ...base, children: filterNodes(base.children ?? [], q) };
  }, [treeRoot, activeFolderNode, query]);
  const commitPath = useCallback(
    (next) => {
      if (!controlled) setInternalPath(next);
      onSelectedPathChange?.(next);
    },
    [controlled, onSelectedPathChange]
  );
  const reportFailure = useCallback((operation, phase, error, fallback, path) => {
    const failure = {
      operation,
      phase,
      path,
      message: operationMessage(error, fallback),
      cause: error
    };
    try {
      onOperationErrorRef.current?.(failure);
    } catch (callbackError) {
      console.error("Vault onOperationError callback failed:", callbackError);
    }
    return failure;
  }, []);
  const refresh = useCallback(async (context = LIST_CONTEXT) => {
    const request = ++treeRequestRef.current;
    setTreeLoading(true);
    setTreeError(null);
    try {
      const nextTree = await port.listTree();
      if (request !== treeRequestRef.current) return false;
      setTree(nextTree);
      setTreeLoaded(true);
      return true;
    } catch (error) {
      if (request !== treeRequestRef.current) return false;
      const failure = reportFailure(
        context.operation,
        context.phase,
        error,
        "Failed to load the Vault",
        context.path
      );
      setTreeError({ failure, context });
      return false;
    } finally {
      if (request === treeRequestRef.current) setTreeLoading(false);
    }
  }, [port, reportFailure]);
  useEffect2(() => {
    setTree([]);
    setTreeLoaded(false);
    setTreeError(null);
    setSelectedFile(null);
  }, [port]);
  useEffect2(() => {
    void refresh();
    return () => {
      treeRequestRef.current += 1;
    };
  }, [refresh, refreshKey]);
  const retryTree = useCallback(async () => {
    if (!treeError) return;
    const { context } = treeError;
    const recovered = await refresh(context);
    if (recovered && context.selectAfterRecovery) commitPath(context.selectAfterRecovery);
  }, [treeError, refresh, commitPath]);
  useEffect2(() => {
    if (!selectedPath) {
      setSelectedFile(null);
      setFileLoading(false);
      setReadError(null);
      loadedPathRef.current = null;
      return;
    }
    if (treeLoading || !treeLoaded || isDirty || saving) return;
    if (!resolvedSelectedPath) {
      commitPath(null);
      setSelectedFile(null);
      setFileLoading(false);
      setReadError(null);
      loadedPathRef.current = null;
      return;
    }
    let cancelled = false;
    const path = resolvedSelectedPath;
    if (path !== selectedPath) commitPath(path);
    setFileLoading(true);
    setReadError(null);
    void (async () => {
      try {
        const file = await port.readFile(path);
        if (!cancelled && !dirtyRef.current) setSelectedFile(file);
      } catch (err) {
        if (!cancelled) {
          const failure = reportFailure("read", "operation", err, "Failed to read file", path);
          setSelectedFile((current) => current?.path === path ? current : null);
          setReadError(failure.message);
        }
      } finally {
        if (!cancelled) setFileLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [port, selectedPath, resolvedSelectedPath, treeLoading, treeLoaded, isDirty, saving, reloadNonce, commitPath, reportFailure]);
  useEffect2(() => {
    if (!selectedFile) {
      loadedPathRef.current = null;
      savedContentRef.current = "";
      setRichDraft("");
      setSourceDraft("");
      setEditorMode("rich");
      setIsDirty(false);
      setSaveError(null);
      return;
    }
    const pathChanged = loadedPathRef.current !== selectedFile.path;
    loadedPathRef.current = selectedFile.path;
    savedContentRef.current = selectedFile.content;
    setRichDraft(activeCodec.parse(selectedFile.content));
    setSourceDraft(selectedFile.content);
    if (pathChanged) setEditorMode("rich");
    setIsDirty(false);
    setSaveError(null);
    setDockOpen(false);
  }, [selectedFile?.path, selectedFile?.content, activeCodec]);
  const guardedOpen = useCallback(
    (path) => {
      if (path === selectedPath) return;
      if (isDirty) {
        setPendingNav({ type: "open", path });
        return;
      }
      commitPath(path);
    },
    [isDirty, selectedPath, commitPath]
  );
  const toggleFolder = useCallback((path) => {
    setFolderPath((current) => current === path ? null : path);
  }, []);
  const selectFileRef = useRef2(() => {
  });
  selectFileRef.current = (rawPath) => {
    const target = resolveTreePath(rawPath, treePaths);
    if (!target) return;
    if (target.type === "file") {
      guardedOpen(target.path);
      return;
    }
    toggleFolder(target.path);
  };
  const handleTreeSelect = useCallback((path) => selectFileRef.current(path), []);
  const guardedClose = useCallback(() => {
    if (isDirty) {
      setPendingNav({ type: "close" });
      return;
    }
    commitPath(null);
    setSelectedFile(null);
  }, [isDirty, commitPath]);
  const confirmDiscard = useCallback(() => {
    const nav = pendingNav;
    setPendingNav(null);
    setIsDirty(false);
    if (!nav) return;
    if (nav.type === "open") {
      commitPath(nav.path);
    } else {
      commitPath(null);
      setSelectedFile(null);
    }
  }, [pendingNav, commitPath]);
  const showRichMode = useCallback(() => {
    setEditorMode((mode) => {
      if (mode === "rich") return mode;
      setRichDraft(activeCodec.parse(sourceDraft));
      setIsDirty(sourceDraft !== savedContentRef.current);
      return "rich";
    });
  }, [activeCodec, sourceDraft]);
  const showSourceMode = useCallback(() => {
    setEditorMode((mode) => {
      if (mode === "source") return mode;
      const content = isDirty ? activeCodec.serialize(richDraft) : savedContentRef.current;
      setSourceDraft(content);
      setIsDirty(content !== savedContentRef.current);
      return "source";
    });
  }, [activeCodec, isDirty, richDraft]);
  const onSourceChange = useCallback((next) => {
    dirtyRef.current = next !== savedContentRef.current;
    setSourceDraft(next);
    setIsDirty(dirtyRef.current);
  }, []);
  const onRichChange = useCallback((next) => {
    dirtyRef.current = activeCodec.serialize(next) !== savedContentRef.current;
    setRichDraft(next);
    setIsDirty(dirtyRef.current);
  }, [activeCodec]);
  const saveCurrent = useCallback(async () => {
    if (!selectedFile) return;
    const content = editorMode === "source" ? sourceDraft : activeCodec.serialize(richDraft);
    setSaving(true);
    setSaveError(null);
    try {
      await port.writeFile(selectedFile.path, content);
      savedContentRef.current = content;
      setSelectedFile({ ...selectedFile, content });
      setSourceDraft(content);
      setRichDraft(activeCodec.parse(content));
      setIsDirty(false);
    } catch (error) {
      setSaveError(reportFailure("save", "operation", error, "Failed to save file", selectedFile.path));
    } finally {
      setSaving(false);
    }
  }, [selectedFile, editorMode, sourceDraft, richDraft, activeCodec, port, reportFailure]);
  const handleCreate = useCallback(async () => {
    const trimmed = newPath.trim();
    if (!trimmed || !trimmed.split("/").pop()?.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await port.createFile(trimmed);
      setCreateOpen(false);
      setNewPath("");
      const refreshed = await refresh({
        operation: "create",
        phase: "post-mutation-refresh",
        path: created,
        selectAfterRecovery: created
      });
      if (refreshed) commitPath(created);
    } catch (error) {
      setCreateError(reportFailure("create", "operation", error, "Failed to create file", trimmed));
    } finally {
      setCreating(false);
    }
  }, [newPath, port, refresh, commitPath, reportFailure]);
  const handleDelete = useCallback(async () => {
    if (!selectedFile) return;
    const path = selectedFile.path;
    setDeleting(true);
    setDeleteError(null);
    try {
      await port.deleteFile(path);
      setDeleteOpen(false);
      setIsDirty(false);
      commitPath(null);
      setSelectedFile(null);
      await refresh({ operation: "delete", phase: "post-mutation-refresh", path });
    } catch (error) {
      setDeleteError(reportFailure("delete", "operation", error, "Failed to delete file", path));
    } finally {
      setDeleting(false);
    }
  }, [selectedFile, port, refresh, commitPath, reportFailure]);
  const createFileName = newPath.trim().split("/").pop()?.trim() ?? "";
  let treeContent;
  if (!treeLoaded && (treeLoading || !treeError)) {
    treeContent = /* @__PURE__ */ jsx2(TreeSkeleton, {});
  } else if (!treeLoaded && treeError) {
    treeContent = /* @__PURE__ */ jsx2(TreeErrorState, { message: treeFailureMessage(treeError.failure), onRetry: () => void retryTree() });
  } else {
    treeContent = /* @__PURE__ */ jsxs2(Fragment, { children: [
      treeError && /* @__PURE__ */ jsx2(
        OperationErrorAlert,
        {
          message: treeFailureMessage(treeError.failure),
          retryLabel: "Retry vault refresh",
          onRetry: () => void retryTree(),
          onDismiss: () => setTreeError(null)
        }
      ),
      renderTree({
        root: visibleRoot,
        selectedPath: resolvedSelectedPath ?? void 0,
        onSelect: handleTreeSelect
      })
    ] });
  }
  return /* @__PURE__ */ jsx2(EditorErrorBoundary, { onReset: () => {
    commitPath(null);
    setSelectedFile(null);
  }, children: /* @__PURE__ */ jsxs2("div", { className: `flex min-h-0 flex-1 overflow-hidden ${className ?? ""}`, children: [
    /* @__PURE__ */ jsxs2("div", { className: "flex w-[23rem] min-w-[23rem] flex-col border-r border-border bg-background", children: [
      /* @__PURE__ */ jsxs2("div", { className: "flex items-center gap-2 border-b border-border px-4 py-3", children: [
        /* @__PURE__ */ jsx2("div", { className: "min-w-0 flex-1", children: /* @__PURE__ */ jsx2(
          "input",
          {
            type: "text",
            value: query,
            onChange: (e) => setQuery(e.target.value),
            placeholder: activeFolder ? `Search ${activeFolder}\u2026` : "Search\u2026",
            "aria-label": "Search vault",
            className: "h-8 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
          }
        ) }),
        /* @__PURE__ */ jsxs2("div", { className: "flex shrink-0 items-center gap-1", children: [
          headerActions,
          /* @__PURE__ */ jsx2(
            "button",
            {
              type: "button",
              "aria-label": "Refresh vault",
              onClick: () => void refresh(),
              className: "inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              children: "\u21BB"
            }
          ),
          canWrite && /* @__PURE__ */ jsx2(
            "button",
            {
              type: "button",
              "aria-label": activeFolder ? `New vault file in ${activeFolder}` : "New vault file",
              onClick: () => {
                setCreateError(null);
                setNewPath(activeFolder ? `${activeFolder}/` : "");
                setCreateOpen(true);
              },
              className: "inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90",
              children: "+"
            }
          )
        ] })
      ] }),
      activeFolder && /* @__PURE__ */ jsxs2("div", { className: "flex items-center gap-1.5 border-b border-border bg-muted/40 px-4 py-1.5 text-xs", children: [
        /* @__PURE__ */ jsx2(Folder, { className: "h-3.5 w-3.5 shrink-0 text-muted-foreground", "aria-hidden": "true" }),
        /* @__PURE__ */ jsx2("span", { "data-vault-folder": true, className: "min-w-0 flex-1 truncate font-medium text-foreground", title: activeFolder, children: activeFolder }),
        /* @__PURE__ */ jsx2(
          "button",
          {
            type: "button",
            "aria-label": "Clear the active folder",
            onClick: () => setFolderPath(null),
            className: "shrink-0 rounded px-1 text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline",
            children: "Clear"
          }
        )
      ] }),
      /* @__PURE__ */ jsx2(
        "div",
        {
          className: "flex-1 overflow-y-auto",
          onClickCapture: (event) => {
            const target = treeClickTarget(event);
            if (target) handleTreeSelect(target.path);
          },
          children: treeContent
        }
      )
    ] }),
    /* @__PURE__ */ jsxs2("div", { className: "flex min-w-0 flex-1 flex-col overflow-hidden", children: [
      selectedFile && /* @__PURE__ */ jsxs2("div", { className: `flex shrink-0 items-center justify-between border-b border-border px-4 py-1.5 ${pathBarClassName ?? "bg-card"}`, children: [
        /* @__PURE__ */ jsx2("span", { "data-vault-path": true, className: "truncate text-xs font-medium text-foreground", children: selectedFile.path }),
        /* @__PURE__ */ jsxs2("div", { className: "flex items-center gap-1", children: [
          canWrite && isMarkdownCapable && /* @__PURE__ */ jsxs2("div", { className: "mr-1 flex items-center gap-1", children: [
            /* @__PURE__ */ jsx2(
              "button",
              {
                type: "button",
                "aria-label": "Edit as rich text",
                "aria-pressed": editorMode === "rich",
                onClick: showRichMode,
                className: `inline-flex h-7 items-center rounded px-2 text-xs transition-colors ${editorMode === "rich" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`,
                children: "Rich"
              }
            ),
            /* @__PURE__ */ jsx2(
              "button",
              {
                type: "button",
                "aria-label": "Edit as source",
                "aria-pressed": editorMode === "source",
                onClick: showSourceMode,
                className: `inline-flex h-7 items-center rounded px-2 text-xs transition-colors ${editorMode === "source" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`,
                children: "Source"
              }
            )
          ] }),
          renderDock && !persistentDock && /* @__PURE__ */ jsx2(
            "button",
            {
              type: "button",
              "aria-label": dockToggleCfg.label,
              "aria-pressed": dockOpen,
              disabled: (dockToggleCfg.disabledWhenDirty ?? true) && isDirty,
              title: (dockToggleCfg.disabledWhenDirty ?? true) && isDirty ? "Save your changes first" : dockToggleCfg.title ?? dockToggleCfg.label,
              onClick: () => setDockOpen((v) => !v),
              className: `inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors disabled:pointer-events-none disabled:opacity-40 ${dockOpen ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`,
              children: dockToggleCfg.label
            }
          ),
          onDownloadFile && /* @__PURE__ */ jsx2(
            "button",
            {
              type: "button",
              "aria-label": "Download this file",
              title: "Download file",
              onClick: () => onDownloadFile(selectedFile),
              className: "inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              children: /* @__PURE__ */ jsx2(Download, { className: "h-4 w-4" })
            }
          ),
          canWrite && /* @__PURE__ */ jsx2(
            "button",
            {
              type: "button",
              "aria-label": "Delete this file",
              title: "Delete file",
              onClick: () => {
                setDeleteError(null);
                setDeleteOpen(true);
              },
              className: "inline-flex h-7 w-7 items-center justify-center rounded text-destructive/70 transition-colors hover:bg-destructive/10 hover:text-destructive",
              children: /* @__PURE__ */ jsx2(Trash2, { className: "h-4 w-4" })
            }
          )
        ] })
      ] }),
      selectedFile && saveError && /* @__PURE__ */ jsx2(
        OperationErrorAlert,
        {
          message: saveError.message,
          retryLabel: "Retry save",
          onRetry: () => void saveCurrent(),
          onDismiss: () => setSaveError(null)
        }
      ),
      readError && selectedFile?.path === resolvedSelectedPath && /* @__PURE__ */ jsx2(
        OperationErrorAlert,
        {
          message: readError,
          retryLabel: "Retry file refresh",
          onRetry: () => setReloadNonce((n) => n + 1),
          onDismiss: () => setReadError(null)
        }
      ),
      /* @__PURE__ */ jsx2("div", { className: "flex-1 overflow-hidden", children: fileLoading && selectedFile?.path !== resolvedSelectedPath ? /* @__PURE__ */ jsx2(EditorSkeleton, {}) : readError && selectedFile?.path !== resolvedSelectedPath ? /* @__PURE__ */ jsx2(ReadErrorState, { message: readError, onRetry: () => setReloadNonce((n) => n + 1) }) : selectedFile && canWrite && isMarkdownCapable && editorMode === "source" ? /* @__PURE__ */ jsx2(
        SourceEditor,
        {
          path: selectedFile.path,
          content: sourceDraft,
          saving,
          dirty: isDirty,
          onChange: onSourceChange,
          onSave: () => void saveCurrent()
        }
      ) : selectedFile ? renderArtifact({
        file: selectedFile,
        loading: false,
        mode: editorMode,
        canWrite,
        richDraft,
        dirty: isDirty,
        onRichChange,
        onSave: () => void saveCurrent()
      }) : null })
    ] }),
    renderDock && selectedFile && renderDock({
      file: selectedFile,
      open: persistentDock ? true : dockOpen,
      onClose: persistentDock ? () => {
      } : () => setDockOpen(false)
    }),
    /* @__PURE__ */ jsx2(
      ConfirmDialog,
      {
        open: createOpen,
        title: "Create vault file",
        description: activeFolder ? `Add a new document to ${activeFolder}.` : "Add a new document to this vault.",
        confirmLabel: creating ? "Creating\u2026" : "Create",
        confirmDisabled: creating || !createFileName,
        onConfirm: () => void handleCreate(),
        onCancel: () => {
          setCreateOpen(false);
          setNewPath("");
          setCreateError(null);
        },
        children: /* @__PURE__ */ jsxs2("div", { className: "space-y-2", children: [
          /* @__PURE__ */ jsx2(
            "input",
            {
              value: newPath,
              autoFocus: true,
              onChange: (e) => setNewPath(e.target.value),
              placeholder: "e.g. playbooks/new-strategy.md",
              "aria-label": "New file path",
              className: "h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
            }
          ),
          createError && /* @__PURE__ */ jsx2("p", { role: "alert", className: "text-xs text-destructive", children: createError.message })
        ] })
      }
    ),
    /* @__PURE__ */ jsx2(
      ConfirmDialog,
      {
        open: deleteOpen,
        title: "Delete file?",
        description: `This permanently removes ${selectedFile?.path ?? "this file"} from the vault.`,
        confirmLabel: deleting ? "Deleting\u2026" : "Delete file",
        confirmDisabled: deleting,
        destructive: true,
        onConfirm: () => void handleDelete(),
        onCancel: () => {
          setDeleteOpen(false);
          setDeleteError(null);
        },
        children: deleteError && /* @__PURE__ */ jsx2("p", { role: "alert", className: "text-xs text-destructive", children: deleteError.message })
      }
    ),
    /* @__PURE__ */ jsx2(
      ConfirmDialog,
      {
        open: pendingNav !== null,
        title: "Discard unsaved changes?",
        description: "Your edits to this document haven't been saved. Continue and lose them?",
        confirmLabel: "Discard changes",
        destructive: true,
        onConfirm: confirmDiscard,
        onCancel: () => setPendingNav(null)
      }
    )
  ] }) });
}
function SourceEditor({
  path,
  content,
  saving,
  dirty,
  onChange,
  onSave
}) {
  return /* @__PURE__ */ jsxs2("div", { className: "flex h-full min-h-0 flex-col bg-background", children: [
    /* @__PURE__ */ jsxs2("div", { className: "flex items-center justify-between gap-2 border-b border-border px-4 py-2", children: [
      /* @__PURE__ */ jsx2("p", { className: "truncate font-mono text-xs text-muted-foreground", children: path }),
      /* @__PURE__ */ jsxs2("div", { className: "flex shrink-0 items-center gap-2", children: [
        /* @__PURE__ */ jsx2("span", { className: "rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground", children: dirty ? "Unsaved changes" : "Saved" }),
        /* @__PURE__ */ jsx2(
          "button",
          {
            type: "button",
            onClick: onSave,
            disabled: saving || !dirty,
            className: "inline-flex h-7 items-center rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50",
            children: saving ? "Saving\u2026" : "Save"
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ jsx2(
      "textarea",
      {
        value: content,
        onChange: (event) => onChange(event.target.value),
        spellCheck: false,
        "aria-label": "Source editor",
        className: "min-h-0 flex-1 resize-none border-0 bg-background p-4 font-mono text-sm leading-6 text-foreground focus-visible:[outline-offset:-2px]"
      }
    )
  ] });
}

export {
  ConfirmDialog,
  VaultPane
};
//# sourceMappingURL=chunk-ZNLASEO3.js.map