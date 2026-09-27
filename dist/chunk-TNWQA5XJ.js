import {
  joinClasses
} from "./chunk-L7MB2LLM.js";
import {
  CheckGlyph,
  EffortPicker,
  ModelPicker,
  OVERLAY_SHADOW,
  POPOVER_OPTION_FOCUS,
  PopoverSurface,
  pickerRootClass,
  quietPickerTriggerClass,
  usePopover
} from "./chunk-4I76LTZS.js";
import {
  filterCommandPaletteItems
} from "./chunk-SJWIZT7B.js";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_COUNT,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_BINARY_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  attachmentSizeErrorMessage,
  attachmentTotalSizeErrorMessage,
  checkAttachmentType,
  sanitizeAttachmentFileName,
  sniffBinary
} from "./chunk-NU7QSZBR.js";
import {
  snapHarnessToModel,
  snapModelToHarness
} from "./chunk-MCYJON3F.js";

// src/web-react/composer-file-accept.ts
function isAcceptedFileType(file, accept) {
  if (!accept || accept.trim().length === 0) return true;
  const patterns = accept.split(",").map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
  if (patterns.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  return patterns.some((pattern) => {
    const lower = pattern.toLowerCase();
    if (lower.startsWith(".")) return name.endsWith(lower);
    if (lower.endsWith("/*")) {
      const prefix = lower.slice(0, -1);
      if (!type.startsWith(prefix)) return false;
      const subtype = type.slice(prefix.length);
      return subtype.length > 0 && !subtype.includes("/");
    }
    return type === lower;
  });
}
function acceptRejectionReason(file, accept) {
  return `"${file.name}" is not an accepted file type (${accept}).`;
}
function filterAcceptedFiles(files, accept) {
  const list = Array.isArray(files) ? files : Array.from(files);
  const accepted = [];
  const rejected = [];
  for (const file of list) {
    if (isAcceptedFileType(file, accept)) accepted.push(file);
    else rejected.push({ file, reason: acceptRejectionReason(file, accept ?? "") });
  }
  return { accepted, rejected };
}
var IMAGE_EXTENSIONS_BY_MIME = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg", "jpe"],
  "image/jpg": ["jpg", "jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "image/bmp": ["bmp"],
  "image/svg+xml": ["svg"],
  "image/tiff": ["tiff", "tif"],
  "image/x-icon": ["ico"],
  "image/vnd.microsoft.icon": ["ico"]
};
function isGenericImageName(name) {
  return /^(?:image(?:\.[a-z0-9]+)?)?$/i.test(name.trim());
}
function imageExtension(file) {
  const type = file.type.toLowerCase();
  const fromName = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  const mapped = IMAGE_EXTENSIONS_BY_MIME[type];
  const subtype = type.startsWith("image/") ? type.slice("image/".length) : "";
  const bare = subtype.split("+")[0] ?? "";
  const truthful = mapped ?? (/^[a-z0-9]+$/.test(bare) ? [bare] : []);
  if (truthful.length === 0) return fromName ?? null;
  if (fromName !== void 0 && truthful.includes(fromName)) return fromName;
  return truthful[0] ?? null;
}
function takenPastedImageIndexes(names) {
  const taken = /* @__PURE__ */ new Set();
  for (const name of names) {
    const digits = /^pasted-image-(\d+)(?:\.[a-z0-9]+)?$/i.exec(name.trim())?.[1];
    if (digits === void 0) continue;
    const parsed = Number.parseInt(digits, 10);
    if (Number.isSafeInteger(parsed)) taken.add(parsed);
  }
  return taken;
}
function nextFreeIndex(taken, after) {
  const start = Number.isSafeInteger(after) && after >= 0 ? after + 1 : 1;
  for (let candidate = start; Number.isSafeInteger(candidate); candidate += 1) {
    if (!taken.has(candidate)) return candidate;
  }
  for (let candidate = 1; ; candidate += 1) {
    if (!taken.has(candidate)) return candidate;
  }
}
function renamePastedImages(files, startIndex, stagedNames = []) {
  const taken = takenPastedImageIndexes([...stagedNames, ...files.map((file) => file.name)]);
  let nextIndex = startIndex;
  const renamed = files.map((file) => {
    const typed = file.type.startsWith("image/");
    if (!isGenericImageName(file.name) || !typed && file.type !== "") return file;
    const extension = imageExtension(file);
    if (extension === null) return file;
    nextIndex = nextFreeIndex(taken, nextIndex);
    taken.add(nextIndex);
    return new File([file], `pasted-image-${nextIndex}.${extension}`, {
      type: file.type,
      lastModified: file.lastModified
    });
  });
  return { files: renamed, nextIndex };
}

// src/web-react/use-dictation.ts
import { useCallback, useEffect, useRef, useState } from "react";
var PREFERRED_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
function pickDictationMimeType() {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return void 0;
  }
  for (const type of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return void 0;
}
function detectDictationSupport() {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function" && typeof MediaRecorder !== "undefined";
}
function dictationErrorMessage(error) {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") return "Microphone access was denied \u2014 allow it in the browser to dictate.";
    if (error.name === "NotFoundError") return "No microphone found on this device.";
  }
  return "Could not start recording.";
}
function formatDictationElapsed(totalSeconds) {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
function releaseStream(stream) {
  for (const track of stream.getTracks()) track.stop();
}
function useDictation({ onDictate, onError }) {
  const [supported] = useState(detectDictationSupport);
  const [recording, setRecording] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const sessionRef = useRef(null);
  const cancelPendingStartRef = useRef(null);
  const callbacksRef = useRef({ onDictate, onError });
  callbacksRef.current = { onDictate, onError };
  useEffect(() => {
    if (!recording) return;
    setElapsedSeconds(0);
    const id = setInterval(() => setElapsedSeconds((s) => s + 1), 1e3);
    return () => clearInterval(id);
  }, [recording]);
  const teardown = useCallback((cancelled) => {
    const session = sessionRef.current;
    if (session === null) return;
    session.cancelled = session.cancelled || cancelled;
    sessionRef.current = null;
    releaseStream(session.stream);
    setRecording(false);
  }, []);
  const stop = useCallback(() => {
    cancelPendingStartRef.current?.();
    cancelPendingStartRef.current = null;
    const session = sessionRef.current;
    if (session === null || session.cancelled) return;
    if (session.recorder.state !== "inactive") session.recorder.stop();
  }, []);
  const start = useCallback(() => {
    if (!supported) return;
    if (sessionRef.current !== null || cancelPendingStartRef.current !== null) return;
    let pendingCancelled = false;
    cancelPendingStartRef.current = () => {
      pendingCancelled = true;
    };
    navigator.mediaDevices.getUserMedia({ audio: true }).then(
      (stream) => {
        cancelPendingStartRef.current = null;
        if (pendingCancelled) {
          releaseStream(stream);
          return;
        }
        const mimeType = pickDictationMimeType();
        const recorder = new MediaRecorder(stream, mimeType === void 0 ? void 0 : { mimeType });
        const session = {
          stream,
          recorder,
          chunks: [],
          mimeType: recorder.mimeType || mimeType || "",
          startedAt: Date.now(),
          cancelled: false
        };
        sessionRef.current = session;
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) session.chunks.push(event.data);
        };
        recorder.onstop = () => {
          teardown(session.cancelled);
          if (session.cancelled) return;
          const blob = new Blob(session.chunks, { type: session.mimeType });
          if (blob.size === 0) {
            callbacksRef.current.onError?.("Nothing was recorded.");
            return;
          }
          const durationSeconds = Math.max(0, Math.round((Date.now() - session.startedAt) / 1e3));
          callbacksRef.current.onDictate({ blob, mimeType: session.mimeType, durationSeconds });
        };
        recorder.onerror = () => {
          teardown(true);
          callbacksRef.current.onError?.("Recording stopped unexpectedly.");
        };
        recorder.start();
        setRecording(true);
      },
      (error) => {
        cancelPendingStartRef.current = null;
        if (pendingCancelled) return;
        callbacksRef.current.onError?.(dictationErrorMessage(error));
      }
    );
  }, [supported, teardown]);
  useEffect(
    () => () => {
      cancelPendingStartRef.current?.();
      cancelPendingStartRef.current = null;
      const session = sessionRef.current;
      if (session === null) return;
      session.cancelled = true;
      sessionRef.current = null;
      try {
        if (session.recorder.state !== "inactive") session.recorder.stop();
      } finally {
        releaseStream(session.stream);
      }
    },
    []
  );
  return { supported, recording, elapsedSeconds, start, stop };
}

