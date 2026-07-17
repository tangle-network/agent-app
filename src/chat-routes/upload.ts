/**
 * `createUploadRoute` — the multimodal middle. Accepts multipart file uploads
 * and returns `PromptInputPart`-shaped descriptors the client echoes back on
 * send (`ChatTurnRequestPayload.parts`):
 *
 *   ≤ inlineMaxBytes (700 KiB default) → inline `data:` URI part — rides the
 *     turn body directly, no sandbox round trip.
 *   > inlineMaxBytes → written into the sandbox workspace (base64 through the
 *     structural `write` seam — `box.fs` satisfies it) and referenced by
 *     `path`. Mandatory two-step: the gateway caps request bodies at ~1 MiB,
 *     so a large file can never ride the prompt POST.
 *
 * The sink is structural (no sandbox-SDK import); products pass `box.fs`.
 *
 * @remarks Sole consumer today is the `--chat` scaffold (`create-agent-app
 * --chat` → `template-chat/src/chat.ts`), the reference multimodal path. The
 * fleet apps (gtm/tax/legal/insurance) each keep their OWN upload route into a
 * durable vault (KV, or AES-GCM-encrypted R2) — a different persistence model
 * from this route's inline-`data:`-or-ephemeral-sandbox-workspace split, so
 * they don't (and shouldn't) route through it. This stays the scaffold's proven
 * upload pattern, not a fleet primitive; keep that distinction in mind before
 * widening its surface.
 */

import type { ChatTurnFilePartInput } from './wire'

/** 700 KiB: base64 inflates ~4/3, so an inline part stays comfortably under
 *  the ~1 MiB gateway body cap alongside the JSON envelope. */
export const UPLOAD_INLINE_MAX_BYTES = 700 * 1024

/** 8 MiB default ceiling per file — one base64 `write` call handles it. Raise
 *  it only with a sink that can take the bigger single write. */
export const UPLOAD_MAX_FILE_BYTES = 8 * 1024 * 1024

/** Structural match of the sandbox SDK's `box.fs` write surface (v0.10.5+:
 *  `encoding: 'base64'` is the worker-safe binary path). */
export interface SandboxUploadSink {
  write(path: string, content: string, options?: { encoding?: 'utf8' | 'base64' }): Promise<unknown>
}

export type UploadAuthorization =
  | {
      ok: true
      /** Where large files land. Absent/null: only inline uploads are
       *  accepted and an over-inline-cap file is rejected with 413. */
      sink?: SandboxUploadSink | null
      /** Per-request override of the workspace directory large files go to. */
      uploadDir?: string
    }
  | { ok: false; response: Response }

export interface CreateUploadRouteOptions {
  /** Authenticate the caller and resolve the sandbox file sink (usually
   *  `ensureWorkspaceSandbox(...)` → `box.fs`). */
  authorize(args: { request: Request }): Promise<UploadAuthorization>
  /** Inline-vs-sandbox threshold. Default {@link UPLOAD_INLINE_MAX_BYTES}. */
  inlineMaxBytes?: number
  /** Hard per-file cap. Default {@link UPLOAD_MAX_FILE_BYTES}. */
  maxFileBytes?: number
  /** Workspace directory for path-ref files. Default `'uploads'`. */
  uploadDir?: string
}

/** One uploaded file, ready for the composer chip and the turn body. */
export interface UploadedChatFile {
  id: string
  name: string
  size: number
  mediaType: string
  /** True when the part carries the bytes inline (`data:` URI). */
  inline: boolean
  /** Echo this back verbatim in `ChatTurnRequestPayload.parts`. */
  part: ChatTurnFilePartInput
}

/** Path-safe file name: basename only, conservative charset, length-capped. */
export function sanitizeUploadFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file'
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_')
  return (safe || 'file').slice(0, 120)
}

const BASE64_CHUNK = 0x8000

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK))
  }
  return btoa(binary)
}

function uploadError(status: number, code: string, error: string): Response {
  return Response.json({ code, error }, { status })
}

export function createUploadRoute(options: CreateUploadRouteOptions): (request: Request) => Promise<Response> {
  const inlineMaxBytes = options.inlineMaxBytes ?? UPLOAD_INLINE_MAX_BYTES
  const maxFileBytes = options.maxFileBytes ?? UPLOAD_MAX_FILE_BYTES

  return async function upload(request: Request): Promise<Response> {
    const auth = await options.authorize({ request })
    if (!auth.ok) return auth.response
    const sink = auth.sink ?? null
    const uploadDir = (auth.uploadDir ?? options.uploadDir ?? 'uploads').replace(/\/+$/, '')

    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return uploadError(400, 'INVALID_UPLOAD', 'Expected a multipart/form-data body with file fields')
    }
    const files: File[] = []
    form.forEach((value) => {
      if (value instanceof File) files.push(value)
    })
    if (files.length === 0) {
      return uploadError(400, 'INVALID_UPLOAD', 'No files in the upload body')
    }

    const uploaded: UploadedChatFile[] = []
    for (const file of files) {
      const name = sanitizeUploadFilename(file.name)
      const mediaType = file.type || 'application/octet-stream'
      const partType: ChatTurnFilePartInput['type'] = mediaType.startsWith('image/') ? 'image' : 'file'

      if (file.size > maxFileBytes) {
        return uploadError(
          413,
          'FILE_TOO_LARGE',
          `${name} is ${file.size}B, over the ${maxFileBytes}B per-file cap`,
        )
      }

      const id = crypto.randomUUID()
      if (file.size <= inlineMaxBytes) {
        const base64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()))
        uploaded.push({
          id,
          name,
          size: file.size,
          mediaType,
          inline: true,
          part: {
            type: partType,
            filename: name,
            mediaType,
            url: `data:${mediaType};base64,${base64}`,
          },
        })
        continue
      }

      if (!sink) {
        return uploadError(
          413,
          'SANDBOX_REQUIRED',
          `${name} is ${file.size}B, over the ${inlineMaxBytes}B inline cap, and no sandbox is available to hold it`,
        )
      }
      const path = `${uploadDir}/${id}-${name}`
      const base64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()))
      await sink.write(path, base64, { encoding: 'base64' })
      uploaded.push({
        id,
        name,
        size: file.size,
        mediaType,
        inline: false,
        part: { type: partType, filename: name, mediaType, path },
      })
    }

    return Response.json({ files: uploaded })
  }
}
