/**
 * The artifact origin: the only place cloud artifact HTML and scripts run.
 *
 * Mount it on a host of its own on a different site from the product (for
 * GTM, `gtm-artifacts.tangle.sh` against `gtm.tangle.tools`), so a page an
 * agent wrote never shares cookies, storage or same-site requests with a
 * signed-in product session. Every response also carries a CSP `sandbox`
 * without `allow-same-origin`, so each document runs in an opaque origin and
 * one artifact cannot read another's storage.
 *
 * A request names `/<artifactId>/<grant>/<token>/<path>`. The token is a
 * short-lived capability minted by the product after it authorized the viewer;
 * `resolve` returns the record only while that grant is still live, so a
 * revoked share stops serving on its next request.
 *
 * Files are streamed from the object store. For a `worker` artifact, a request
 * that matches no file runs `_worker.js` in a Worker Loader isolate with
 * `globalOutbound: null` (no network), CPU and subrequest limits, and only the
 * bindings `workerEnv` grants. Its response headers are replaced with this
 * origin's, so the isolate cannot loosen them.
 */
import type { ObjectStore } from '../object-store'
import {
  CLOUD_ARTIFACT_WORKER_MODULE,
  cloudArtifactObjectKey,
  readCloudArtifactViewUrl,
  type CloudArtifactGrant,
  type CloudArtifactRecord,
} from './cloud-artifacts'

/** Script and style CDNs a generated page may load. Everything else is local or inline. */
export const CLOUD_ARTIFACT_SCRIPT_HOSTS = [
  'https://cdn.jsdelivr.net',
  'https://cdnjs.cloudflare.com',
  'https://unpkg.com',
] as const

/** The iframe sandbox for an artifact frame; never add `allow-same-origin`. */
export const CLOUD_ARTIFACT_FRAME_SANDBOX =
  'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads'

/** The Content-Security-Policy every artifact response carries. */
export function cloudArtifactContentSecurityPolicy(input: { origin: string; frameAncestors: readonly string[] }): string {
  const self = new URL(input.origin).origin
  const cdns = CLOUD_ARTIFACT_SCRIPT_HOSTS.join(' ')
  return [
    "default-src 'none'",
    `script-src ${self} 'unsafe-inline' 'unsafe-eval' blob: ${cdns}`,
    `style-src ${self} 'unsafe-inline' https://fonts.googleapis.com ${cdns}`,
    `img-src ${self} data: blob: https:`,
    `font-src ${self} data: https:`,
    `media-src ${self} data: blob: https:`,
    `connect-src ${self}`,
    'frame-src https:',
    'worker-src blob:',
    `form-action ${self}`,
    "base-uri 'none'",
    `frame-ancestors ${input.frameAncestors.length > 0 ? input.frameAncestors.join(' ') : "'none'"}`,
    `sandbox ${CLOUD_ARTIFACT_FRAME_SANDBOX}`,
  ].join('; ')
}

/** The code shape Worker Loader's `get` callback returns (Cloudflare `WorkerCode`). */
export interface CloudArtifactWorkerCode {
  compatibilityDate: string
  compatibilityFlags?: string[]
  mainModule: string
  modules: Record<string, string | { js: string } | { json: unknown } | { text: string }>
  env?: Record<string, unknown>
  globalOutbound: null
  limits?: { cpuMs?: number; subRequests?: number }
}

/** Structural `env.LOADER` (a `worker_loaders` binding), so workers-types stays out of the public types. */
export interface CloudArtifactWorkerLoader {
  get(id: string, load: () => Promise<CloudArtifactWorkerCode>): {
    getEntrypoint(name?: string | null, options?: { limits?: { cpuMs?: number; subRequests?: number } }): {
      fetch(request: Request): Promise<Response>
    }
  }
}

export interface CloudArtifactOriginOptions {
  /** This origin, such as `https://gtm-artifacts.tangle.sh`. Requests for another host get 404. */
  origin: string
  /** Product origins allowed to frame an artifact (CSP `frame-ancestors`). */
  frameAncestors: readonly string[]
  /** The secret the product signs view links with. */
  secret: string
  store: ObjectStore
  /**
   * The artifact's current record for a verified link, or null when it no
   * longer exists or the grant is no longer live (a revoked share).
   */
  resolve(view: { artifactId: string; grant: CloudArtifactGrant }): Promise<CloudArtifactRecord | null>
  /** The `worker_loaders` binding. Without it a `worker` artifact serves only its files. */
  loader?: CloudArtifactWorkerLoader
  /** Bindings granted to a `worker` artifact's isolate; nothing else reaches it. */
  workerEnv?(record: CloudArtifactRecord, grant: CloudArtifactGrant): Record<string, unknown>
  workerLimits?: { cpuMs: number; subRequests: number }
  /** Compatibility date for isolates. */
  workerCompatibilityDate?: string
  now?: () => number
}

const DEFAULT_WORKER_LIMITS = { cpuMs: 50, subRequests: 20 }
const MAX_WORKER_SOURCE_BYTES = 4 * 1024 * 1024
const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'if-none-match', 'range']
const ROBOTS = 'User-agent: *\nDisallow: /\n'

