/**
 * HTTP surface for workspace exports, mounted by a product under one path such
 * as `/api/workspaces/:id/exports`.
 *
 *   GET    {mount}                 list recent exports           owner
 *   POST   {mount}                 start (or resume) an export   owner
 *   GET    {mount}/:id             progress + signed link        owner
 *   POST   {mount}/:id/advance     do the next ~20 s of work     owner
 *   DELETE {mount}/:id             delete a finished export      owner
 *   GET    {mount}/:id/download    the zip                       signed link
 *
 * Authorization fails closed: no principal, a non-owner role, or an authorizer
 * that throws all refuse. Writes also require a same-origin request. The
 * download link is an HMAC-signed, short-lived URL bound to one workspace and
 * one export, so a browser can fetch it without a session header.
 */

import { signObjectUrl, verifyObjectUrl } from '../object-store'
import { createExportEngine, type ExportEngineOptions } from './engine'
import type { ExportJob, ExportPrincipal, ExportProgress } from './types'

export interface WorkspaceExportOptions extends ExportEngineOptions {
  /** Resolve the caller from the authenticated session. Return `null` when unauthenticated or not a member. */
  authorize(args: { request: Request; workspaceId: string }): Promise<ExportPrincipal | null>
  /** HMAC secret for download links. An empty secret refuses every download. */
  signingSecret: string
  /** Download link lifetime. Default 15 minutes. */
  linkTtlMs?: number
  /** Exports are deleted after this long. They hold decrypted data, so keep it short. Default 24 hours. */
  retentionMs?: number
  /** Work per advance request. Default 20 seconds. */
  advanceBudgetMs?: number
}

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE })
}

function refuse(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status)
}

function sameOrigin(request: Request): boolean {
  const site = request.headers.get('Sec-Fetch-Site')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = request.headers.get('Origin')
  if (origin && origin !== new URL(request.url).origin) return false
  return true
}

export function createWorkspaceExport(options: WorkspaceExportOptions) {
  const engine = createExportEngine(options)
  const linkTtlMs = options.linkTtlMs ?? 15 * 60_000
  const retentionMs = options.retentionMs ?? 24 * 60 * 60_000
  const now = options.now ?? (() => Date.now())

  async function withProgress(job: ExportJob, mount: string): Promise<ExportProgress> {
    const progress: ExportProgress = engine.progress(job)
    if (job.status === 'complete' && options.signingSecret) {
      const exp = now() + linkTtlMs
      const query = await signObjectUrl({ key: engine.archiveKey(job.workspaceId, job.id), exp, secret: options.signingSecret })
      progress.downloadUrl = `${mount}/${job.id}/download${query}`
      progress.downloadExpiresAt = new Date(exp).toISOString()
    }
    return progress
  }

  async function owner(request: Request, workspaceId: string): Promise<ExportPrincipal | Response> {
    let principal: ExportPrincipal | null
    try {
      principal = await options.authorize({ request, workspaceId })
    } catch {
      return refuse(503, 'authorization_unavailable', 'Could not check workspace access')
    }
    if (!principal) return refuse(403, 'forbidden', 'Workspace owner access is required')
    if (principal.role !== 'owner') return refuse(403, 'owner_required', 'Only the workspace owner can export its data')
    return principal
  }

  async function download(request: Request, workspaceId: string, id: string): Promise<Response> {
    const verified = await verifyObjectUrl(request, { secret: options.signingSecret })
    if (!verified.ok || verified.key !== engine.archiveKey(workspaceId, id)) {
      return refuse(403, 'link_invalid', 'This download link is invalid or has expired')
    }
    const job = await engine.get(workspaceId, id)
    if (!job || job.status !== 'complete') return refuse(404, 'not_found', 'Export not found')
    const { length, stream, filename } = engine.zip(job)
    return new Response(stream, {
      headers: {
        ...NO_STORE,
        'Content-Type': 'application/zip',
        'Content-Length': String(length),
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }

  /**
   * Handle one request. `path` is the part after the mount, without a leading
   * slash: `''`, `'<id>'`, `'<id>/advance'` or `'<id>/download'`.
   */
  async function route(request: Request, args: { workspaceId: string; path: string }): Promise<Response> {
    const { workspaceId } = args
    const path = args.path.replace(/^\/+|\/+$/g, '')
    const url = new URL(request.url)
    const mount = path ? url.pathname.slice(0, url.pathname.length - path.length).replace(/\/+$/, '') : url.pathname.replace(/\/+$/, '')
    const [id, action, extra] = path ? path.split('/') : []
    const method = request.method.toUpperCase()
    if (extra !== undefined) return refuse(404, 'not_found', 'Not found')

    try {
      if (id && action === 'download') {
        if (method !== 'GET') return refuse(405, 'method_not_allowed', 'Use GET')
        return await download(request, workspaceId, id)
      }

      if (method !== 'GET' && !sameOrigin(request)) return refuse(403, 'cross_origin', 'Cross-origin request refused')
      const principal = await owner(request, workspaceId)
      if (principal instanceof Response) return principal

      if (!id) {
        if (method === 'GET') {
          const jobs = await engine.list(workspaceId)
          return json({ exports: await Promise.all(jobs.map((job) => withProgress(job, mount))) })
        }
        if (method === 'POST') {
          await engine.prune(workspaceId, retentionMs)
          const job = await engine.start(workspaceId, principal.userId)
          return json(await withProgress(job, mount), 202)
        }
        return refuse(405, 'method_not_allowed', 'Use GET or POST')
      }

      if (!action) {
        if (method === 'GET') {
          const job = await engine.get(workspaceId, id)
          return job ? json(await withProgress(job, mount)) : refuse(404, 'not_found', 'Export not found')
        }
        if (method === 'DELETE') {
          const job = await engine.get(workspaceId, id)
          if (!job) return refuse(404, 'not_found', 'Export not found')
          if (job.status === 'running') return refuse(409, 'running', 'Wait for the export to finish before deleting it')
          await engine.prune(workspaceId, 0, id)
          return json({ deleted: id })
        }
        return refuse(405, 'method_not_allowed', 'Use GET or DELETE')
      }

      if (action === 'advance') {
        if (method !== 'POST') return refuse(405, 'method_not_allowed', 'Use POST')
        const job = await engine.advance(workspaceId, id, options.advanceBudgetMs)
        return job ? json(await withProgress(job, mount)) : refuse(404, 'not_found', 'Export not found')
      }
      return refuse(404, 'not_found', 'Not found')
    } catch {
      // Error text can carry data from a source; it is recorded, masked, on the job instead.
      return refuse(500, 'export_error', 'The export request failed')
    }
  }

  return { route, engine }
}
