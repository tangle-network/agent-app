/**
 * Baseline frame pipeline behind the `VideoFrameProvider` seam: an off-DOM
 * HTMLVideoElement pool for video URLs and an HTMLImageElement pool for
 * stills, merged by a per-URL kind dispatcher so the editor canvas never
 * cares which kind a clip's media is. A WebCodecs implementation can replace
 * this wholesale behind the same seam.
 *
 * Server-safe at import time, browser-only at call time: nothing touches
 * `document` or `fetch` until a provider method runs.
 */

import type { VideoFrameProvider } from '../contracts'

export const DEFAULT_MAX_MEDIA_ELEMENTS = 4

/** Half a frame at 30fps. Seeks closer than this repaint the decoder's
 *  current frame instead of forcing a redundant seek. */
export const SEEK_TOLERANCE_SECONDS = 1 / 60

/** A seek that hasn't fired `seeked` after this long is a decode failure —
 *  the draw REJECTS rather than painting whatever frame happens to be up. */
export const SEEK_TIMEOUT_MS = 5_000

export interface FrameRect {
  x: number
  y: number
  width: number
  height: number
}

/** Object-fit 'contain' placement: preserve aspect ratio, fit entirely inside
 *  `dest`, center the residual space. Callers own clearing the letterbox
 *  margins — this paints only the fitted region. */
export function containFitRect(
  source: { width: number; height: number },
  dest: FrameRect,
): FrameRect {
  if (!(source.width > 0) || !(source.height > 0)) {
    throw new Error(`containFitRect requires positive source dimensions, got ${source.width}x${source.height}`)
  }
  if (!(dest.width > 0) || !(dest.height > 0)) {
    throw new Error(`containFitRect requires positive destination dimensions, got ${dest.width}x${dest.height}`)
  }
  const scale = Math.min(dest.width / source.width, dest.height / source.height)
  const width = source.width * scale
  const height = source.height * scale
  return {
    x: dest.x + (dest.width - width) / 2,
    y: dest.y + (dest.height - height) / 2,
    width,
    height,
  }
}

export function needsSeek(currentTimeSeconds: number, targetSeconds: number): boolean {
  return Math.abs(currentTimeSeconds - targetSeconds) >= SEEK_TOLERANCE_SECONDS
}

// ---------------------------------------------------------------------------
// LRU element pool
// ---------------------------------------------------------------------------

export interface PooledElementLease<T> {
  element: T
  /** Unpins the element; idle elements become LRU-evictable. Idempotent. */
  release(): void
}

export interface MediaElementPool<T> {
  acquire(url: string): PooledElementLease<T>
  has(url: string): boolean
  size(): number
  dispose(): void
}

/** LRU pool of media elements keyed by URL. Entries pinned by an outstanding
 *  lease are never evicted — a draw in flight must keep its element — so the
 *  pool can temporarily exceed `maxElements` under concurrent draws and
 *  shrinks back as leases release. */
