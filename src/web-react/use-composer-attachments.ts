/**
 * `useComposerAttachments` — the composer's staged-upload lifecycle: validate
 * selected/dropped/pasted files against the shared limits (the SAME
 * `sniffBinary`/`checkAttachmentType`/size-cap vocabulary the store-backed
 * upload route enforces server-side, `../chat-routes/attachment-validation`
 * + `../chat-routes/binary-sniff`), upload each accepted file with one POST
 * request per file (so a single failure never poisons the batch), and track
 * every file's status so a host composer can render chips and gate sending.
 *
 * Ported from gtm-agent's `src/components/composer-attachments.tsx`
 * (gtm#584/#592/#593 hardened the sniff gate and batch semantics this leans
 * on), de-gtm-ified:
 *   - the hardcoded `/api/vault/upload?workspaceId=` URL becomes
 *     `uploadUrl`/`buildUploadRequest` (the latter wins — it hands back both
 *     the URL and a `RequestInit` override, e.g. an auth header);
 *   - `sonner` toasts become `onReject` (client pre-validation, never hits the
 *     network) and `onError` (a request that reached the server and failed);
 *   - the sandbox-ui `validateComposerFiles` import becomes a small
 *     accept-list matcher re-implemented locally (`isAcceptedFileType`,
 *     mirroring its `accept`-string matching byte-for-byte) — this module
 *     stays free of the sandbox-ui peer;
 *   - the response is expected to be `{ files: ChatAttachmentInput[] }` (full
 *     server-authoritative descriptors — size/mediaType/kind — not gtm's
 *     `{path, name}`), so `references` is a verbatim pass-through with no
 *     client recompute;
 *   - `workspaceId`'s truthiness gate becomes `enabled` (default `true`).
 *
 * Import-free beyond React + the browser-safe `/chat-routes` validation core:
 * this module ships through `/web-react` into client bundles
 * (`tests/browser-safe-subpaths.test.ts` walks the graph), so nothing here
 * may reach a Node builtin, `sandbox-ui`, or an engine package.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatAttachmentInput, ChatAttachmentKind } from './chat-stream'
import type { ComposerFile } from './chat-composer'
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
} from '../chat-routes/attachment-validation'
import { sniffBinary } from '../chat-routes/binary-sniff'

export { ATTACHMENT_ACCEPT } from '../chat-routes/attachment-validation'

/** One staged file and its upload lifecycle. `file` is retained so a failed
 *  upload can be retried without re-selecting; `previewUrl` is an object URL
 *  for image thumbnails and must be revoked when the entry leaves the queue.
 *  `reference` is the server's authoritative descriptor once the upload
 *  lands — stored verbatim, never recomputed client-side. */
interface StagedAttachment {
  id: string
  file: File
  name: string
  size: number
  status: 'pending' | 'uploading' | 'ready' | 'error'
  reference?: ChatAttachmentInput
  previewUrl?: string
  errorMessage?: string
}

export interface UseComposerAttachmentsOptions {
  /** Simple upload target: every file POSTs here. Ignored when
   *  `buildUploadRequest` is provided. */
  uploadUrl?: string
  /** Full request-building seam (auth headers, per-file routing, …) — wins
   *  over `uploadUrl` when both are set. */
  buildUploadRequest?: (args: { file: File; name: string; form: FormData }) => {
    url: string
    init?: Omit<RequestInit, 'body' | 'signal'>
  }
  /** Client pre-validation rejections — a file that never reaches the
   *  network (bad type, over a size cap, over count, disallowed kind). */
  onReject?: (reason: string, file?: File) => void
  /** A file that reached the upload endpoint and failed (HTTP error,
   *  transport error, malformed response). */
  onError?: (reason: string) => void
  limits?: {
    maxCount?: number
    maxBinaryBytes?: number
    maxTextBytes?: number
    maxTotalBytes?: number
  }
  /** Attachment kinds accepted, checked against the sniffed content's
   *  mime. Default: both (`['image', 'file']` — i.e. no restriction). */
  allowedKinds?: ChatAttachmentKind[]
  /** `<input accept>`-style gate for the file picker/drop/paste path.
   *  Default {@link ATTACHMENT_ACCEPT}. */
  accept?: string
  /** When `false`, `addFiles` rejects every call via `onReject` (and
   *  `blockReason` explains why) instead of staging anything — the
   *  replacement for gtm's `workspaceId`-truthiness gate (e.g. no workspace
   *  loaded yet). Default `true`. */
  enabled?: boolean
}