// src/web-react/chat-composer.tsx
import {
  Component,
  lazy,
  Suspense,
  useCallback as useCallback2,
  useEffect as useEffect2,
  useMemo,
  useId,
  useRef as useRef2,
  useState as useState2
} from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
function createLazyMentionEditor() {
  return lazy(() => import("./mention-editor-4PYZJM5A.js").then((m) => m.loadMentionEditor()));
}
var MentionEditorBoundary = class extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return /* @__PURE__ */ jsxs(Fragment, { children: [
      this.props.fallback,
      /* @__PURE__ */ jsx(
        "div",
        {
          role: "alert",
          className: "rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive",
          children: "Mentions are unavailable. You can still send."
        }
      )
    ] });
  }
};
var IS_APPLE_PLATFORM = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
function SendGlyph({ className }) {
  return /* @__PURE__ */ jsx("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx("path", { d: "M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" }) });
}
function StopGlyph({ className }) {
  return /* @__PURE__ */ jsx("svg", { className, viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": true, children: /* @__PURE__ */ jsx("rect", { x: "6", y: "6", width: "12", height: "12", rx: "2" }) });
}
function ArrowUpGlyph({ className }) {
  return /* @__PURE__ */ jsx("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx("path", { d: "M12 19V5M5 12l7-7 7 7" }) });
}
function PaperclipGlyph({ className }) {
  return /* @__PURE__ */ jsx("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx("path", { d: "m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" }) });
}
function FolderGlyph({ className }) {
  return /* @__PURE__ */ jsxs("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
    /* @__PURE__ */ jsx("path", { d: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" }),
    /* @__PURE__ */ jsx("path", { d: "M12 10v6m-3-3h6" })
  ] });
}
function CloseGlyph({ className }) {
  return /* @__PURE__ */ jsx("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx("path", { d: "M18 6 6 18M6 6l12 12" }) });
}
function RetryGlyph({ className }) {
  return /* @__PURE__ */ jsxs("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
    /* @__PURE__ */ jsx("path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }),
    /* @__PURE__ */ jsx("path", { d: "M3 3v5h5" })
  ] });
}
function UploadGlyph({ className }) {
  return /* @__PURE__ */ jsx("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx("path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" }) });
}
function MicGlyph({ className }) {
  return /* @__PURE__ */ jsxs("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
    /* @__PURE__ */ jsx("rect", { x: "9", y: "2", width: "6", height: "12", rx: "3" }),
    /* @__PURE__ */ jsx("path", { d: "M5 10v1a7 7 0 0 0 14 0v-1M12 18v4" })
  ] });
}
var DEFAULT_MAX_HEIGHT = 168;
var LINE_HEIGHT = 24;
var TEXTAREA_PADDING_Y = 8;
var DEFAULT_SEND_FAILURE = "Message not sent. Your draft is still here \u2014 try again.";
function isRejectedOutcome(outcome) {
  return typeof outcome === "object" && outcome !== null && outcome.ok === false;
}
function isPromise(value) {
  return typeof value?.then === "function";
}
function sendFailureText(error, fallback) {
  if (typeof error === "object" && error !== null && "ok" in error) {
    const named = error.error;
    if (typeof named === "string" && named.trim() !== "") return named;
    return fallback;
  }
  if (typeof error === "string" && error.trim() !== "") return error;
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return fallback;
}
function ChatComposer({
  onSend,
  onSendParts,
  onSendFailed,
  sendFailureMessage = DEFAULT_SEND_FAILURE,
  onCancel,
  isStreaming = false,
  disabled = false,
  placeholder = "Message the agent\u2026",
  value,
  onValueChange,
  initialValue,
  seed,
  onSeedApplied,
  controls,
  controlsPlacement = "inline",
  onAttach,
  onAttachFolder,
  pendingFiles = [],
  onRemoveFile,
  onRetryFile,
  accept,
  onRejectFiles,
  dropTitle = "Drop files to add context",
  dropDescription = "They attach to your next message.",
  contextItems = [],
  canSubmitAttachmentsOnly = false,
  attachmentsNotReadyMessage,
  canSubmitWhileBusy = false,
  autoFocus,
  minRows = 2,
  maxHeight = DEFAULT_MAX_HEIGHT,
  trailing,
  mention,
  slashCommands,
  onDictate,
  onDictateError,
  focusShortcut = true,
  floating = false,
  sendLabel = "Send",
  sendVariant = "pill",
  sendTone = "contrast",
  className
}) {
  const isControlled = value !== void 0;
  const [internal, setInternal] = useState2(initialValue ?? "");
  const text = isControlled ? value : internal;
  const MentionEditor = useMemo(createLazyMentionEditor, []);
  const textRef = useRef2(text);
  textRef.current = text;
  const textareaRef = useRef2(null);
  const richFocusRef = useRef2(null);
  const registerRichFocus = useCallback2((focus) => {
    richFocusRef.current = focus;
  }, []);
  const fileInputRef = useRef2(null);
  const folderInputRef = useRef2(null);
  const [dragOver, setDragOver] = useState2(false);
  const dragDepth = useRef2(0);
  const pastedImageCount = useRef2(0);
  const setText = useCallback2(
    (next) => {
      if (!isControlled) setInternal(next);
      onValueChange?.(next);
    },
    [isControlled, onValueChange]
  );
  const [dictateError, setDictateError] = useState2(null);
  const handleDictated = useCallback2(
    (audio) => {
      setDictateError(null);
      onDictate?.(audio);
    },
    [onDictate]
  );
  const handleDictateError = useCallback2(
    (message) => {
      setDictateError(message);
      onDictateError?.(message);
    },
    [onDictateError]
  );
  const dictation = useDictation({ onDictate: handleDictated, onError: handleDictateError });
  useEffect2(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [text, maxHeight, minRows]);
  const prevSeedRef = useRef2(null);
  const pendingCaretRef = useRef2(null);
  useEffect2(() => {
    const prev = prevSeedRef.current;
    prevSeedRef.current = seed ?? null;
    if (seed == null || seed === prev || isControlled) return;
    setText(seed);
    onSeedApplied?.();
    const el = textareaRef.current;
    if (el && el.value === seed) {
      el.focus();
      el.setSelectionRange(seed.length, seed.length);
    } else {
      pendingCaretRef.current = seed;
    }
  }, [seed, setText, onSeedApplied, isControlled]);
  useEffect2(() => {
    if (pendingCaretRef.current == null || pendingCaretRef.current !== text)
      return;
    pendingCaretRef.current = null;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(text.length, text.length);
  }, [text]);
  const restoreCaretRef = useRef2(null);
  useEffect2(() => {
    const pending = restoreCaretRef.current;
    if (!pending || pending.text !== text) return;
    restoreCaretRef.current = null;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const start = Math.min(pending.start, text.length);
    const end = Math.min(pending.end, text.length);
    el.setSelectionRange(start, end);
  }, [text]);
  const mentionEnabled = mention != null;
  useEffect2(() => {
    if (!focusShortcut || disabled) return;
    function onKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
        if (mentionEnabled) {
          const focus = richFocusRef.current;
          e.preventDefault();
          if (focus) focus();
          else textareaRef.current?.focus();
        } else {
          e.preventDefault();
          textareaRef.current?.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [focusShortcut, disabled, mentionEnabled]);
  const sendableFiles = canSubmitAttachmentsOnly ? pendingFiles : pendingFiles.filter((f) => f.status === "ready");
  const hasSendable = text.trim().length > 0 || sendableFiles.length > 0;
  const sendBlockedByStream = isStreaming && !canSubmitWhileBusy;
  const canSend = hasSendable && !sendBlockedByStream && !disabled;
  const [failedSend, setFailedSend] = useState2(null);
  const failSend = useCallback2(
    (error, draft, trimmed, parts, caret) => {
      const message = sendFailureText(error, sendFailureMessage);
      const restored = textRef.current === "";
      if (restored) {
        const el = textareaRef.current;
        setText(draft);
        if (el && el.value === draft) {
          el.focus();
          el.setSelectionRange(Math.min(caret.start, draft.length), Math.min(caret.end, draft.length));
        } else {
          restoreCaretRef.current = { text: draft, start: caret.start, end: caret.end };
        }
      }
      setFailedSend({ message, text: draft, trimmed, parts, restored });
      onSendFailed?.({ message, text: draft, parts, error, restored });
    },
    [onSendFailed, sendFailureMessage, setText]
  );
  const dispatchSend = useCallback2(
    (draft, trimmed, parts, caret) => {
      let outcome;
      try {
        outcome = onSendParts ? onSendParts(trimmed, parts) : onSend?.(trimmed);
      } catch (error) {
        failSend(error, draft, trimmed, parts, caret);
        return;
      }
      if (isPromise(outcome)) {
        void outcome.then(
          (settled) => {
            if (isRejectedOutcome(settled)) failSend(settled, draft, trimmed, parts, caret);
          },
          (error) => failSend(error, draft, trimmed, parts, caret)
        );
        return;
      }
      if (isRejectedOutcome(outcome)) failSend(outcome, draft, trimmed, parts, caret);
    },
    [onSend, onSendParts, failSend]
  );
  const send = useCallback2(() => {
    const trimmed = text.trim();
    if (sendBlockedByStream || disabled) return;
    const readyFiles = pendingFiles.filter((f) => f.status === "ready");
    const sendable = canSubmitAttachmentsOnly ? pendingFiles : readyFiles;
    if (!trimmed && sendable.length === 0) return;
    if (!trimmed && readyFiles.length === 0) {
      const message = attachmentsNotReadyMessage ?? (pendingFiles.some((f) => f.status === "error") ? "Retry or remove the failed attachment before sending." : "Wait for the attachment to finish uploading.");
      setFailedSend({ message, text: "", trimmed: "", parts: [], restored: true });
      return;
    }
    const parts = onSendParts ? readyFiles.filter((f) => f.part).map((f) => f.part) : [];
    const el = textareaRef.current;
    const caret = { start: el?.selectionStart ?? text.length, end: el?.selectionEnd ?? text.length };
    setFailedSend(null);
    setText("");
    textRef.current = "";
    dispatchSend(text, trimmed, parts, caret);
  }, [
    text,
    sendBlockedByStream,
    disabled,
    canSubmitAttachmentsOnly,
    attachmentsNotReadyMessage,
    onSendParts,
    pendingFiles,
    setText,
    dispatchSend
  ]);
  const retryFailedSend = useCallback2(() => {
    const failure = failedSend;
    if (!failure || sendBlockedByStream || disabled) return;
    setFailedSend(null);
    const caret = { start: failure.text.length, end: failure.text.length };
    dispatchSend(failure.text, failure.trimmed, failure.parts, caret);
  }, [failedSend, sendBlockedByStream, disabled, dispatchSend]);
  const slashPanelRef = useRef2(null);
  const cardRef = useRef2(null);
  const slashListId = useId();
  const [slashActive, setSlashActive] = useState2(0);
  const [slashDismissedFor, setSlashDismissedFor] = useState2(null);
  const slashToken = !mention && slashCommands && slashCommands.length > 0 ? /^\/(\S*)$/.exec(text)?.[1] : void 0;
  const slashOpen = slashToken !== void 0 && text !== slashDismissedFor;
  const slashItems = useMemo(
    () => (slashCommands ?? []).map((command) => ({
      id: command.name,
      group: "Commands",
      label: `/${command.name}`,
      description: command.description,
      keywords: [command.name, command.description]
    })),
    [slashCommands]
  );
  const slashFiltered = useMemo(
    () => slashToken === void 0 ? [] : filterCommandPaletteItems(slashItems, slashToken),
    [slashItems, slashToken]
  );
  const slashActiveIndex = slashFiltered.length === 0 ? 0 : Math.min(slashActive, slashFiltered.length - 1);
  useEffect2(() => {
    setSlashActive(0);
  }, [slashToken]);
  useEffect2(() => {
    if (!slashOpen) return;
    document.getElementById(`${slashListId}-${slashActiveIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [slashOpen, slashActiveIndex, slashListId]);
  useEffect2(() => {
    if (!slashOpen) return;
    function onMouseDown(e) {
      const target = e.target;
      if (cardRef.current?.contains(target)) return;
      if (slashPanelRef.current?.contains(target)) return;
      setSlashDismissedFor(textRef.current);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [slashOpen]);
  const pickSlash = useCallback2(
    (name) => {
      const command = slashCommands?.find((c) => c.name === name);
      setText("");
      setSlashDismissedFor(null);
      command?.run();
    },
    [slashCommands, setText]
  );
  const handleKeyDown = (e) => {
    if (e.nativeEvent.isComposing) return;
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (slashFiltered.length > 0) setSlashActive((slashActiveIndex + 1) % slashFiltered.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (slashFiltered.length > 0)
          setSlashActive((slashActiveIndex - 1 + slashFiltered.length) % slashFiltered.length);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey || e.key === "Tab") {
        const item = slashFiltered[slashActiveIndex];
        if (item) {
          e.preventDefault();
          pickSlash(item.id);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissedFor(text);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  const deliverFiles = useCallback2(
    (files, original) => {
      if (!onAttach || files.length === 0) return;
      const { accepted, rejected } = filterAcceptedFiles(files, accept);
      if (rejected.length > 0) onRejectFiles?.(rejected);
      if (accepted.length === 0) return;
      const unchanged = accepted.length === original.length && accepted.every((file, i) => file === original[i]);
      if (unchanged) {
        onAttach(original);
        return;
      }
      const transfer = new DataTransfer();
      for (const file of accepted) transfer.items.add(file);
      onAttach(transfer.files);
    },
    [onAttach, onRejectFiles, accept]
  );
  const handleFileChange = (e) => {
    if (e.target.files?.length) deliverFiles(Array.from(e.target.files), e.target.files);
    e.target.value = "";
  };
  const ingestPastedFiles = (clipboardFiles) => {
    if (!onAttach || clipboardFiles.length === 0) return false;
    const { files, nextIndex } = renamePastedImages(
      Array.from(clipboardFiles),
      pastedImageCount.current,
      pendingFiles.map((f) => f.name)
    );
    pastedImageCount.current = nextIndex;
    deliverFiles(files, clipboardFiles);
    return true;
  };
  const handlePaste = (e) => {
    const clipboardFiles = e.clipboardData?.files;
    if (!clipboardFiles || clipboardFiles.length === 0) return;
    if (ingestPastedFiles(clipboardFiles)) e.preventDefault();
  };
  const handleFolderChange = (e) => {
    if (e.target.files?.length) (onAttachFolder ?? onAttach)?.(e.target.files);
    e.target.value = "";
  };
  const handleDragEnter = useCallback2((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current++;
    if (e.dataTransfer?.types.includes("Files")) setDragOver(true);
  }, []);
  const handleDragLeave = useCallback2((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current--;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragOver(false);
    }
  }, []);
  const handleDragOver = useCallback2((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }, []);
  const handleDrop = useCallback2(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepth.current = 0;
      setDragOver(false);
      const files = e.dataTransfer?.files;
      if (files?.length) deliverFiles(Array.from(files), files);
    },
    [deliverFiles]
  );
  const folderChips = pendingFiles.filter((f) => f.kind === "folder");
  const fileChips = pendingFiles.filter((f) => f.kind !== "folder");
  const showAbove = controls != null && controlsPlacement === "above";
  const showInline = controls != null && !showAbove;
  const inputMinHeight = minRows * LINE_HEIGHT + TEXTAREA_PADDING_Y;
  const textareaInput = /* @__PURE__ */ jsx(
    "textarea",
    {
      ref: textareaRef,
      value: text,
      onChange: (e) => setText(e.target.value),
      onKeyDown: handleKeyDown,
      onPaste: onAttach ? handlePaste : void 0,
      placeholder,
      disabled,
      autoFocus,
      rows: minRows,
      style: { minHeight: inputMinHeight, maxHeight },
      "aria-label": "Message input",
      className: "w-full resize-none bg-transparent px-1.5 py-1 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
    }
  );
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: `relative ${className ?? ""}`,
      onDragEnter: onAttach ? handleDragEnter : void 0,
      onDragLeave: onAttach ? handleDragLeave : void 0,
      onDragOver: onAttach ? handleDragOver : void 0,
      onDrop: onAttach ? handleDrop : void 0,
      children: [
        dragOver && /* @__PURE__ */ jsx("div", { className: "pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-card", children: /* @__PURE__ */ jsxs("div", { className: "text-center", children: [
          /* @__PURE__ */ jsx("span", { className: "mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary", children: /* @__PURE__ */ jsx(UploadGlyph, { className: "h-5 w-5" }) }),
          /* @__PURE__ */ jsx("p", { className: "text-sm font-semibold text-foreground", children: dropTitle }),
          /* @__PURE__ */ jsx("p", { className: "mt-0.5 text-xs text-muted-foreground", children: dropDescription })
        ] }) }),
        showAbove && /* @__PURE__ */ jsx("div", { className: "mb-1.5 flex flex-wrap items-center gap-1.5 px-1", children: controls }),
        dictateError && /* @__PURE__ */ jsxs(
          "div",
          {
            role: "alert",
            "data-testid": "composer-dictate-error",
            className: "mb-2 flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive",
            children: [
              /* @__PURE__ */ jsx("span", { className: "min-w-0 flex-1", children: dictateError }),
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  "aria-label": "Dismiss dictation error",
                  onClick: () => setDictateError(null),
                  className: "shrink-0 font-medium underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50",
                  children: "Dismiss"
                }
              )
            ]
          }
        ),
        failedSend && /* @__PURE__ */ jsxs(
          "div",
          {
            role: "alert",
            "data-testid": "composer-send-error",
            className: "mb-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive",
            children: [
              /* @__PURE__ */ jsxs("div", { className: "flex items-start gap-2", children: [
                /* @__PURE__ */ jsx("span", { className: "min-w-0 flex-1", children: failedSend.message }),
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    type: "button",
                    "aria-label": "Dismiss send error",
                    onClick: () => setFailedSend(null),
                    className: "shrink-0 font-medium underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50",
                    children: "Dismiss"
                  }
                )
              ] }),
              !failedSend.restored && /* @__PURE__ */ jsxs("div", { className: "mt-1.5", children: [
                /* @__PURE__ */ jsx(
                  "p",
                  {
                    "data-testid": "composer-unsent-draft",
                    className: "max-h-20 overflow-y-auto whitespace-pre-wrap rounded-lg border border-destructive/30 bg-card px-2 py-1 text-foreground",
                    children: failedSend.text
                  }
                ),
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    type: "button",
                    "aria-label": "Retry sending the unsent message",
                    onClick: retryFailedSend,
                    disabled: sendBlockedByStream || disabled,
                    className: "mt-1.5 font-medium underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50",
                    children: "Retry"
                  }
                )
              ] })
            ]
          }
        ),
        contextItems.length > 0 && /* @__PURE__ */ jsx("div", { "aria-label": "Message context", className: "mb-2 flex min-w-0 flex-wrap gap-1.5", children: contextItems.map((item) => /* @__PURE__ */ jsxs(
          "span",
          {
            className: "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs text-primary",
            children: [
              item.icon && /* @__PURE__ */ jsx("span", { className: "shrink-0", "aria-hidden": true, children: item.icon }),
              /* @__PURE__ */ jsx("span", { className: "min-w-0 truncate", children: item.label }),
              item.onRemove && /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  "aria-label": `Remove context ${item.label}`,
                  onClick: item.onRemove,
                  className: "shrink-0 rounded p-0.5 text-primary/70 transition hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  children: /* @__PURE__ */ jsx(CloseGlyph, { className: "h-3 w-3" })
                }
              )
            ]
          },
          item.id
        )) }),
        pendingFiles.length > 0 && /* @__PURE__ */ jsx("div", { className: "mb-2 flex flex-wrap gap-1.5", children: [...folderChips, ...fileChips].map((f) => {
          const isError = f.status === "error";
          return /* @__PURE__ */ jsxs(
            "span",
            {
              title: isError ? f.errorMessage : void 0,
              className: `inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${isError ? "border-destructive/40 text-destructive" : "border-border bg-secondary text-foreground"} ${f.status === "pending" ? "opacity-60" : ""}`,
              children: [
                f.kind !== "folder" && f.previewUrl ? /* @__PURE__ */ jsx("img", { src: f.previewUrl, alt: "", className: "h-8 w-8 shrink-0 rounded object-cover" }) : f.kind === "folder" ? /* @__PURE__ */ jsx(FolderGlyph, { className: "h-3 w-3 shrink-0" }) : /* @__PURE__ */ jsx(PaperclipGlyph, { className: "h-3 w-3 shrink-0" }),
                /* @__PURE__ */ jsx("span", { className: "max-w-[150px] truncate", children: f.name }),
                f.fileCount !== void 0 && /* @__PURE__ */ jsxs("span", { className: "text-muted-foreground", children: [
                  "(",
                  f.fileCount,
                  ")"
                ] }),
                f.status === "uploading" && /* @__PURE__ */ jsx("span", { className: "h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" }),
                isError && f.errorMessage && /* @__PURE__ */ jsx("span", { className: "max-w-[150px] truncate text-destructive/80", children: f.errorMessage }),
                isError && onRetryFile && /* @__PURE__ */ jsx(
                  "button",
                  {
                    type: "button",
                    "aria-label": `Retry upload ${f.name}`,
                    onClick: () => onRetryFile(f.id),
                    className: "rounded p-0.5 text-muted-foreground transition hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    children: /* @__PURE__ */ jsx(RetryGlyph, { className: "h-3 w-3" })
                  }
                ),
                onRemoveFile && /* @__PURE__ */ jsx(
                  "button",
                  {
                    type: "button",
                    "aria-label": `Remove ${f.name}`,
                    onClick: () => onRemoveFile(f.id),
                    className: "rounded p-0.5 text-muted-foreground transition hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    children: /* @__PURE__ */ jsx(CloseGlyph, { className: "h-3 w-3" })
                  }
                )
              ]
            },
            f.id
          );
        }) }),
        /* @__PURE__ */ jsxs(
          "div",
          {
            ref: cardRef,
            "data-testid": "composer-card",
            className: `flex flex-col gap-1.5 rounded-2xl border border-card-edge bg-card px-3 py-2.5 transition focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15 ${floating ? "shadow-raised" : ""}`,
            children: [
              mention ? (
                // The basic textarea stays usable through download, initialization,
                // and failure.
                /* @__PURE__ */ jsx(
                  MentionEditorBoundary,
                  {
                    fallback: textareaInput,
                    children: /* @__PURE__ */ jsx(Suspense, { fallback: textareaInput, children: /* @__PURE__ */ jsx(
                      MentionEditor,
                      {
                        value: text,
                        onChange: setText,
                        onSubmit: send,
                        placeholder,
                        disabled,
                        autoFocus,
                        minHeight: inputMinHeight,
                        maxHeight,
                        mention,
                        fallback: textareaInput,
                        registerFocus: registerRichFocus,
                        onPasteFiles: onAttach ? ingestPastedFiles : void 0
                      }
                    ) })
                  }
                )
              ) : (
                // The card draws the keyboard indicator through `focus-within:`, so
                // the input does not need a second outline.
                textareaInput
              ),
              /* @__PURE__ */ jsxs("div", { className: "flex items-end gap-2", children: [
                onAttach && /* @__PURE__ */ jsxs(Fragment, { children: [
                  /* @__PURE__ */ jsx(
                    "button",
                    {
                      type: "button",
                      onClick: () => fileInputRef.current?.click(),
                      disabled,
                      "aria-label": "Attach files",
                      title: "Attach files",
                      className: "shrink-0 rounded-lg p-2 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      children: /* @__PURE__ */ jsx(PaperclipGlyph, { className: "h-4 w-4" })
                    }
                  ),
                  /* @__PURE__ */ jsx("input", { ref: fileInputRef, type: "file", multiple: true, className: "hidden", accept, onChange: handleFileChange })
                ] }),
                onAttachFolder && /* @__PURE__ */ jsxs(Fragment, { children: [
                  /* @__PURE__ */ jsx(
                    "button",
                    {
                      type: "button",
                      onClick: () => folderInputRef.current?.click(),
                      disabled,
                      "aria-label": "Attach folder",
                      title: "Attach folder",
                      className: "shrink-0 rounded-lg p-2 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      children: /* @__PURE__ */ jsx(FolderGlyph, { className: "h-4 w-4" })
                    }
                  ),
                  /* @__PURE__ */ jsx(
                    "input",
                    {
                      ref: folderInputRef,
                      type: "file",
                      multiple: true,
                      className: "hidden",
                      onChange: handleFolderChange,
                      ...{ webkitdirectory: "" }
                    }
                  )
                ] }),
                /* @__PURE__ */ jsx(
                  "div",
                  {
                    "data-testid": "composer-controls",
                    className: "flex min-w-0 flex-1 flex-wrap items-center gap-1.5",
                    children: showInline && controls
                  }
                ),
                trailing && /* @__PURE__ */ jsx("div", { "data-testid": "composer-trailing", className: "flex shrink-0 items-center gap-1.5", children: trailing }),
                onDictate && dictation.supported ? dictation.recording ? /* @__PURE__ */ jsxs("div", { className: "flex shrink-0 items-center gap-1.5", children: [
                  /* @__PURE__ */ jsx("span", { "aria-hidden": "true", className: "h-2 w-2 animate-pulse rounded-full bg-destructive" }),
                  /* @__PURE__ */ jsx(
                    "span",
                    {
                      "aria-hidden": "true",
                      "data-testid": "composer-dictate-elapsed",
                      className: "text-xs tabular-nums text-muted-foreground",
                      children: formatDictationElapsed(dictation.elapsedSeconds)
                    }
                  ),
                  /* @__PURE__ */ jsx("span", { role: "status", className: "sr-only", children: "Recording" }),
                  /* @__PURE__ */ jsx(
                    "button",
                    {
                      type: "button",
                      onClick: dictation.stop,
                      "aria-label": "Stop dictation",
                      title: "Stop dictation",
                      className: "shrink-0 rounded-lg p-2 text-destructive transition hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      children: /* @__PURE__ */ jsx(StopGlyph, { className: "h-4 w-4" })
                    }
                  )
                ] }) : /* @__PURE__ */ jsx(
                  "button",
                  {
                    type: "button",
                    onClick: dictation.start,
                    disabled,
                    "aria-label": "Dictate message",
                    title: "Dictate message",
                    className: "shrink-0 rounded-lg p-2 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    children: /* @__PURE__ */ jsx(MicGlyph, { className: "h-4 w-4" })
                  }
                ) : null,
                isStreaming ? sendVariant === "icon" ? /* @__PURE__ */ jsx(
                  "button",
                  {
                    type: "button",
                    onClick: onCancel,
                    "aria-label": "Stop response",
                    title: "Stop",
                    className: "inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border border-border bg-transparent text-foreground transition hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    children: /* @__PURE__ */ jsx(StopGlyph, { className: "h-3 w-3" })
                  }
                ) : /* @__PURE__ */ jsxs(
                  "button",
                  {
                    type: "button",
                    onClick: onCancel,
                    "aria-label": "Stop response",
                    className: "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-destructive/15 px-3.5 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50",
                    children: [
                      /* @__PURE__ */ jsx(StopGlyph, { className: "h-3.5 w-3.5" }),
                      /* @__PURE__ */ jsx("span", { children: "Stop" })
                    ]
                  }
                ) : sendVariant === "icon" ? /* @__PURE__ */ jsx(
                  "button",
                  {
                    type: "button",
                    onClick: send,
                    disabled: !canSend,
                    "aria-label": sendLabel,
                    title: sendLabel,
                    className: `inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full ${sendTone === "primary" ? "bg-primary text-primary-foreground" : "bg-foreground text-background"} transition ${sendTone === "primary" ? "hover:bg-primary/90" : "hover:opacity-90"} disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card`,
                    children: /* @__PURE__ */ jsx(ArrowUpGlyph, { className: "h-4 w-4" })
                  }
                ) : /* @__PURE__ */ jsxs(
                  "button",
                  {
                    type: "button",
                    onClick: send,
                    disabled: !canSend,
                    "aria-label": sendLabel,
                    className: "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card",
                    children: [
                      /* @__PURE__ */ jsx(SendGlyph, { className: "h-3.5 w-3.5" }),
                      /* @__PURE__ */ jsx("span", { children: sendLabel })
                    ]
                  }
                )
              ] })
            ]
          }
        ),
        /* @__PURE__ */ jsxs(
          PopoverSurface,
          {
            open: slashOpen,
            id: slashListId,
            role: "listbox",
            triggerRef: textareaRef,
            panelRef: slashPanelRef,
            className: `w-80 overflow-y-auto rounded-xl border border-card-edge bg-popover p-1 ${OVERLAY_SHADOW}`,
            children: [
              slashFiltered.length === 0 && /* @__PURE__ */ jsx("div", { className: "px-3 py-4 text-center text-sm text-muted-foreground", children: "No matching commands" }),
              slashFiltered.map((item, index) => /* @__PURE__ */ jsxs(
                "button",
                {
                  type: "button",
                  role: "option",
                  "aria-selected": index === slashActiveIndex,
                  id: `${slashListId}-${index}`,
                  onMouseDown: (e) => e.preventDefault(),
                  onMouseMove: () => setSlashActive(index),
                  onClick: () => pickSlash(item.id),
                  className: `flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm transition ${POPOVER_OPTION_FOCUS} ${index === slashActiveIndex ? "bg-accent" : "hover:bg-accent"}`,
                  children: [
                    /* @__PURE__ */ jsx("span", { className: "shrink-0 font-medium text-foreground", children: item.label }),
                    /* @__PURE__ */ jsx("span", { className: "truncate text-xs text-muted-foreground", children: item.description })
                  ]
                },
                item.id
              ))
            ]
          }
        ),
        focusShortcut && /* @__PURE__ */ jsx("div", { className: "mt-1.5 flex justify-end px-1", children: /* @__PURE__ */ jsxs("span", { className: "text-xs text-muted-foreground", children: [
          /* @__PURE__ */ jsx("kbd", { className: "rounded border border-border bg-background px-1 py-0.5 text-xs", children: IS_APPLE_PLATFORM ? "Cmd" : "Ctrl" }),
          /* @__PURE__ */ jsx("kbd", { className: "ml-0.5 rounded border border-border bg-background px-1 py-0.5 text-xs", children: "L" }),
          /* @__PURE__ */ jsx("span", { className: "ml-1", children: "to focus" })
        ] }) })
      ]
    }
  );
}

// src/web-react/use-composer-attachments.ts
import { useCallback as useCallback3, useEffect as useEffect3, useMemo as useMemo2, useRef as useRef3, useState as useState3 } from "react";
function newId() {
  const cryptoObject = globalThis.crypto;
  if (typeof cryptoObject?.randomUUID === "function") return cryptoObject.randomUUID();
  return `att-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function dedupeName(name, taken) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let n = 2;
  let candidate = `${base}-${n}${ext}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${base}-${n}${ext}`;
  }
  return candidate;
}
function kindForMime(mime) {
  return mime.startsWith("image/") ? "image" : "file";
}
async function parseUploadError(res) {
  const detail = await res.json().catch(() => null);
  if (detail && typeof detail === "object" && "error" in detail) {
    const error = detail.error;
    if (typeof error === "string" && error) return error;
    if (error && typeof error === "object" && "message" in error) {
      const message = error.message;
      if (typeof message === "string" && message) return message;
    }
  }
  return `Upload failed (${res.status})`;
}
var NO_UPLOAD_TARGET_MESSAGE = "No upload destination configured (pass uploadUrl or buildUploadRequest)";
function useComposerAttachments(options) {
  const optionsRef = useRef3(options);
  optionsRef.current = options;
  const [staged, setStagedState] = useState3([]);
  const stagedRef = useRef3([]);
  const controllersRef = useRef3(/* @__PURE__ */ new Map());
  const setStaged = useCallback3(
    (updater) => {
      const next = typeof updater === "function" ? updater(stagedRef.current) : updater;
      stagedRef.current = next;
      setStagedState(next);
    },
    []
  );
  const upload = useCallback3(
    async (id, file, name) => {
      const opts = optionsRef.current;
      setStaged(
        (prev) => prev.map((s) => s.id === id ? { ...s, status: "uploading", errorMessage: void 0 } : s)
      );
      const controller = new AbortController();
      controllersRef.current.set(id, controller);
      const form = new FormData();
      form.append("file", file, name);
      const request = opts.buildUploadRequest ? opts.buildUploadRequest({ file, name, form }) : opts.uploadUrl ? { url: opts.uploadUrl } : null;
      if (!request) {
        setStaged(
          (prev) => prev.map(
            (s) => s.id === id ? { ...s, status: "error", errorMessage: NO_UPLOAD_TARGET_MESSAGE } : s
          )
        );
        opts.onError?.(NO_UPLOAD_TARGET_MESSAGE);
        controllersRef.current.delete(id);
        return;
      }
      try {
        const res = await fetch(request.url, {
          method: "POST",
          credentials: "same-origin",
          ...request.init,
          body: form,
          signal: controller.signal
        });
        if (!res.ok) {
          const message = await parseUploadError(res);
          setStaged(
            (prev) => prev.map((s) => s.id === id ? { ...s, status: "error", errorMessage: message } : s)
          );
          opts.onError?.(message);
          return;
        }
        const data = await res.json();
        const uploaded = data.files?.[0];
        if (!uploaded) {
          const message = "Upload returned no file";
          setStaged(
            (prev) => prev.map((s) => s.id === id ? { ...s, status: "error", errorMessage: message } : s)
          );
          opts.onError?.(message);
          return;
        }
        setStaged(
          (prev) => prev.map((s) => s.id === id ? { ...s, status: "ready", reference: uploaded } : s)
        );
      } catch (err) {
        if (err.name === "AbortError") return;
        const message = err instanceof Error && err.message ? err.message : "Upload failed \u2014 check your connection";
        setStaged(
          (prev) => prev.map((s) => s.id === id ? { ...s, status: "error", errorMessage: message } : s)
        );
        opts.onError?.(message);
      } finally {
        controllersRef.current.delete(id);
      }
    },
    [setStaged]
  );
  const addFiles = useCallback3(
    async (files) => {
      const opts = optionsRef.current;
      const enabled2 = opts.enabled ?? true;
      if (!enabled2) {
        opts.onReject?.("Attachments are disabled");
        return;
      }
      const accept = opts.accept ?? ATTACHMENT_ACCEPT;
      const maxCount = opts.limits?.maxCount ?? ATTACHMENT_MAX_COUNT;
      const maxBinaryBytes = opts.limits?.maxBinaryBytes ?? MAX_BINARY_ATTACHMENT_BYTES;
      const maxTextBytes = opts.limits?.maxTextBytes ?? MAX_TEXT_ATTACHMENT_BYTES;
      const maxTotalBytes = opts.limits?.maxTotalBytes ?? MAX_ATTACHMENT_TOTAL_BYTES;
      const allowedKinds = opts.allowedKinds ?? ["image", "file"];
      const list = Array.isArray(files) ? files : Array.from(files);
      const currentCount = stagedRef.current.length;
      const countAccepted = [];
      for (const file of list) {
        if (!isAcceptedFileType(file, accept)) {
          opts.onReject?.(acceptRejectionReason(file, accept), file);
          continue;
        }
        if (currentCount + countAccepted.length >= maxCount) {
          opts.onReject?.(`"${file.name}" was not added \u2014 the ${maxCount}-file limit is already reached.`, file);
          continue;
        }
        countAccepted.push(file);
      }
      const sizeAccepted = [];
      for (const file of countAccepted) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const sniff = sniffBinary(bytes);
        const typeCheck = checkAttachmentType(file.name, sniff);
        if (!typeCheck.succeeded) {
          opts.onReject?.(typeCheck.message, file);
          continue;
        }
        const limit = sniff.binary ? maxBinaryBytes : maxTextBytes;
        if (file.size > limit) {
          opts.onReject?.(attachmentSizeErrorMessage(file.name, file.size, limit), file);
          continue;
        }
        const mediaType = sniff.mime ?? file.type ?? "";
        const kind = kindForMime(mediaType);
        if (!allowedKinds.includes(kind)) {
          opts.onReject?.(`"${file.name}" is a ${kind} attachment, which isn't accepted here`, file);
          continue;
        }
        sizeAccepted.push(file);
      }
      const accepted = [];
      let totalBytes = stagedRef.current.reduce((total, s) => total + s.size, 0);
      for (const file of sizeAccepted) {
        const nextTotalBytes = totalBytes + file.size;
        if (nextTotalBytes > maxTotalBytes) {
          opts.onReject?.(attachmentTotalSizeErrorMessage(nextTotalBytes, maxTotalBytes), file);
          continue;
        }
        accepted.push(file);
        totalBytes = nextTotalBytes;
      }
      if (accepted.length === 0) return;
      const taken = new Set(stagedRef.current.map((s) => s.name));
      const entries = accepted.map((file) => {
        const name = dedupeName(sanitizeAttachmentFileName(file.name), taken);
        taken.add(name);
        return {
          id: newId(),
          file,
          name,
          size: file.size,
          status: "pending",
          previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : void 0
        };
      });
      setStaged((prev) => [...prev, ...entries]);
      for (const entry of entries) void upload(entry.id, entry.file, entry.name);
    },
    [setStaged, upload]
  );
  const retry = useCallback3(
    (id) => {
      const entry = stagedRef.current.find((s) => s.id === id);
      if (!entry) return;
      void upload(entry.id, entry.file, entry.name);
    },
    [upload]
  );
  const removeAttachment = useCallback3(
    (id) => {
      controllersRef.current.get(id)?.abort();
      controllersRef.current.delete(id);
      const entry = stagedRef.current.find((s) => s.id === id);
      if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      setStaged((prev) => prev.filter((s) => s.id !== id));
    },
    [setStaged]
  );
  const clear = useCallback3(() => {
    for (const controller of controllersRef.current.values()) controller.abort();
    controllersRef.current.clear();
    for (const entry of stagedRef.current) {
      if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    }
    setStaged([]);
  }, [setStaged]);
  useEffect3(
    () => () => {
      for (const controller of controllersRef.current.values()) controller.abort();
      controllersRef.current.clear();
      for (const entry of stagedRef.current) {
        if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      }
    },
    []
  );
  const composerFiles = useMemo2(
    () => staged.map((s) => ({
      id: s.id,
      name: s.name,
      size: s.size,
      kind: "file",
      status: s.status,
      previewUrl: s.previewUrl,
      errorMessage: s.errorMessage
    })),
    [staged]
  );
  const references = useMemo2(
    () => staged.filter((s) => s.status === "ready" && !!s.reference).map((s) => s.reference),
    [staged]
  );
  const hasPending = useMemo2(
    () => staged.some((s) => s.status === "pending" || s.status === "uploading"),
    [staged]
  );
  const hasError = useMemo2(() => staged.some((s) => s.status === "error"), [staged]);
  const enabled = options.enabled ?? true;
  const blockReason = !enabled ? "Attachments are disabled" : hasPending ? "Attachments are still uploading" : hasError ? "Remove failed attachments to send" : null;
  return {
    composerFiles,
    references,
    addFiles,
    retry,
    removeAttachment,
    clear,
    hasPending,
    hasError,
    blockReason
  };
}

// src/web-react/harness-glyphs.tsx
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var BRAND_PATHS = {
  opencode: [
    "M16 6H8v12h8V6zm4 16H4V2h16v20z"
  ],
  "claude-code": [
    "M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
  ],
  codex: [
    "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
  ],
  amp: [
    "M15.087 23.18L12.03 24l-2.097-7.823-5.738 5.738-2.251-2.251 5.718-5.719-7.769-2.082.82-3.057 11.294 3.08 3.08 11.295z",
    "M19.505 18.762l-3.057.82-2.564-9.573-9.572-2.564.819-3.057 11.295 3.079 3.08 11.295z",
    "M23.893 14.374l-3.057.82-2.565-9.572L8.7 3.057 9.52 0l11.295 3.08 3.079 11.294z"
  ],
  "kimi-code": [
    "M1.052 16.916l9.539 2.552a21.007 21.007 0 00.06 2.033l5.956 1.593a11.997 11.997 0 01-5.586.865l-.18-.016-.044-.004-.084-.009-.094-.01a11.605 11.605 0 01-.157-.02l-.107-.014-.11-.016a11.962 11.962 0 01-.32-.051l-.042-.008-.075-.013-.107-.02-.07-.015-.093-.019-.075-.016-.095-.02-.097-.023-.094-.022-.068-.017-.088-.022-.09-.024-.095-.025-.082-.023-.109-.03-.062-.02-.084-.025-.093-.028-.105-.034-.058-.019-.08-.026-.09-.031-.066-.024a6.293 6.293 0 01-.044-.015l-.068-.025-.101-.037-.057-.022-.08-.03-.087-.035-.088-.035-.079-.032-.095-.04-.063-.028-.063-.027a5.655 5.655 0 01-.041-.018l-.066-.03-.103-.047-.052-.024-.096-.046-.062-.03-.084-.04-.086-.044-.093-.047-.052-.027-.103-.055-.057-.03-.058-.032a6.49 6.49 0 01-.046-.026l-.094-.053-.06-.034-.051-.03-.072-.041-.082-.05-.093-.056-.052-.032-.084-.053-.061-.039-.079-.05-.07-.047-.053-.035a7.785 7.785 0 01-.054-.036l-.044-.03-.044-.03a6.066 6.066 0 01-.04-.028l-.057-.04-.076-.054-.069-.05-.074-.054-.056-.042-.076-.057-.076-.059-.086-.067-.045-.035-.064-.052-.074-.06-.089-.073-.046-.039-.046-.039a7.516 7.516 0 01-.043-.037l-.045-.04-.061-.053-.07-.062-.068-.06-.062-.058-.067-.062-.053-.05-.088-.084a13.28 13.28 0 01-.099-.097l-.029-.028-.041-.042-.069-.07-.05-.051-.05-.053a6.457 6.457 0 01-.168-.179l-.08-.088-.062-.07-.071-.08-.042-.049-.053-.062-.058-.068-.046-.056a7.175 7.175 0 01-.027-.033l-.045-.055-.066-.082-.041-.052-.05-.064-.02-.025a11.99 11.99 0 01-1.44-2.402zm-1.02-5.794l11.353 3.037a20.468 20.468 0 00-.469 2.011l10.817 2.894a12.076 12.076 0 01-1.845 2.005L.657 15.923l-.016-.046-.035-.104a11.965 11.965 0 01-.05-.153l-.007-.023a11.896 11.896 0 01-.207-.741l-.03-.126-.018-.08-.021-.097-.018-.081-.018-.09-.017-.084-.018-.094c-.026-.141-.05-.283-.071-.426l-.017-.118-.011-.083-.013-.102a12.01 12.01 0 01-.019-.161l-.005-.047a12.12 12.12 0 01-.034-2.145zm1.593-5.15l11.948 3.196c-.368.605-.705 1.231-1.01 1.875l11.295 3.022c-.142.82-.368 1.612-.668 2.365l-11.55-3.09L.124 10.26l.015-.1.008-.049.01-.067.015-.087.018-.098c.026-.148.056-.295.088-.442l.028-.124.02-.085.024-.097c.022-.09.045-.18.07-.268l.028-.102.023-.083.03-.1.025-.082.03-.096.026-.082.031-.095a11.896 11.896 0 011.01-2.232zm4.442-4.4L17.352 4.59a20.77 20.77 0 00-1.688 1.721l7.823 2.093c.267.852.442 1.744.513 2.665L2.106 5.213l.045-.065.027-.04.04-.055.046-.065.055-.076.054-.072.064-.086.05-.065.057-.073.055-.07.06-.074.055-.069.065-.077.054-.066.066-.077.053-.06.072-.082.053-.06.067-.074.054-.058.073-.078.058-.06.063-.067.168-.17.1-.098.059-.056.076-.071a12.084 12.084 0 012.272-1.677zM12.017 0h.097l.082.001.069.001.054.002.068.002.046.001.076.003.047.002.06.003.054.002.087.005.105.007.144.011.088.007.044.004.077.008.082.008.047.005.102.012.05.006.108.014.081.01.042.006.065.01.207.032.07.012.065.011.14.026.092.018.11.022.046.01.075.016.041.01L14.7.3l.042.01.065.015.049.012.071.017.096.024.112.03.113.03.113.032.05.015.07.02.078.024.073.023.05.016.05.016.076.025.099.033.102.036.048.017.064.023.093.034.11.041.116.045.1.04.047.02.06.024.041.018.063.026.04.018.057.025.11.048.1.046.074.035.075.036.06.028.092.046.091.045.102.052.053.028.049.026.046.024.06.033.041.022.052.029.088.05.106.06.087.051.057.034.053.032.096.059.088.055.098.062.036.024.064.041.084.056.04.027.062.042.062.043.023.017c.054.037.108.075.161.114l.083.06.065.048.056.043.086.065.082.064.04.03.05.041.086.069.079.065.085.071c.712.6 1.353 1.283 1.909 2.031L7.222.994l.062-.027.065-.028.081-.034.086-.035c.113-.045.227-.09.341-.131l.096-.035.093-.033.084-.03.096-.031c.087-.03.176-.058.264-.085l.091-.027.086-.025.102-.03.085-.023.1-.026L9.04.37l.09-.023.091-.022.095-.022.09-.02.098-.021.091-.02.095-.018.092-.018.1-.018.091-.016.098-.017.092-.014.097-.015.092-.013.102-.013.091-.012.105-.012.09-.01.105-.01c.093-.01.186-.018.28-.024l.106-.008.09-.005.11-.006.093-.004.1-.004.097-.002.099-.002.197-.002z"
  ],
  openclaw: [
    "M9.046 7.104a.527.527 0 110 1.055.527.527 0 010-1.055z",
    "M15.376 7.104a.528.528 0 110 1.056.528.528 0 010-1.056z",
    "M16.877 1.912c.58-.27 1.14-.323 1.616-.037a.317.317 0 01-.326.542c-.227-.136-.547-.153-1.022.068-.352.165-.765.45-1.234.866 2.683 1.17 4.4 3.5 5.148 5.921a6.421 6.421 0 00-.704.184c-.578.016-1.174.204-1.502.735-.338.55-.268 1.276.072 2.069l.005.012.007.014c.523 1.045 1.318 1.91 2.2 2.284-.912 3.274-3.44 6.144-5.972 6.988v2.109h-2.11v-2.11c-1.043.417-2.086.01-2.11 0v2.11h-2.11v-2.11c-2.531-.843-5.061-3.713-5.973-6.987.882-.373 1.678-1.238 2.2-2.284l.007-.014.006-.012c.34-.793.41-1.518.071-2.069-.327-.531-.923-.719-1.503-.735a6.409 6.409 0 00-.704-.183c.749-2.421 2.466-4.751 5.149-5.922-.47-.416-.88-.701-1.234-.866-.474-.221-.794-.204-1.021-.068a.318.318 0 01-.435-.109.317.317 0 01.109-.433c.476-.286 1.036-.233 1.615.037.49.229 1.031.628 1.621 1.182A9.924 9.924 0 0112 2.568c1.199 0 2.284.19 3.256.526.59-.554 1.13-.953 1.62-1.182zM8.835 6.577a1.266 1.266 0 100 2.532 1.266 1.266 0 000-2.532zm6.33 0a1.267 1.267 0 100 2.533 1.267 1.267 0 000-2.533z",
    "M.395 13.118c-.966-1.932-.163-3.863 2.41-3.365v-.001l.05.01c.084.018.17.038.26.06.033.009.067.017.1.027.084.022.168.048.255.076l.09.027c.528 0 .95.158 1.16.501.212.343.212.87-.105 1.61-.085.17-.178.333-.276.489l-.01.017a4.967 4.967 0 01-.62.791l-.019.02c-1.092 1.117-2.496 1.336-3.295-.262z",
    "M21.193 9.753c2.574-.5 3.378 1.433 2.411 3.365-.58 1.159-1.476 1.361-2.342.96l-.011-.005a2.419 2.419 0 01-.114-.056l-.019-.01a2.751 2.751 0 01-.115-.067l-.023-.014c-.035-.022-.071-.044-.106-.068l-.05-.035c-.55-.388-1.062-1.007-1.44-1.76-.276-.647-.311-1.132-.174-1.472.176-.439.636-.639 1.23-.639.032-.011.066-.02.099-.03.08-.026.16-.05.238-.072l.117-.03a5.502 5.502 0 01.3-.067z"
  ],
  hermes: [
    "M5.938 12.835c.127-.039.285.02.373.143.028.038.036.092.046.14.003.014-.02.033-.04.05-.124-.098-.24-.194-.354-.291-.011-.01-.016-.027-.025-.042zM8.396 9.412c.195-.032.39-.06.588-.05a.54.54 0 01.148.026c.202.071.402.147.601.224.028.01.05.036.075.055l-.013.027a9.203 9.203 0 01-.26-.089c-.115-.038-.213-.077-.315-.098-.25-.05-.25-.046-.292-.014l.574.144c.275.139.55.276.823.417.042.022.09.057.107.098.026.06.063.076.117.072.066-.006.132-.017.213-.027l-.04.086c.051.08.142.02.216.064-.074.13-.247.09-.334.199l.061.074-.12.087c0 .106-.038.168-.306.243l.026.085-.196.042.07.124h-.25l-.007.137c-.081-.01-.161-.018-.244-.027l-.053.123c-.027-.008-.052-.011-.073-.023-.067-.038-.128-.056-.195.006-.019.017-.063.014-.093.008-.026-.006-.05-.029-.07-.042-.11.095-.11.095-.208.003-.057.046-.12.074-.186.011-.063.027-.123-.02-.178-.014-.07.007-.097-.035-.133-.07l-.13.033c-.013-.236-.194-.19-.34-.203.005-.072.05-.092.095-.094a.474.474 0 01.159.022c.164.05.32.12.496.138.203.021.405.029.601-.015.265-.059.52-.149.707-.365.049-.056.083-.127.117-.195.019-.038.02-.084-.02-.116a1.397 1.397 0 00-.382-.217c.024.12-.031.182-.115.221 0 .014-.004.025 0 .03.08.115.084.16-.007.267a1.39 1.39 0 01-.218.211.477.477 0 01-.641-.05 1.36 1.36 0 01-.133-.152c-.078-.107-.076-.108-.033-.236-.165-.08-.128-.226-.104-.364.008-.05.028-.096.049-.163-.04.014-.067.017-.087.032a.897.897 0 00-.316.357c-.007.016-.01.034-.02.047-.012.015-.034.038-.045.035-.02-.006-.037-.027-.05-.045-.008-.012-.007-.032-.012-.057h-.126l.053-.172a14.82 14.82 0 00-.039-.049l.11-.284c-.06.026-.091.044-.124.051-.03.007-.064 0-.095 0 0-.031-.01-.07.004-.092.149-.22.305-.428.593-.476z",
    "M8.06 10.788c-.003-.038-.004-.075.037-.062.016.006.034.048.028.067-.01.04-.038.032-.064-.005z",
    "M11.981.009c.226-.012.453-.011.679 0 .247.01.495.024.74.062.401.064.798.157 1.19.273.463.138.92.299 1.356.511a7.31 7.31 0 012.948 2.642c.292.469.536.963.739 1.479.219.556.446 1.11.623 1.683.204.654.329 1.326.458 1.997.097.504.182 1.01.29 1.511.156.722.329 1.44.494 2.16.186.812.4 1.615.63 2.415.102.355.193.713.282 1.072.11.436.202.876.254 1.323.031.278.066.557.073.837a7.56 7.56 0 01-.017.88c-.037.413-.1.818-.226 1.212a5.017 5.017 0 01-.915 1.649l-.13.156.018.023c.043-.023.088-.041.127-.068.2-.138.373-.307.531-.49.4-.46.721-.973.975-1.529a3.59 3.59 0 00.325-1.72c-.024-.424-.097-.834-.3-1.213-.013-.027-.015-.06-.03-.121.05.035.082.048.101.072.107.13.22.258.315.398.33.494.46 1.052.486 1.64a3.75 3.75 0 01-.47 1.97c-.36.655-.887 1.14-1.526 1.506-.193.111-.394.21-.595.308-.157.078-.248.211-.318.365a.522.522 0 00-.033.406.359.359 0 01.013.139c-.005.077-.077.155-.14.162-.054.006-.125-.043-.15-.116a1.206 1.206 0 01-.06-.233c-.04-.314-.155-.6-.308-.87a3.906 3.906 0 00-.73-.91 2.129 2.129 0 00-.897-.524 4.093 4.093 0 00-.692-.131c-.075-.008-.15-.04-.22.01.18.06.363.11.538.18.434.173.82.43 1.18.728.308.255.58.543.794.884.098.155.186.315.227.496.027.123.042.25.067.375.013.062-.002.109-.053.144-.047.033-.122.034-.163-.01a.455.455 0 01-.08-.14c-.03-.073-.038-.159-.078-.225a7.314 7.314 0 00-1.423-1.664c-.16-.137-.329-.26-.537-.323-.376-.114-.753-.203-1.15-.154-.213.025-.427.032-.64.053a1.6 1.6 0 00-.736.278 5.14 5.14 0 00-.834.72c-.329.342-.642.699-.955 1.055-.136.155-.264.319-.314.531a5.227 5.227 0 00-.012.051.096.096 0 01-.09.076h-.31c-.046 0-.082-.048-.072-.094.023-.108.045-.216.07-.324.075-.325.19-.635.368-.917.024-.039.04-.088.104-.08l.01.049.027.077c.28-.435.571-.834.996-1.135.283-.204.584-.378.89-.55a.196.196 0 00-.098-.002c-.162.043-.325.084-.485.134-.402.124-.764.33-1.11.566-.147.1-.298.193-.414.333a7.314 7.314 0 00-1.07 1.767.845.845 0 00-.04.12.075.075 0 01-.072.056h-.494c-.04 0-.062-.051-.036-.082.123-.14.246-.282.377-.415.275-.281.58-.532.777-.884.027-.048.063-.09.095-.135.238-.333.54-.607.818-.902.082-.086.175-.16.26-.24.029-.027.053-.057.079-.085l-.018-.025-.135.041c-.034.017-.07.031-.102.05-.248.144-.494.292-.743.433-.408.23-.825.439-1.209.711-.281.2-.591.358-.889.533-.02.012-.044.015-.08.028-.015-.135.143-.201.108-.336-.033.014-.064.02-.085.038-.111.096-.227.19-.328.296-.148.157-.284.325-.425.488-.125.143-.25.286-.373.431A.153.153 0 019.89 24H8.762a.316.316 0 00.016-.042c.028-.09.085-.172.083-.28-.091-.018-.162.001-.212.077a4.45 4.45 0 00-.136.215c-.01.016-.024.03-.042.03h-.093c-.019 0-.029-.022-.017-.037.071-.088.14-.178.209-.268.001-.002-.006-.012-.012-.024-.014.004-.03.006-.045.013-.176.09-.352.181-.527.274a.363.363 0 01-.168.042H5.202c-.026 0-.039-.036-.019-.053.21-.178.402-.374.558-.605.335-.496.538-1.047.667-1.629.004-.02-.003-.043-.006-.091-.037.048-.059.072-.076.1a1.943 1.943 0 01-.334.415c-.28.258-.59.448-.983.464-.297.012-.588 0-.865-.127-.46-.21-.722-.57-.794-1.072-.025-.17-.017-.171-.182-.219A3.513 3.513 0 011.97 20.6a2.286 2.286 0 01-.808-1.13 3.569 3.569 0 01-.16-1.245c.002-.034.016-.067.024-.1.032.023.046.043.05.066.033.153.059.308.096.46.086.355.257.664.516.92.258.256.571.419.91.532.358.118.717.138 1.07-.016a1.89 1.89 0 00.621-.452c.328-.348.533-.76.648-1.223.009-.034.005-.071.007-.11-.015.006-.026.006-.03.011-.031.05-.064.1-.093.152-.284.502-.679.887-1.196 1.135-.351.17-.718.255-1.11.159a1.607 1.607 0 01-.971-.64 2.006 2.006 0 01-.368-.924 2.903 2.903 0 01.02-.886c.05-.439.466-1.17.742-1.271-.02.063-.035.112-.053.16-.043.116-.097.227-.13.345a1.901 1.901 0 00-.05.82c.033.212.09.416.204.6.147.236.346.407.62.465.11.023.225.014.338.018a.576.576 0 00.386-.131c.164-.128.282-.292.366-.481.168-.375.24-.777.309-1.179.05-.296.093-.594.133-.893.039-.281.071-.563.104-.845.026-.232.048-.464.074-.696.024-.228.052-.455.076-.683.024-.227.047-.455.069-.683.013-.14.022-.28.034-.42l.037-.417c.022-.25.041-.5.065-.748.008-.082-.02-.132-.09-.177a2.46 2.46 0 01-.492-.418c-.1-.109-.188-.228-.282-.342-.035-.042-.056-.097-.116-.118a2.084 2.084 0 00.275.597c.06.092.131.176.196.265.063.086.182.115.234.226-.028.003-.046.01-.06.006a4.74 4.74 0 01-.22-.057 2.71 2.71 0 01-1.287-.819c-.435-.487-.656-1.076-.71-1.723a5.206 5.206 0 01.014-1.06c.072-.602.22-1.186.45-1.745.155-.376.338-.741.526-1.102.205-.393.466-.75.765-1.076.512-.559 1.104-1.024 1.726-1.448.717-.49 1.478-.898 2.277-1.233C8.244.828 8.767.632 9.31.494c.655-.166 1.31-.33 1.982-.415.229-.03.458-.058.688-.07zm-1.847 22.82c-.07.06-.147.111-.207.18-.238.27-.464.549-.668.869l-.044.108a.177.177 0 00.093-.057c.174-.19.351-.378.519-.574.104-.122.195-.255.288-.386.024-.034.03-.08.046-.12l-.027-.02zm1.65-3.695a5.51 5.51 0 00-.653.593l-.37.386a.963.963 0 01-.377.25 1.372 1.372 0 01-.467.09c-.044 0-.087.006-.151.012.028.058.043.097.064.131.15.242.301.482.45.724.136.22.276.438.399.666.068.125.105.267.156.404.077.027.14-.018.202-.048.29-.135.579-.274.867-.412.213-.101.437-.186.636-.31.347-.215.68-.455 1.018-.685.015-.01.026-.028.042-.046-.023-.019-.038-.037-.056-.044-.287-.111-.527-.3-.77-.482a5.319 5.319 0 01-.506-.42 1.757 1.757 0 01-.41-.653c-.019-.049-.045-.095-.075-.156zm-5.847.264c-.06.096-.097.194-.132.293a3.38 3.38 0 01-.555 1.01c-.2.25-.455.412-.762.493-.23.06-.464.076-.7.07-.048-.002-.097.002-.158.005.016.04.021.066.035.085.1.145.23.246.4.295.157.046.316.034.498.023.181-.037.343-.115.485-.234.238-.199.402-.454.536-.732.175-.363.264-.751.342-1.144.01-.053.008-.11.011-.164zm14.945-4.586c.008.029.016.057.027.107.024.155.051.31.072.464.03.219.067.437.078.657.017.344.027.689-.014 1.033-.037.315-.063.633-.116.946a6.153 6.153 0 01-.46 1.518c-.008.018-.01.039-.02.082.047-.03.077-.042.098-.064.085-.083.17-.167.248-.255.271-.305.458-.66.596-1.043.18-.498.228-1.011.145-1.531-.103-.65-.33-1.263-.597-1.881a9.055 9.055 0 00-.024-.055l-.033.022zM5.797 8.29a.26.26 0 00.018.153c.124.251.25.501.379.75.025.049.066.09.03.163-.284.06-.578.119-.88.255.059.038.097.06.132.087.042.032.112.058.09.12-.01.033-.075.048-.117.072.017.01.043.021.067.036.166.102.33.207.447.368.138.192.229.404.188.644-.079.469-.306.85-.69 1.132-.054.04-.106.083-.161.122a.243.243 0 00-.103.245.77.77 0 00.055.195c.083.196.22.35.375.492.083.076.159.164.222.257a.37.37 0 01.025.377c-.023.05-.05.099-.076.148-.03.06-.028.111.022.162.041.042.08.089.112.138.038.058.078.079.147.05a.486.486 0 01.333-.006c.16.046.302.126.444.21.13.077.264.149.4.219.067.035.14.05.219.026.071-.022.124.01.145.076.02.064-.003.108-.074.139-.07.03-.137.063-.209.088-.1.035-.201.073-.314.077-.013-.107.11-.088.127-.159-.206-.126-.643-.145-.801-.034.063.112.035.21-.096.313-.13-.1-.025-.202.002-.3a.209.209 0 00-.249.17c-.015.101.067.216.178.224.108.007.218-.005.326-.012.06-.005.12-.027.199 0-.103.123-.248.127-.357.19.002.05.07.086.019.131-.053.048-.095-.001-.132-.03-.08-.063-.16-.126-.231-.197a.474.474 0 01-.157-.311.52.52 0 00-.043-.172c-.032-.074-.032-.137.033-.19-.018-.03-.028-.053-.045-.072a1.222 1.222 0 01-.196-.369c-.053-.137-.046-.264.048-.381.024-.03.05-.06.064-.095a.664.664 0 00.047-.168c.017-.165-.064-.287-.182-.387-.186-.156-.36-.322-.46-.551-.005-.011-.024-.017-.037-.026-.011.017-.024.027-.025.038-.019.185-.045.37-.052.557-.014.377.058.743.162 1.104.118.41.289.798.488 1.173.267.502.537 1.002.812 1.5.055.098.13.189.208.27.198.202.452.272.724.273.202 0 .404-.006.605-.026.295-.03.59-.073.884-.113.183-.025.365-.057.548-.08.21-.026.38.073.522.21.16.156.305.327.447.5.22.265.397.56.554.867.05.098.07.1.147.03.13-.121.26-.242.394-.36.067-.059.088-.12.067-.213a3.535 3.535 0 01-.085-.796c.002-.157.006-.314.018-.471.015-.224.03-.45.06-.672a59.114 59.114 0 01.362-2.298c.087-.493.182-.984.268-1.477.06-.347.118-.694.162-1.043.034-.273.055-.55.063-.825.011-.332.003-.665.002-.998 0-.077.004-.155-.01-.23-.028-.142-.01-.155-.162-.19a5.826 5.826 0 00-.607-.107c-.146-.018-.207-.053-.221-.19-.006-.049-.025-.098-.041-.146-.009-.025-.024-.048-.046-.09l-.025.264c-.009.096-.029.116-.127.115-.055 0-.11-.008-.164-.008-.476 0-.952-.008-1.426.032-.095.008-.173-.015-.226-.103-.04-.066-.088-.126-.134-.186-.063-.084-.086-.093-.182-.06-.195.068-.388.138-.582.21a2.71 2.71 0 00-.675.394.986.986 0 01-.323.168c-.033.01-.07.008-.127.013.02-.066.024-.114.047-.15.064-.105.135-.205.205-.306.023-.033.049-.063.073-.095l-.015-.023-.201.037c-.146.04-.296.07-.437.122-.148.053-.266.023-.386-.072a3.623 3.623 0 01-.733-.786l-.093-.132zm8.592 8.963l-.147.09c-.22.134-.44.266-.659.402-.093.058-.184.12-.27.188-.085.07-.124.161-.072.272.047.1.093.2.147.294.047.08.124.138.213.147.11.01.228.012.336-.012.217-.05.372-.205.528-.357a.291.291 0 00.087-.308c-.046-.18-.079-.365-.118-.547-.011-.052-.027-.103-.045-.169zm-.257-2.409c-.12.291-.205.597-.325.91-.151.433-.294.87-.435 1.323.036-.01.054-.01.067-.018.261-.16.522-.324.785-.484.054-.033.071-.078.065-.138-.012-.13-.024-.262-.034-.393l-.068-.886c-.008-.103-.02-.206-.029-.31-.009 0-.017-.002-.026-.004zm3.081-8.13l.099.285c.08.231.159.463.24.714l.58 1.952c.187.63.372 1.262.558 1.893.114.382.235.762.343 1.146.072.257.126.519.186.799.044.206.087.413.127.64.034.106.023.226.077.325l.025-.006-.068-.362c-.038-.206-.077-.412-.113-.638-.015-.07-.029-.141-.046-.211-.095-.396-.177-.796-.29-1.187-.196-.685-.413-1.364-.618-2.046-.165-.549-.322-1.1-.488-1.648-.069-.227-.15-.45-.226-.695l-.117-.336c-.037-.107-.075-.216-.115-.322-.04-.106-.084-.21-.127-.314a7.558 7.558 0 01-.027.01zM6.225 14.304c-.063-.001-.115.014-.134.083a.35.35 0 00.41.012 4.533 4.533 0 00-.276-.095zM5.23 11.98c-.026-.027-.057-.048-.075.002-.012.032-.007.07-.01.113.082-.037.082-.037.085-.115zm.062-1.189a.135.135 0 00-.088.056.197.197 0 00-.025.11c.005.152.01.306.026.457a.751.751 0 00.066.218c.061.136.157.167.288.101.055-.027.06-.054.025-.11a4.52 4.52 0 01-.129-.211c-.015-.068-.066-.131-.033-.207.04-.09-.076-.116-.074-.19V10.874c-.003-.038-.006-.087-.056-.083zm-.017-.968a.867.867 0 00-.467.127c-.076.045-.084.07-.05.158.034.087.07.173.115.254.064.117.09.125.21.077a.657.657 0 01.336-.053c.202.022.357.136.504.264l.092.077c.007-.006.014-.013.022-.018-.019-.105-.035-.226-.149-.264-.157-.053-.324-.075-.508-.117l-.24-.005c.24-.169.452-.044.687.009-.063-.115-.153-.147-.23-.193-.082-.05-.17-.092-.25-.144-.06-.037-.12-.08-.072-.172zm10.233.325c-.23-.01-.427.08-.608.211-.034.026-.06.065-.105.117.087.026.15.046.232.065.044-.015.088-.03.13-.046.306-.114.61-.115.904.031.126.063.237.04.366-.005-.02-.031-.03-.054-.045-.071a.986.986 0 00-.448-.273c-.14-.044-.284-.024-.426-.03zM7.99 6.483a.308.308 0 00.002.133c.08.321.156.643.242.962.104.387.27.75.456 1.103.02.037.061.08.098.087a.404.404 0 00.253-.051l-.472-.84c-.23-.448-.405-.92-.579-1.394zM10.397.497c-.2-.008-.405.004-.603.034-.236.035-.47.087-.7.152-.287.08-.569.18-.852.273-.04.013-.074.038-.11.058.028.014.05.018.07.014.287-.068.58-.085.873-.09.134-.002.269.009.402.025.19.024.382.048.57.09.456.104.874.3 1.265.556.464.306.888.66 1.257 1.078.205.232.395.475.56.739.17.274.315.561.449.856.273.601.456 1.232.6 1.876.04.173.07.348.1.524.017.104.065.167.17.19.122.028.2.105.22.251-.003.102-.06.174-.129.24a1.065 1.065 0 00-.268.358.164.164 0 00.083-.039c.08-.086.162-.172.235-.265a.56.56 0 00.13-.333c.009-.05.022-.1.024-.15.007-.124-.017-.15-.143-.168-.025-.004-.049-.014-.073-.015-.082-.007-.125-.063-.137-.131-.033-.198-.004-.355.247-.408.086-.018.174-.03.26-.042.158-.023.315-.053.473-.067.14-.012.19.033.226.167.008.029.018.057.021.087.019.179-.008.225-.141.288-.027.013-.055.024-.078.042a.148.148 0 00-.051.067c-.039.144.073.382.206.445l.673.32c.023.011.05.015.075.023l.018-.026c-.015-.008-.032-.013-.044-.024a2.27 2.27 0 00-.544-.32 4.898 4.898 0 00-.173-.075.203.203 0 01-.126-.191c-.003-.085.045-.154.128-.187l.059-.025c.099-.044.118-.076.112-.187a.384.384 0 00-.008-.063c-.067-.294-.123-.59-.205-.88a9.478 9.478 0 00-.826-2.036 7.465 7.465 0 00-1.39-1.805 4.536 4.536 0 00-1.177-.824 3.656 3.656 0 00-1.016-.328 6.155 6.155 0 00-.712-.074zm6.719 5.955c.01.014.018.028.038.034l-.022-.044-.016.01zM4.103 3.917a.062.062 0 01-.03.012.455.455 0 01-.04.039c-.01.01-.02.02-.045.04l-.363.354c-.088.085-.17.178-.266.253-.284.22-.425.53-.544.855a.132.132 0 00-.007.071c.013.055.033.108.052.168l.074.026c-.017.056-.03.105-.047.152-.058.164-.118.327-.175.491-.005.015.008.036.019.077.08-.175.158-.33.225-.489.228-.544.484-1.074.819-1.561.09-.133.182-.266.283-.401.004-.006.007-.013.022-.03.001-.016.003-.032.015-.04l.008-.017zm12.976 2.408a.023.023 0 01.009.019.073.073 0 00-.006.01.188.188 0 00.007.02l.018.022c.002-.007.007-.016.005-.021-.003-.01-.012-.018-.02-.038a1.331 1.331 0 01-.013-.012zM4.199 4.48c-.003.004-.008.008-.027.014-.005.013-.011.025-.031.047a2.085 2.085 0 01-.124.167c-.048.07-.116.055-.181.041-.134-.028-.228.016-.287.143-.089.187-.187.37-.273.56-.049.108-.11.216-.118.36.081.003.154.007.228.008h.228a2.563 2.563 0 01-.079.264c-.01.052-.022.103-.033.155l.02.004c.018-.046.037-.092.067-.153.066-.142.13-.285.2-.426.02-.04.034-.1.116-.092 0 .043.004.084 0 .124-.005.045-.017.09-.028.143.141.043.086.174.115.269.102-.022.104-.195.248-.144v.205l.017.002.439-1.059c-.13 0-.246-.02-.358.033-.024.011-.058-.001-.108-.004.075-.15.139-.278.211-.417a.128.128 0 01.025-.036c0-.015-.001-.03.008-.038l.006-.02c-.005.006-.01.011-.028.017-.004.012-.009.024-.026.045a.085.085 0 01-.032.033c-.123.157-.09.164-.258.106-.079-.027-.078-.028-.047-.144.028-.046.056-.093.098-.15 0-.016-.001-.032.007-.042L4.2 4.48zm2.073-.67c-.003.006-.007.011-.027.016-.094.125-.194.246-.28.377-.155.238-.301.481-.451.723-.14.224-.345.368-.575.481-.017.008-.04.006-.079.011.012-.059.016-.109.033-.153a6.076 6.076 0 01.229-.518l-.007-.02a.138.138 0 01-.035.025c-.028.05-.055.1-.093.164-.26.424-.443.817-.442.95.024.004.048.011.073.013.177.013.188.007.26-.165.03-.07.077-.12.147-.15l.175-.07c.044-.018.085-.057.146-.032.003.05-.01.11.014.145.042.062.044.125.047.193.002.049.017.098.026.147.029-.034.039-.065.05-.097.142-.39.277-.782.428-1.17.1-.256.22-.504.33-.756.013-.03.013-.067.03-.092V3.81zm3.987-.34c0 .045.01.084.021.123.042.16.094.318.124.48.024.133.023.27.028.406 0 .033-.019.067-.032.11-.094-.058-.047-.158-.106-.215h-.125c-.015.072-.01.152-.046.2-.066.085-.155.154-.236.227-.043.038-.078.018-.103-.025l-.046-.087c-.065.035-.117.069-.172.093-.116.051-.235.095-.35.147-.085.038-.09.053-.07.147.014.075.034.148.047.223.013.072.05.109.123.124.233.05.462.115.657.265.058-.102.058-.102.168-.151.03-.014.06-.03.092-.042.08-.03.115-.017.15.06.023.048.041.098.066.158.06-.14-.042-.267.017-.416.157.18.24.39.375.567a.235.235 0 00.022-.098c.002-.124 0-.247.002-.371 0-.034.013-.067.02-.1l.032-.003c.11.155.13.354.226.52a3.036 3.036 0 00-.01-.392c-.004-.045 0-.074.05-.088.08.036.116.14.215.158-.03-.275-.423-1.137-.798-1.635-.114-.127-.2-.28-.34-.386zm-2.667.696c-.019.034-.03.05-.037.067-.061.185-.125.37-.18.556-.031.105-.087.169-.195.19-.09.019-.178.052-.268.073-.038.009-.089.015-.118-.003-.024-.016-.025-.069-.036-.106-.064.076-.082.087-.17.047-.133-.062-.262-.135-.393-.201-.048-.025-.093-.063-.17-.03-.043.12-.091.25-.137.382-.099.28-.087.242.095.453.046.048.102.03.154.023.054-.009.106-.03.16-.036.13-.013.26-.08.367-.015.204-.064.387-.122.571-.178.05-.015.089.005.114.054.022.042.034.093.082.121.038-.056-.013-.128.063-.178l.14.241-.042-1.46zm.278.358c-.096-.01-.107.01-.11.108-.002.038-.003.078.002.115.03.2.099.386.174.57.002.006.012.01.022.015l.078-.05c.052.036.081.088.153.088.205-.002.41.014.616.012.099-.001.158.042.205.12.018.03.024.077.088.066l-.08-.394c-.05-.195-.085-.395-.172-.589-.057.057-.114.068-.18.046a.72.72 0 00-.135-.028c-.22-.028-.44-.059-.66-.08zm10.254-1.727c.089.163.155.316.139.491-.016.168.026.342-.044.516-.047-.033-.088-.082-.112-.075-.117.035-.164-.057-.227-.115a4.772 4.772 0 01-.286-.29l-.104-.113a4.856 4.856 0 01-.023.019c.035.046.07.093.11.156.04.064.084.127.122.193.034.058.065.118.031.205-.082-.01-.164-.019-.246-.032-.06-.01-.101 0-.124.07-.031.098-.037.096-.15.09.02.042.036.08.057.116.041.074.03.138-.03.196-.06.06-.118.122-.178.181a.175.175 0 01-.185.046c-.222-.061-.447-.113-.67-.174-.032-.009-.063-.04-.086-.068-.03-.04-.052-.087-.08-.13-.044-.07-.09-.138-.136-.207a.18.18 0 00-.014.105c.012.127.03.253.035.38.005.1-.024.12-.121.104-.104-.017-.206-.04-.31-.058-.064-.012-.131-.028-.202.03l.081.208c.09 0 .166-.01.237.002a.819.819 0 01.458.251c.078.083.154.168.241.26l.018-.005c-.004-.006-.008-.013-.01-.04.014-.056-.062-.118.018-.178.031.03.064.057.088.09.058.078.111.159.169.257l.089.141.024-.013a2093.819 2093.819 0 01-.427-.934c.055.007.083.007.108.016.193.07.385.142.577.216.074.028.147.06.219.094.062.028.112.018.157-.033.05-.056.102-.112.154-.167.05-.051.095-.046.132.014.016.025.026.053.04.08.071.138.143.277.217.433l.159.308.025-.011c-.044-.106-.07-.218-.138-.334-.057-.182-.168-.346-.206-.545.136.034.362.326.567.732l.057.074.018-.011a1.563 1.563 0 01-.052-.127c-.046-.145-.097-.29-.136-.436-.022-.083-.036-.173.022-.26l.109.058-.026-.207.027-.016c.022.02.05.036.065.06.073.108.143.22.215.33.01.016.029.029.043.043-.036-.217-.2-.38-.229-.626l.155.112c.014-.166.012-.319.042-.465.032-.158-.023-.297-.063-.445.024.004.036.006.055.025.092.124.183.249.277.371.02.027.05.047.069.087l.04.063.019-.015a.293.293 0 01-.053-.082 27.922 27.922 0 01-.332-.49c-.221-.311-.363-.467-.485-.521zm-6.57.327c-.003.161.092.275.069.415l-.368.087c.09.139.032.237-.052.331-.05.057-.092.122-.143.178-.037.04-.046.078-.018.126l.16.275c.029.048.072.066.128.064.076-.003.152 0 .228-.001.116-.003.216.022.275.137.006.014.02.024.044.052.004-.059-.003-.098.01-.13.016-.04.04-.099.072-.108.084-.023.173-.024.26-.03.013-.001.027.018.04.029l.071.065c.019-.11-.082-.198-.024-.31l.126.04c-.026-.123-.07-.245-.071-.366 0-.123.051-.243.115-.36.107.062.16.156.234.253.183.265.36.533.494.834.165-.078.27.068.407.088-.003-.106-.133-.441-.197-.492a.142.142 0 00-.102-.028c-.06.011-.119.039-.191.063-.025-.039-.056-.078-.077-.122a3.936 3.936 0 00-.473-.783c-.076-.094-.16-.182-.228-.26l-.391.285c-.049.035-.094.03-.132-.017l-.169-.207c-.025-.03-.053-.059-.097-.108z"
  ]
};
function BotGlyph({ className }) {
  return /* @__PURE__ */ jsxs2("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
    /* @__PURE__ */ jsx2("path", { d: "M12 8V4H8" }),
    /* @__PURE__ */ jsx2("rect", { width: "16", height: "12", x: "4", y: "8", rx: "2" }),
    /* @__PURE__ */ jsx2("path", { d: "M2 14h2" }),
    /* @__PURE__ */ jsx2("path", { d: "M20 14h2" }),
    /* @__PURE__ */ jsx2("path", { d: "M15 13v2" }),
    /* @__PURE__ */ jsx2("path", { d: "M9 13v2" })
  ] });
}
function PlugGlyph({ className }) {
  return /* @__PURE__ */ jsxs2("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
    /* @__PURE__ */ jsx2("path", { d: "M12 22v-5" }),
    /* @__PURE__ */ jsx2("path", { d: "M15 8V2" }),
    /* @__PURE__ */ jsx2("path", { d: "M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z" }),
    /* @__PURE__ */ jsx2("path", { d: "M9 8V2" })
  ] });
}
function TerminalGlyph({ className }) {
  return /* @__PURE__ */ jsxs2("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
    /* @__PURE__ */ jsx2("path", { d: "M12 19h8" }),
    /* @__PURE__ */ jsx2("path", { d: "m4 17 6-6-6-6" })
  ] });
}
var FALLBACK_GLYPHS = {
  "factory-droids": BotGlyph,
  nanoclaw: PlugGlyph,
  "cli-base": TerminalGlyph
};
function HarnessGlyph({ harness, className }) {
  const brand = BRAND_PATHS[harness];
  if (brand) {
    return /* @__PURE__ */ jsx2(
      "svg",
      {
        className,
        viewBox: "0 0 24 24",
        fill: "currentColor",
        fillRule: "evenodd",
        clipRule: "evenodd",
        role: "img",
        "aria-label": harness,
        "data-glyph": harness,
        children: brand.map((d) => /* @__PURE__ */ jsx2("path", { d }, d.slice(0, 32)))
      }
    );
  }
  const Fallback = FALLBACK_GLYPHS[harness] ?? BotGlyph;
  const kind = Fallback === BotGlyph ? "bot" : Fallback === PlugGlyph ? "plug" : "terminal";
  return /* @__PURE__ */ jsx2("span", { role: "img", "aria-label": harness, "data-glyph": kind, className: "inline-flex", children: /* @__PURE__ */ jsx2(Fallback, { className }) });
}

// src/web-react/agent-session-controls.tsx
import { useId as useId2, useMemo as useMemo3, useRef as useRef4, useState as useState4 } from "react";
import { Fragment as Fragment2, jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
var HARNESS_LABELS = {
  opencode: "OpenCode (any model)",
  "claude-code": "Claude Code (Anthropic)",
  codex: "Codex (OpenAI)",
  "kimi-code": "Kimi (Moonshot)",
  amp: "Amp",
  "factory-droids": "Factory Droids",
  cursor: "Cursor",
  hermes: "Hermes",
  forge: "Forge",
  pi: "Pi",
  openclaw: "OpenClaw",
  acp: "ACP",
  "cli-base": "CLI"
};
function harnessLabel(h) {
  return HARNESS_LABELS[h] ?? h;
}
function ChevronDown({ className }) {
  return /* @__PURE__ */ jsx3("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx3("path", { d: "m6 9 6 6 6-6" }) });
}
function LockGlyph({ className }) {
  return /* @__PURE__ */ jsxs3("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
    /* @__PURE__ */ jsx3("rect", { width: "18", height: "11", x: "3", y: "11", rx: "2", ry: "2" }),
    /* @__PURE__ */ jsx3("path", { d: "M7 11V7a5 5 0 0 1 10 0v4" })
  ] });
}
function GearGlyph({ className }) {
  return /* @__PURE__ */ jsxs3("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
    /* @__PURE__ */ jsx3("circle", { cx: "12", cy: "12", r: "3" }),
    /* @__PURE__ */ jsx3("path", { d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" })
  ] });
}
var FOCUS_RING = "";
function HarnessPicker({
  value,
  onChange,
  available,
  fullWidth = false,
  lockReason,
  variant = "chip"
}) {
  const [open, setOpen] = useState4(false);
  const [hintOpen, setHintOpen] = useState4(false);
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen);
  const hintPanelRef = useRef4(null);
  const panelId = useId2();
  const reasonId = useId2();
  const locked = lockReason !== void 0;
  const options = available ?? Object.keys(HARNESS_LABELS);
  const showHint = () => setHintOpen(true);
  const hideHint = () => setHintOpen(false);
  return /* @__PURE__ */ jsxs3("div", { ref: containerRef, className: pickerRootClass(fullWidth), children: [
    /* @__PURE__ */ jsxs3(
      "button",
      {
        type: "button",
        ...triggerProps,
        "aria-haspopup": locked ? void 0 : true,
        "aria-expanded": locked ? void 0 : open,
        "aria-controls": !locked && open ? panelId : void 0,
        "aria-disabled": locked || void 0,
        "aria-describedby": locked ? reasonId : void 0,
        onClick: locked ? void 0 : () => setOpen(!open),
        onMouseEnter: locked ? showHint : void 0,
        onMouseLeave: locked ? hideHint : void 0,
        onFocus: locked ? showHint : void 0,
        onBlur: locked ? hideHint : void 0,
        title: "Agent backend",
        "data-state": !locked && open ? "open" : "closed",
        className: variant === "quiet" ? `${quietPickerTriggerClass({ interactive: !locked })} w-full justify-between` : `inline-flex min-h-[36px] w-full items-center justify-between gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition ${locked ? "cursor-default" : "hover:bg-accent"} ${FOCUS_RING}`,
        children: [
          /* @__PURE__ */ jsxs3("span", { className: "flex min-w-0 items-center gap-1.5", children: [
            /* @__PURE__ */ jsx3(HarnessGlyph, { harness: value, className: variant === "quiet" ? "h-4 w-4 shrink-0" : "h-4 w-4 shrink-0 text-foreground" }),
            /* @__PURE__ */ jsx3("span", { className: "truncate", children: harnessLabel(value) })
          ] }),
          locked ? /* @__PURE__ */ jsx3(LockGlyph, { className: "h-3.5 w-3.5 shrink-0 text-muted-foreground" }) : /* @__PURE__ */ jsx3(ChevronDown, { className: "h-3.5 w-3.5 shrink-0 text-muted-foreground" })
        ]
      }
    ),
    locked && /* @__PURE__ */ jsxs3(Fragment2, { children: [
      /* @__PURE__ */ jsx3("span", { id: reasonId, className: "sr-only", children: lockReason }),
      /* @__PURE__ */ jsx3(
        PopoverSurface,
        {
          open: hintOpen,
          role: "tooltip",
          triggerRef,
          panelRef: hintPanelRef,
          matchTriggerWidth: fullWidth,
          className: `max-w-[248px] rounded-lg border border-card-edge bg-popover px-2.5 py-1.5 text-xs leading-snug text-muted-foreground ${OVERLAY_SHADOW}`,
          children: /* @__PURE__ */ jsx3("span", { "aria-hidden": true, children: lockReason })
        }
      )
    ] }),
    /* @__PURE__ */ jsx3(
      PopoverSurface,
      {
        open: !locked && open,
        id: panelId,
        role: "menu",
        triggerRef,
        panelRef,
        matchTriggerWidth: true,
        className: `max-h-64 min-w-[248px] overflow-y-auto rounded-xl border border-card-edge bg-popover p-1 ${OVERLAY_SHADOW}`,
        children: options.map((h) => /* @__PURE__ */ jsxs3(
          "button",
          {
            type: "button",
            role: "menuitemradio",
            "aria-checked": h === value,
            onClick: () => {
              onChange(h);
              setOpen(false);
            },
            className: `flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition ${FOCUS_RING} ${h === value ? "bg-primary/10 font-medium" : "hover:bg-accent"}`,
            children: [
              /* @__PURE__ */ jsx3(HarnessGlyph, { harness: h, className: "h-4 w-4 shrink-0 text-foreground" }),
              /* @__PURE__ */ jsx3("span", { className: "truncate", children: harnessLabel(h) }),
              h === value && /* @__PURE__ */ jsx3(CheckGlyph, { className: "ml-auto h-3.5 w-3.5 shrink-0 text-primary" })
            ]
          },
          h
        ))
      }
    )
  ] });
}
function useCoherentHandlers(props) {
  const { model, models, harness, onModelChange, onHarnessChange, harnessLockReason } = props;
  const canonicalIds = useMemo3(() => models.map((m) => m.id), [models]);
  const harnessLocked = harnessLockReason !== void 0;
  const onModel = (next) => {
    onModelChange(next);
    if (harnessLocked) return;
    const nextHarness = snapHarnessToModel(harness, next);
    if (nextHarness !== harness) onHarnessChange(nextHarness);
  };
  const onHarness = (next) => {
    onHarnessChange(next);
    const snapped = snapModelToHarness(next, model, canonicalIds);
    if (snapped !== model) onModelChange(snapped);
  };
  return { onModel, onHarness };
}
function AgentSessionControls(props) {
  const {
    models,
    modelsLoading,
    model,
    harness,
    availableHarnesses,
    effort,
    onEffortChange,
    effortLevels,
    layout = "inline",
    showHarness = true,
    harnessLockReason,
    variant = "chip",
    renderProviderBadge,
    className
  } = props;
  const { onModel, onHarness } = useCoherentHandlers(props);
  const [open, setOpen] = useState4(false);
  const { containerRef: popoverRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen);
  const panelId = useId2();
  const selectedModel = models.find((m) => m.id === model);
  const showEffort = selectedModel?.supportsReasoning ?? true;
  const modelPicker = /* @__PURE__ */ jsx3(
    ModelPicker,
    {
      value: model,
      onChange: onModel,
      models,
      loading: modelsLoading,
      renderProviderBadge,
      variant
    }
  );
  if (layout === "inline") {
    return /* @__PURE__ */ jsxs3("div", { className: `flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 ${className ?? ""}`, children: [
      modelPicker,
      showHarness && /* @__PURE__ */ jsx3(
        HarnessPicker,
        {
          value: harness,
          onChange: onHarness,
          available: availableHarnesses,
          lockReason: harnessLockReason,
          variant
        }
      ),
      showEffort && /* @__PURE__ */ jsx3(EffortPicker, { value: effort, onChange: onEffortChange, levels: effortLevels, variant })
    ] });
  }
  const hasAdvanced = showHarness || showEffort;
  return /* @__PURE__ */ jsxs3("div", { className: `flex items-center gap-1.5 ${className ?? ""}`, children: [
    modelPicker,
    hasAdvanced && /* @__PURE__ */ jsxs3("div", { ref: popoverRef, className: "relative inline-flex", children: [
      /* @__PURE__ */ jsx3(
        "button",
        {
          type: "button",
          ...triggerProps,
          "aria-controls": open ? panelId : void 0,
          onClick: () => setOpen(!open),
          title: "Model settings \u2014 pick the agent backend and how hard it thinks",
          className: `flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted ${FOCUS_RING}`,
          "data-state": open ? "open" : "closed",
          children: /* @__PURE__ */ jsx3(GearGlyph, { className: "h-4 w-4" })
        }
      ),
      /* @__PURE__ */ jsxs3(
        PopoverSurface,
        {
          open,
          id: panelId,
          triggerRef,
          panelRef,
          className: `w-72 space-y-3 overflow-y-auto rounded-xl border border-card-edge bg-popover p-3 ${OVERLAY_SHADOW}`,
          children: [
            showHarness && /* @__PURE__ */ jsxs3("div", { className: "space-y-1.5", children: [
              /* @__PURE__ */ jsx3("p", { className: "text-xs font-medium text-foreground", children: "Agent backend" }),
              /* @__PURE__ */ jsx3(
                HarnessPicker,
                {
                  value: harness,
                  onChange: onHarness,
                  available: availableHarnesses,
                  fullWidth: true,
                  lockReason: harnessLockReason,
                  variant
                }
              ),
              /* @__PURE__ */ jsx3("p", { className: "text-xs leading-snug text-muted-foreground", children: "The engine that runs the agent. Switching it keeps your model choice compatible." })
            ] }),
            showEffort && /* @__PURE__ */ jsxs3("div", { className: "space-y-1.5", children: [
              /* @__PURE__ */ jsx3("p", { className: "text-xs font-medium text-foreground", children: "Thinking" }),
              /* @__PURE__ */ jsx3(EffortPicker, { value: effort, onChange: onEffortChange, levels: effortLevels, label: "", fullWidth: true, variant }),
              /* @__PURE__ */ jsx3("p", { className: "text-xs leading-snug text-muted-foreground", children: "How hard the agent thinks before answering. Higher is slower but more thorough." })
            ] })
          ]
        }
      )
    ] })
  ] });
}