export function createMediaElementPool<T>(opts: {
  maxElements: number
  create(url: string): T
  destroy(element: T, url: string): void
}): MediaElementPool<T> {
  if (!Number.isInteger(opts.maxElements) || opts.maxElements < 1) {
    throw new Error(`maxElements must be a positive integer, got ${opts.maxElements}`)
  }
  // Map insertion order doubles as recency: acquire re-inserts at the back,
  // so eviction scans from the front (least recently used).
  const entries = new Map<string, { element: T; pinned: number }>()
  let disposed = false

  const evictOverBudget = (): void => {
    if (entries.size <= opts.maxElements) return
    for (const [url, entry] of entries) {
      if (entries.size <= opts.maxElements) return
      if (entry.pinned > 0) continue
      entries.delete(url)
      opts.destroy(entry.element, url)
    }
  }

  return {
    acquire(url) {
      if (disposed) throw new Error(`media element pool is disposed — cannot acquire ${url}`)
      let entry = entries.get(url)
      if (entry) {
        entries.delete(url)
      } else {
        entry = { element: opts.create(url), pinned: 0 }
      }
      entries.set(url, entry)
      entry.pinned += 1
      evictOverBudget()
      let released = false
      return {
        element: entry.element,
        release: () => {
          if (released) return
          released = true
          entry.pinned -= 1
          evictOverBudget()
        },
      }
    },
    has: (url) => entries.has(url),
    size: () => entries.size,
    dispose() {
      disposed = true
      for (const [url, entry] of entries) opts.destroy(entry.element, url)
      entries.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Media kind dispatch
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set(['apng', 'avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'])
const VIDEO_EXTENSIONS = new Set(['m4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'ogv', 'webm'])

/** Extension-based kind classification; 'unknown' defers to a HEAD
 *  content-type probe at draw time. */
export function classifyMediaUrl(url: string): 'video' | 'image' | 'unknown' {
  const match = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(url)
  const extension = match?.[1]?.toLowerCase()
  if (extension === undefined) return 'unknown'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  return 'unknown'
}

async function probeMediaKind(url: string): Promise<'video' | 'image'> {
  const known = classifyMediaUrl(url)
  if (known !== 'unknown') return known
  let contentType: string | null = null
  try {
    const response = await fetch(url, { method: 'HEAD' })
    contentType = response.headers.get('content-type')
  } catch {
    // Servers that reject HEAD usually still serve the bytes; HTMLImageElement
    // is the cheapest probe-by-decoding, so unknowns route to the image path
    // and a genuine failure surfaces from image decode with the URL attached.
    return 'image'
  }
  if (contentType !== null) {
    if (contentType.startsWith('video/')) return 'video'
    if (contentType.startsWith('audio/')) {
      throw new Error(`cannot draw frames from audio media ${url} (content-type ${contentType})`)
    }
  }
  return 'image'
}

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

function requireDocument(caller: string): Document {
  if (typeof document === 'undefined') {
    throw new Error(`${caller} requires a browser document — frame providers are client-side only`)
  }
  return document
}

function assertSourceSeconds(sourceSeconds: number): void {
  if (!Number.isFinite(sourceSeconds) || sourceSeconds < 0) {
    throw new Error(`sourceSeconds must be a non-negative finite number, got ${sourceSeconds}`)
  }
}

// ---------------------------------------------------------------------------
// Video path
// ---------------------------------------------------------------------------

function createPooledVideo(url: string): HTMLVideoElement {
  const video = requireDocument('createVideoElementFrameProvider').createElement('video')
  video.crossOrigin = 'anonymous'
  video.muted = true
  video.preload = 'auto'
  video.playsInline = true
  video.src = url
  return video
}

function destroyPooledVideo(video: HTMLVideoElement): void {
  video.pause()
  // Clearing src alone leaves the media resource attached; the empty load()
  // is what actually releases the decoder.
  video.removeAttribute('src')
  video.load()
}

function awaitMediaEvent(video: HTMLVideoElement, eventName: string, url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      video.removeEventListener(eventName, onSuccess)
      video.removeEventListener('error', onError)
    }
    const onSuccess = (): void => {
      cleanup()
      resolve()
    }
    const onError = (): void => {
      cleanup()
      const detail = video.error ? `code ${video.error.code}: ${video.error.message}` : 'no MediaError attached'
      reject(new Error(`media error while waiting for '${eventName}' on ${url} (${detail})`))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out after ${SEEK_TIMEOUT_MS}ms waiting for '${eventName}' on ${url}`))
    }, SEEK_TIMEOUT_MS)
    video.addEventListener(eventName, onSuccess)
    video.addEventListener('error', onError)
  })
}

async function seekVideo(video: HTMLVideoElement, targetSeconds: number, url: string): Promise<void> {
  const seeked = awaitMediaEvent(video, 'seeked', url)
  // Out-of-range targets clamp to the media's end so timeline frames past the
  // source hold the last frame (standard NLE behavior) instead of erroring.
  video.currentTime = Number.isFinite(video.duration) && video.duration > 0
    ? Math.min(targetSeconds, video.duration)
    : targetSeconds
  await seeked
}

async function drawVideoFrame(
  video: HTMLVideoElement,
  url: string,
  sourceSeconds: number,
  ctx: CanvasRenderingContext2D,
  rect: FrameRect,
): Promise<void> {
  // HAVE_METADATA (readyState 1): dimensions + duration known, safe to seek.
  if (video.readyState < 1) await awaitMediaEvent(video, 'loadedmetadata', url)
  if (needsSeek(video.currentTime, sourceSeconds)) await seekVideo(video, sourceSeconds, url)
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    throw new Error(`media at ${url} decoded with no video frames (audio-only or corrupt) — cannot draw`)
  }
  const fit = containFitRect({ width: video.videoWidth, height: video.videoHeight }, rect)
  ctx.drawImage(video, fit.x, fit.y, fit.width, fit.height)
}

// ---------------------------------------------------------------------------
// Image path
// ---------------------------------------------------------------------------

interface PooledImage {
  element: HTMLImageElement
  ready: Promise<void>
}

function createPooledImage(url: string): PooledImage {
  const element = requireDocument('createImageFrameProvider').createElement('img')
  element.crossOrigin = 'anonymous'
  element.src = url
  const ready = element.decode().then(
    () => undefined,
    (error: unknown) => {
      throw new Error(`failed to decode image ${url}`, { cause: error })
    },
  )
  // prefetch never awaits `ready`; pre-attach a handler so a broken image
  // can't fire unhandledrejection. drawFrame's await still observes the error.
  void ready.catch(() => undefined)
  return { element, ready }
}

/** Stills behind the same `VideoFrameProvider` seam — `sourceSeconds` is
 *  validated for contract parity but does not affect the painted pixels. */
export function createImageFrameProvider(opts?: { maxElements?: number }): VideoFrameProvider {
  const pool = createMediaElementPool<PooledImage>({
    maxElements: opts?.maxElements ?? DEFAULT_MAX_MEDIA_ELEMENTS,
    create: createPooledImage,
    destroy: (pooled) => {
      pooled.element.src = ''
    },
  })
  return {
    async drawFrame(mediaUrl, sourceSeconds, ctx, rect) {
      assertSourceSeconds(sourceSeconds)
      const lease = pool.acquire(mediaUrl)
      try {
        await lease.element.ready
        const image = lease.element.element
        const fit = containFitRect({ width: image.naturalWidth, height: image.naturalHeight }, rect)
        ctx.drawImage(image, fit.x, fit.y, fit.width, fit.height)
      } finally {
        lease.release()
      }
    },
    prefetch(mediaUrl) {
      pool.acquire(mediaUrl).release()
    },
    dispose() {
      pool.dispose()
    },
  }
}

// ---------------------------------------------------------------------------
// Merged provider
// ---------------------------------------------------------------------------

/** The baseline provider `TimelineEditorProps.frameProvider` defaults to.
 *  Video and image pools each hold up to `maxElements` entries. */
export function createVideoElementFrameProvider(opts?: { maxElements?: number }): VideoFrameProvider {
  const maxElements = opts?.maxElements ?? DEFAULT_MAX_MEDIA_ELEMENTS
  const videoPool = createMediaElementPool<HTMLVideoElement>({
    maxElements,
    create: createPooledVideo,
    destroy: destroyPooledVideo,
  })
  const imageProvider = createImageFrameProvider({ maxElements })
  const kindByUrl = new Map<string, Promise<'video' | 'image'>>()
  // One draw at a time per URL: interleaved currentTime writes on a shared
  // element make the browser coalesce seeks, leaving earlier waiters watching
  // for a `seeked` event that never fires.
  const drawQueue = new Map<string, Promise<void>>()

  const resolveKind = (url: string): Promise<'video' | 'image'> => {
    let pending = kindByUrl.get(url)
    if (pending === undefined) {
      pending = probeMediaKind(url)
      // A rejected probe must not poison the cache — drop it so the next
      // draw retries instead of failing forever on a transient.
      pending.catch(() => kindByUrl.delete(url))
      kindByUrl.set(url, pending)
    }
    return pending
  }

  const enqueueVideoDraw = (url: string, work: () => Promise<void>): Promise<void> => {
    const previous = drawQueue.get(url) ?? Promise.resolve()
    const run = previous.then(work, work)
    const tail = run.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      if (drawQueue.get(url) === tail) drawQueue.delete(url)
    })
    drawQueue.set(url, tail)
    return run
  }

  return {
    async drawFrame(mediaUrl, sourceSeconds, ctx, rect) {
      assertSourceSeconds(sourceSeconds)
      const kind = await resolveKind(mediaUrl)
      if (kind === 'image') {
        await imageProvider.drawFrame(mediaUrl, sourceSeconds, ctx, rect)
        return
      }
      await enqueueVideoDraw(mediaUrl, async () => {
        const lease = videoPool.acquire(mediaUrl)
        try {
          await drawVideoFrame(lease.element, mediaUrl, sourceSeconds, ctx, rect)
        } finally {
          lease.release()
        }
      })
    },
    prefetch(mediaUrl) {
      // Best-effort warm: failures vanish here by design because the same
      // failure resurfaces with full detail on the next drawFrame.
      void resolveKind(mediaUrl)
        .then((kind) => {
          if (kind === 'image') {
            imageProvider.prefetch(mediaUrl)
            return
          }
          videoPool.acquire(mediaUrl).release()
        })
        .catch(() => undefined)
    },
    dispose() {
      videoPool.dispose()
      imageProvider.dispose()
      kindByUrl.clear()
      drawQueue.clear()
    },
  }
}