export interface UseComposerAttachmentsResult {
  /** Chip models for `ChatComposer`'s `pendingFiles` prop, one per staged
   *  file — `kind` is always `'file'` (agent-app's `ComposerFile.kind`
   *  discriminates file-vs-folder chips, not attachment media type). */
  composerFiles: ComposerFile[]
  /** Ready-to-send attachment descriptors — only files whose upload
   *  succeeded, straight from the server's response (no recompute). Feed
   *  this into `ChatTurnRequestPayload.attachments`. */
  references: ChatAttachmentInput[]
  /** Validate + stage + upload the given files, one request per file. */
  addFiles: (files: File[] | FileList) => Promise<void>
  /** Re-upload a failed entry using its retained `File`. */
  retry: (id: string) => void
  /** Drop one staged entry, aborting its upload and revoking its preview. */
  removeAttachment: (id: string) => void
  /** Forget every staged entry (call after a successful send). */
  clear: () => void
  /** True while any file is still pending or uploading. */
  hasPending: boolean
  /** True while any file failed to upload. */
  hasError: boolean
  /** Why a send is blocked, or `null` when the queue is clean. */
  blockReason: string | null
}

function newId(): string {
  const cryptoObject = globalThis.crypto
  if (typeof cryptoObject?.randomUUID === 'function') return cryptoObject.randomUUID()
  return `att-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Suffix a name (`report.pdf` → `report-2.pdf`) until it's unused. The
 *  server writes to a name-derived store path, so identical names would
 *  overwrite. The suffix stays inside the store-path charset (see
 *  `sanitizeAttachmentFileName`). Ported byte-for-byte from gtm's
 *  `dedupeName`. */
function dedupeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let n = 2
  let candidate = `${base}-${n}${ext}`
  while (taken.has(candidate)) {
    n += 1
    candidate = `${base}-${n}${ext}`
  }
  return candidate
}

/** `image/*` → `'image'`, everything else → `'file'`. Deliberately
 *  reimplemented here (not imported from `../chat-store/parts`, which pulls
 *  the drizzle-adjacent `/chat-store` barrel): this module must stay reachable
 *  from a browser bundle with only the `/chat-routes` validation core as a
 *  dependency. */
function kindForMime(mime: string): ChatAttachmentKind {
  return mime.startsWith('image/') ? 'image' : 'file'
}

/** `<input accept>`-style matcher: extension (`.pdf`), wildcard mime
 *  (`image/*`), or exact mime. Reimplemented locally (NOT imported from
 *  `@tangle-network/sandbox-ui`'s `validateComposerFiles`/`isAcceptedType`) so
 *  this module has no sandbox-ui dependency; the matching semantics are kept
 *  identical so a rejection reads the same either side of the fence. */
function isAcceptedFileType(file: File, accept: string): boolean {
  const patterns = accept.split(',').map((p) => p.trim()).filter((p) => p.length > 0)
  if (patterns.length === 0) return true
  const name = file.name.toLowerCase()
  const type = (file.type || '').toLowerCase()
  return patterns.some((pattern) => {
    const lower = pattern.toLowerCase()
    if (lower.startsWith('.')) return name.endsWith(lower)
    if (lower.endsWith('/*')) return type.startsWith(lower.slice(0, -1))
    return type === lower
  })
}

/** Pull a human-readable message out of the upload endpoint's error body.
 *  Ported from gtm's `parseUploadError`: handles both `{ error: string }`
 *  (size/count/access errors) and `{ error: { message } }` (the
 *  `createAttachmentUploadRoute` envelope, `{error:{code,message,path?}}`). */
async function parseUploadError(res: Response): Promise<string> {
  const detail = await res.json().catch(() => null)
  if (detail && typeof detail === 'object' && 'error' in detail) {
    const error = (detail as { error: unknown }).error
    if (typeof error === 'string' && error) return error
    if (error && typeof error === 'object' && 'message' in error) {
      const message = (error as { message: unknown }).message
      if (typeof message === 'string' && message) return message
    }
  }
  return `Upload failed (${res.status})`
}

/** Shown when neither `uploadUrl` nor `buildUploadRequest` is configured
 *  while `enabled` — a product wiring bug, not a user-facing rejection, so it
 *  lands each affected entry in `error` (with `onError`) rather than blocking
 *  `addFiles` outright via `onReject`: the files still stage and can be
 *  retried once the product fixes its config, instead of silently vanishing. */
const NO_UPLOAD_TARGET_MESSAGE = 'No upload destination configured (pass uploadUrl or buildUploadRequest)'

/**
 * Owns the composer's attachment lifecycle: validate selected/dropped/pasted
 * files against the shared limits, upload each accepted file to the
 * product's store (one request per file), and track every file's status so
 * the composer can render chips and gate sending.
 *
 * Failures surface loud — a rejected file calls `onReject` and is never
 * uploaded; a failed upload calls `onError` and leaves an error chip the user
 * can retry or remove. `references` only ever contains files whose upload the
 * server actually confirmed.
 */
export function useComposerAttachments(
  options: UseComposerAttachmentsOptions,
): UseComposerAttachmentsResult {
  // Latest options, read from inside stable callbacks — avoids re-creating
  // `addFiles`/`upload` (and therefore breaking referential stability for
  // effects a host might hang off them) every time a caller passes a fresh
  // options object literal.
  const optionsRef = useRef(options)
  optionsRef.current = options

  const [staged, setStagedState] = useState<StagedAttachment[]>([])
  // Mirror of `staged` kept in lockstep so dedupe/aggregate-cap/abort read
  // current values synchronously (setState callbacks alone can't answer
  // "what's staged right now" mid-validation).
  const stagedRef = useRef<StagedAttachment[]>([])
  const controllersRef = useRef<Map<string, AbortController>>(new Map())

  // Post-unmount calls reduce to a React no-op setState; the refs they touch
  // die with the instance.
  const setStaged = useCallback(
    (updater: StagedAttachment[] | ((prev: StagedAttachment[]) => StagedAttachment[])) => {
      const next =
        typeof updater === 'function'
          ? (updater as (prev: StagedAttachment[]) => StagedAttachment[])(stagedRef.current)
          : updater
      stagedRef.current = next
      setStagedState(next)
    },
    [],
  )

  const upload = useCallback(
    async (id: string, file: File, name: string) => {
      const opts = optionsRef.current
      setStaged((prev) =>
        prev.map((s) => (s.id === id ? { ...s, status: 'uploading', errorMessage: undefined } : s)),
      )
      const controller = new AbortController()
      controllersRef.current.set(id, controller)
      const form = new FormData()
      form.append('file', file, name)

      const request = opts.buildUploadRequest
        ? opts.buildUploadRequest({ file, name, form })
        : opts.uploadUrl
          ? { url: opts.uploadUrl }
          : null

      if (!request) {
        setStaged((prev) =>
          prev.map((s) =>
            s.id === id ? { ...s, status: 'error', errorMessage: NO_UPLOAD_TARGET_MESSAGE } : s,
          ),
        )
        opts.onError?.(NO_UPLOAD_TARGET_MESSAGE)
        controllersRef.current.delete(id)
        return
      }

      try {
        const res = await fetch(request.url, {
          method: 'POST',
          credentials: 'same-origin',
          ...request.init,
          body: form,
          signal: controller.signal,
        })
        if (!res.ok) {
          const message = await parseUploadError(res)
          setStaged((prev) =>
            prev.map((s) => (s.id === id ? { ...s, status: 'error', errorMessage: message } : s)),
          )
          opts.onError?.(message)
          return
        }
        const data = (await res.json()) as { files?: ChatAttachmentInput[] }
        const uploaded = data.files?.[0]
        if (!uploaded) {
          const message = 'Upload returned no file'
          setStaged((prev) =>
            prev.map((s) => (s.id === id ? { ...s, status: 'error', errorMessage: message } : s)),
          )
          opts.onError?.(message)
          return
        }
        setStaged((prev) =>
          prev.map((s) => (s.id === id ? { ...s, status: 'ready', reference: uploaded } : s)),
        )
      } catch (err) {
        if ((err as Error).name === 'AbortError') return // silent removal — see removeAttachment/clear
        const message =
          err instanceof Error && err.message ? err.message : 'Upload failed — check your connection'
        setStaged((prev) =>
          prev.map((s) => (s.id === id ? { ...s, status: 'error', errorMessage: message } : s)),
        )
        opts.onError?.(message)
      } finally {
        controllersRef.current.delete(id)
      }
    },
    [setStaged],
  )

  const addFiles = useCallback(
    async (files: File[] | FileList) => {
      const opts = optionsRef.current
      const enabled = opts.enabled ?? true
      if (!enabled) {
        opts.onReject?.('Attachments are disabled')
        return
      }

      const accept = opts.accept ?? ATTACHMENT_ACCEPT
      const maxCount = opts.limits?.maxCount ?? ATTACHMENT_MAX_COUNT
      const maxBinaryBytes = opts.limits?.maxBinaryBytes ?? MAX_BINARY_ATTACHMENT_BYTES
      const maxTextBytes = opts.limits?.maxTextBytes ?? MAX_TEXT_ATTACHMENT_BYTES
      const maxTotalBytes = opts.limits?.maxTotalBytes ?? MAX_ATTACHMENT_TOTAL_BYTES
      const allowedKinds = opts.allowedKinds ?? (['image', 'file'] as ChatAttachmentKind[])

      const list = Array.isArray(files) ? files : Array.from(files)

      // Pass 1: accept-list + count cap, mirroring sandbox-ui's
      // `validateComposerFiles` semantics (accept checked before count, count
      // checked against currently-staged + already-accepted-this-batch).
      const currentCount = stagedRef.current.length
      const countAccepted: File[] = []
      for (const file of list) {
        if (!isAcceptedFileType(file, accept)) {
          opts.onReject?.(`"${file.name}" is not an accepted file type (${accept}).`, file)
          continue
        }
        if (currentCount + countAccepted.length >= maxCount) {
          opts.onReject?.(`"${file.name}" was not added — the ${maxCount}-file limit is already reached.`, file)
          continue
        }
        countAccepted.push(file)
      }

      // Pass 2: real content sniff + type gate + per-kind size cap +
      // allowed-kinds gate — the SAME checks the server enforces, so a
      // rejection never differs depending on which side classified the bytes
      // first. Nothing here ever reaches the network.
      const sizeAccepted: File[] = []
      for (const file of countAccepted) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const sniff = sniffBinary(bytes)
        const typeCheck = checkAttachmentType(file.name, sniff)
        if (!typeCheck.succeeded) {
          opts.onReject?.(typeCheck.message, file)
          continue
        }
        const limit = sniff.binary ? maxBinaryBytes : maxTextBytes
        if (file.size > limit) {
          opts.onReject?.(attachmentSizeErrorMessage(file.name, file.size, limit), file)
          continue
        }
        const mediaType = sniff.mime ?? file.type ?? ''
        const kind = kindForMime(mediaType)
        if (!allowedKinds.includes(kind)) {
          opts.onReject?.(`"${file.name}" is a ${kind} attachment, which isn't accepted here`, file)
          continue
        }
        sizeAccepted.push(file)
      }

      // Pass 3: running aggregate cap across this batch + everything already
      // staged (any status) — a partial batch can still land.
      const accepted: File[] = []
      let totalBytes = stagedRef.current.reduce((total, s) => total + s.size, 0)
      for (const file of sizeAccepted) {
        const nextTotalBytes = totalBytes + file.size
        if (nextTotalBytes > maxTotalBytes) {
          opts.onReject?.(attachmentTotalSizeErrorMessage(nextTotalBytes, maxTotalBytes), file)
          continue
        }
        accepted.push(file)
        totalBytes = nextTotalBytes
      }
      if (accepted.length === 0) return

      // Stage under the name the server will actually store, so the chip and
      // the message's attachment references never diverge.
      const taken = new Set(stagedRef.current.map((s) => s.name))
      const entries: StagedAttachment[] = accepted.map((file) => {
        const name = dedupeName(sanitizeAttachmentFileName(file.name), taken)
        taken.add(name)
        return {
          id: newId(),
          file,
          name,
          size: file.size,
          status: 'pending',
          previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
        }
      })
      setStaged((prev) => [...prev, ...entries])
      for (const entry of entries) void upload(entry.id, entry.file, entry.name)
    },
    [setStaged, upload],
  )

  const retry = useCallback(
    (id: string) => {
      const entry = stagedRef.current.find((s) => s.id === id)
      if (!entry) return
      void upload(entry.id, entry.file, entry.name)
    },
    [upload],
  )

  const removeAttachment = useCallback(
    (id: string) => {
      controllersRef.current.get(id)?.abort()
      controllersRef.current.delete(id)
      const entry = stagedRef.current.find((s) => s.id === id)
      if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl)
      setStaged((prev) => prev.filter((s) => s.id !== id))
    },
    [setStaged],
  )

  const clear = useCallback(() => {
    for (const controller of controllersRef.current.values()) controller.abort()
    controllersRef.current.clear()
    for (const entry of stagedRef.current) {
      if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl)
    }
    setStaged([])
  }, [setStaged])

  useEffect(
    () => () => {
      for (const controller of controllersRef.current.values()) controller.abort()
      controllersRef.current.clear()
      for (const entry of stagedRef.current) {
        if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl)
      }
    },
    [],
  )

  const composerFiles = useMemo<ComposerFile[]>(
    () =>
      staged.map((s) => ({
        id: s.id,
        name: s.name,
        size: s.size,
        kind: 'file' as const,
        status: s.status,
      })),
    [staged],
  )

  const references = useMemo<ChatAttachmentInput[]>(
    () =>
      staged
        .filter((s): s is StagedAttachment & { reference: ChatAttachmentInput } => s.status === 'ready' && !!s.reference)
        .map((s) => s.reference),
    [staged],
  )

  const hasPending = useMemo(
    () => staged.some((s) => s.status === 'pending' || s.status === 'uploading'),
    [staged],
  )
  const hasError = useMemo(() => staged.some((s) => s.status === 'error'), [staged])
  const enabled = options.enabled ?? true
  const blockReason = !enabled
    ? 'Attachments are disabled'
    : hasPending
      ? 'Attachments are still uploading'
      : hasError
        ? 'Remove failed attachments to send'
        : null

  return {
    composerFiles,
    references,
    addFiles,
    retry,
    removeAttachment,
    clear,
    hasPending,
    hasError,
    blockReason,
  }
}