// src/web-react/composer-mode-controls.tsx
import { jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
function ListChecksGlyph({ className }) {
  return /* @__PURE__ */ jsx4("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx4("path", { d: "m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8" }) });
}
function ComposerModeControls({ planMode }) {
  if (!planMode) return null;
  return /* @__PURE__ */ jsxs4(
    "button",
    {
      type: "button",
      "aria-pressed": planMode.enabled,
      disabled: planMode.saving,
      onClick: () => planMode.setEnabled(!planMode.enabled),
      title: "Plan mode: the agent proposes a plan you approve before it executes",
      className: joinClasses(
        // Inset ring: this chip sits in a composer row that clips its overflow,
        // so an outward ring loses three of its four sides. Only the offset is
        // overridden — width and colour stay with the tokens.
        "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors focus-visible:[outline-offset:-2px]",
        planMode.enabled ? "border-primary/50 bg-primary/10 text-primary" : "border-border bg-transparent text-muted-foreground hover:text-foreground",
        planMode.saving && "opacity-60"
      ),
      children: [
        /* @__PURE__ */ jsx4(ListChecksGlyph, { className: "h-3.5 w-3.5" }),
        "Plan"
      ]
    }
  );
}

// src/web-react/entry-composer.tsx
import { useState as useState5 } from "react";
import { jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
function EntryComposer({
  heading,
  subheading,
  placeholder,
  initialValue = "",
  sendLabel,
  disabled,
  agent,
  modes,
  planMode,
  uploadUrl,
  accept = ATTACHMENT_ACCEPT,
  onAttachmentError,
  onRejectFiles,
  mentions,
  mentionPopoverClassName,
  footer,
  ready = true,
  onSubmit,
  className,
  composerClassName,
  maxWidth = 820
}) {
  const [value, setValue] = useState5(initialValue);
  const attachments = useComposerAttachments({
    uploadUrl,
    enabled: !!uploadUrl,
    onReject: onAttachmentError,
    onError: onAttachmentError
  });
  function submit(prompt) {
    if (!ready || disabled) return;
    const next = prompt.trim();
    if (attachments.hasPending || attachments.hasError) {
      if (attachments.blockReason) onAttachmentError?.(attachments.blockReason);
      return;
    }
    if (!next && attachments.references.length === 0) return;
    onSubmit(next, attachments.references, mentions?.mentions ?? []);
    setValue("");
    attachments.clear();
    mentions?.clearMentions();
  }
  return /* @__PURE__ */ jsx5(
    "div",
    {
      className: className ?? "relative flex flex-1 flex-col items-center justify-center overflow-hidden bg-background px-5",
      children: /* @__PURE__ */ jsxs5("div", { className: "w-full", style: { maxWidth }, children: [
        heading ? /* @__PURE__ */ jsx5("h2", { className: "mb-4 text-center text-[1.75rem] font-medium tracking-tight text-foreground", children: heading }) : null,
        subheading ? /* @__PURE__ */ jsx5("p", { className: "mx-auto mb-9 max-w-md text-center text-sm leading-relaxed text-muted-foreground", children: subheading }) : heading ? /* @__PURE__ */ jsx5("div", { className: "mb-7" }) : null,
        /* @__PURE__ */ jsx5(
          ChatComposer,
          {
            className: composerClassName ?? "vt-composer",
            value,
            onValueChange: setValue,
            onSend: (message) => submit(message),
            placeholder,
            sendLabel,
            sendVariant: "icon",
            disabled,
            autoFocus: true,
            focusShortcut: false,
            canSubmitAttachmentsOnly: true,
            accept,
            pendingFiles: attachments.composerFiles,
            onAttach: uploadUrl ? (files) => void attachments.addFiles(files) : void 0,
            onRejectFiles,
            onRemoveFile: attachments.removeAttachment,
            onRetryFile: attachments.retry,
            mention: mentions ? {
              ...mentions.mention,
              // Sidebar tone + hairline so the popover reads as app chrome
              // (the same treatment the picker menus get) instead of the
              // brighter overlay tone the component defaults to.
              popoverClassName: mentionPopoverClassName ?? "bg-surface-container-low border-[var(--md3-outline-variant)]"
            } : void 0,
            controls: modes ?? /* @__PURE__ */ jsx5(ComposerModeControls, { planMode }),
            trailing: agent ? /* @__PURE__ */ jsx5(AgentSessionControls, { ...agent }) : void 0
          }
        ),
        footer ? /* @__PURE__ */ jsx5("div", { className: "mt-7", children: footer }) : null
      ] })
    }
  );
}

export {
  isAcceptedFileType,
  acceptRejectionReason,
  filterAcceptedFiles,
  renamePastedImages,
  pickDictationMimeType,
  dictationErrorMessage,
  formatDictationElapsed,
  useDictation,
  ChatComposer,
  useComposerAttachments,
  HarnessGlyph,
  AgentSessionControls,
  ComposerModeControls,
  EntryComposer
};
//# sourceMappingURL=chunk-TNWQA5XJ.js.map