function plain(status: number, text: string, headers: Headers): Response {
  headers.set('Content-Type', 'text/plain; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  return new Response(text, { status, headers })
}

/** Serve cloud artifacts on their own origin. */
export function createCloudArtifactOrigin(options: CloudArtifactOriginOptions): (request: Request) => Promise<Response> {
  const origin = new URL(options.origin).origin
  if (!/^https:\/\//.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    throw new Error('The cloud artifact origin must be HTTPS')
  }
  const ancestors = options.frameAncestors.map((value) => new URL(value).origin)
  if (ancestors.includes(origin)) {
    throw new Error('The cloud artifact origin must not be a product origin')
  }
  if (!options.secret.trim()) throw new Error('The cloud artifact origin needs the link signing secret')
  const csp = cloudArtifactContentSecurityPolicy({ origin, frameAncestors: ancestors })
  const limits = options.workerLimits ?? DEFAULT_WORKER_LIMITS

  const baseHeaders = (): Headers => new Headers({
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    // The view token is in the URL; never send it to a CDN or a linked site.
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    // Opaque-origin documents fetch their own files cross-origin; the URL token is the capability.
    'Access-Control-Allow-Origin': '*',
    'X-Robots-Tag': 'noindex, nofollow',
  })

  async function runWorker(
    request: Request,
    record: CloudArtifactRecord,
    grant: CloudArtifactGrant,
    path: string,
  ): Promise<Response> {
    const loader = options.loader
    if (!loader) return plain(404, 'Not found', baseHeaders())
    const version = record.version
    const worker = loader.get(`${record.id}:${version.id}`, async () => {
      const modules: CloudArtifactWorkerCode['modules'] = {}
      let bytes = 0
      for (const file of version.files) {
        const type = file.contentType.split(';')[0]
        if (type !== 'text/javascript' && type !== 'application/json') continue
        bytes += file.size
        if (bytes > MAX_WORKER_SOURCE_BYTES) throw new Error('Artifact worker source is too large')
        const object = await options.store.get(cloudArtifactObjectKey(record.workspaceId, file.sha256))
        if (!object) throw new Error(`Artifact file ${file.path} is missing from storage`)
        const text = await new Response(object.stream()).text()
        modules[file.path] = type === 'application/json' ? { json: JSON.parse(text) } : { js: text }
      }
      return {
        compatibilityDate: options.workerCompatibilityDate ?? '2026-10-01',
        mainModule: CLOUD_ARTIFACT_WORKER_MODULE,
        modules,
        env: options.workerEnv?.(record, grant) ?? {},
        globalOutbound: null,
        limits,
      }
    })
    const url = new URL(request.url)
    const headers = new Headers()
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name)
      if (value !== null) headers.set(name, value)
    }
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    const inner = new Request(`https://artifact.invalid/${path}${url.search}`, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
    })
    let response: Response
    try {
      response = await worker.getEntrypoint(null, { limits }).fetch(inner)
    } catch {
      return plain(502, "This artifact's server code failed.", baseHeaders())
    }
    const out = baseHeaders()
    const type = response.headers.get('Content-Type')
    if (type) out.set('Content-Type', type)
    out.set('Cache-Control', 'no-store')
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers: out })
  }

  return async function serve(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.origin !== origin) return plain(404, 'Not found', baseHeaders())
    if (url.pathname === '/robots.txt') return plain(200, ROBOTS, baseHeaders())
    if (request.method === 'OPTIONS') {
      const headers = baseHeaders()
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE')
      headers.set('Access-Control-Allow-Headers', 'Content-Type')
      headers.set('Access-Control-Max-Age', '600')
      return new Response(null, { status: 204, headers })
    }
    const view = await readCloudArtifactViewUrl(url, { secret: options.secret, now: options.now })
    if (!view) return plain(404, 'This link is invalid or has expired. Open the artifact again from its page.', baseHeaders())
    const record = await options.resolve({ artifactId: view.artifactId, grant: view.grant })
    if (!record || record.id !== view.artifactId) return plain(404, 'This artifact is no longer shared.', baseHeaders())
    const path = view.path || record.version.entry
    const file = record.version.kind === 'openui' ? undefined : record.version.files.find((item) => item.path === path)
    const readable = request.method === 'GET' || request.method === 'HEAD'
    if (file && readable && path !== CLOUD_ARTIFACT_WORKER_MODULE) {
      const object = await options.store.get(cloudArtifactObjectKey(record.workspaceId, file.sha256))
      if (!object) return plain(404, 'Not found', baseHeaders())
      const headers = baseHeaders()
      headers.set('Content-Type', file.contentType)
      headers.set('ETag', `"${file.sha256}"`)
      headers.set('Cache-Control', 'private, max-age=60')
      if (request.headers.get('If-None-Match') === `"${file.sha256}"`) {
        await object.stream().cancel()
        return new Response(null, { status: 304, headers })
      }
      headers.set('Content-Length', String(object.size))
      if (request.method === 'HEAD') await object.stream().cancel()
      return new Response(request.method === 'HEAD' ? null : object.stream(), { status: 200, headers })
    }
    if (record.version.kind === 'worker') return runWorker(request, record, view.grant, path)
    return plain(404, 'Not found', baseHeaders())
  }
}
