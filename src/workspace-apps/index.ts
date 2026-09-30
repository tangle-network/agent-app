/** A sandbox app registered in one product workspace. Products persist and authorize these rows. */
export interface WorkspaceAppRecord {
  id: string
  workspaceId: string
  name: string
  sandboxId: string
  previewId: string
  port: number
  previewUrl: string
  status: 'starting' | 'ready' | 'unavailable'
  createdAt: string
  updatedAt: string
}

/** Structural shape returned by the Sandbox SDK previewLinks API. */
export interface WorkspaceAppPreviewLink {
  previewId: string
  sandboxId: string
  port: number
  protocol: 'tcp' | 'udp'
  hostname: string
  url: string
  status: 'provisioning' | 'ready' | 'error' | 'disabled'
}

export interface WorkspaceAppIdentity {
  /** Assigned by the product, stable across preview updates and deliberate republishes. */
  id: string
  /** Taken from the authenticated route or session, never agent tool arguments. */
  workspaceId: string
  /** Current box resolved by the product from that workspace or session. */
  sandboxId: string
  name: string
  /** Preserve this when republishing the same app onto a replacement sandbox. */
  createdAt?: string
  updatedAt?: string
}

function nonempty(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid workspace app ' + field)
  }
  return value.trim()
}

function checkedLink(link: WorkspaceAppPreviewLink, sandboxId: string): void {
  if (link.sandboxId !== sandboxId) {
    throw new Error('Preview link belongs to another sandbox')
  }
  nonempty(link.previewId, 'previewId')
  if (link.protocol !== 'tcp') throw new Error('Workspace app preview must use TCP')
  if (!Number.isInteger(link.port) || link.port < 1 || link.port > 65535) {
    throw new Error('Invalid workspace app port')
  }
  if (!['provisioning', 'ready', 'error', 'disabled'].includes(link.status)) {
    throw new Error('Invalid workspace app preview status')
  }
  let url: URL
  try {
    url = new URL(link.url)
  } catch {
    throw new Error('Invalid workspace app preview URL')
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.hostname !== link.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid workspace app preview URL')
  }
}

function appStatus(status: WorkspaceAppPreviewLink['status']): WorkspaceAppRecord['status'] {
  if (status === 'ready' || status === 'provisioning') return 'starting'
  return 'unavailable'
}

/**
 * Build a durable registration from a preview link created on the box that
 * the authenticated product request resolved. The product owns row identity,
 * access policy, persistence, and the decision to publish.
 */
export function workspaceAppFromPreviewLink(
  identity: WorkspaceAppIdentity,
  link: WorkspaceAppPreviewLink,
): WorkspaceAppRecord {
  const sandboxId = nonempty(identity.sandboxId, 'sandboxId')
  checkedLink(link, sandboxId)
  const timestamp = identity.updatedAt ?? new Date().toISOString()
  return {
    id: nonempty(identity.id, 'id'),
    workspaceId: nonempty(identity.workspaceId, 'workspaceId'),
    name: nonempty(identity.name, 'name'),
    sandboxId,
    previewId: link.previewId,
    port: link.port,
    previewUrl: link.url,
    status: appStatus(link.status),
    createdAt: identity.createdAt ?? timestamp,
    updatedAt: timestamp,
  }
}

export interface WorkspaceAppHttpProof {
  /** The exact trusted SDK preview URL requested by the server. */
  previewUrl: string
  status: number
  contentType: string
  /** Number of bytes read from the response body, excluding headers. */
  bodyBytes: number
  checkedAt: string
}

/**
 * Mark an app ready only after the host fetched its HTML over the trusted
 * preview URL. The host owns the request timeout, redirect and credential
 * policy, authorization, and compare-and-swap storage update.
 */
export function confirmWorkspaceAppReady(
  app: WorkspaceAppRecord,
  proof: WorkspaceAppHttpProof,
): WorkspaceAppRecord {
  if (
    proof.previewUrl !== app.previewUrl ||
    proof.status !== 200 ||
    !/^text\/html(?:\s*;|\s*$)/i.test(proof.contentType) ||
    !Number.isInteger(proof.bodyBytes) ||
    proof.bodyBytes < 1 ||
    !Number.isFinite(Date.parse(proof.checkedAt))
  ) {
    throw new Error('Workspace app HTML preview is not ready')
  }
  return { ...app, status: 'ready', updatedAt: proof.checkedAt }
}

/** Refresh delivery state without changing which sandbox service this app means. */
export function refreshWorkspaceAppPreview(
  app: WorkspaceAppRecord,
  link: WorkspaceAppPreviewLink,
  updatedAt = new Date().toISOString(),
): WorkspaceAppRecord {
  checkedLink(link, app.sandboxId)
  if (link.previewId !== app.previewId || link.port !== app.port) {
    throw new Error('Preview link does not match workspace app')
  }
  return {
    ...app,
    previewUrl: link.url,
    status: appStatus(link.status),
    updatedAt,
  }
}

export type WorkspaceAppBuilderInstructionsOptions =
  | {
    /** Host tool that writes the registration after creating a trusted preview. */
    publishTool: string
    /** Optional host tool for finding app IDs the builder may update. */
    listTool?: string
    manifestPath?: never
  }
  | {
    /** Host-scoped manifest the builder writes after creating runnable projects. */
    manifestPath: string
    publishTool?: never
    listTool?: never
  }

function toolName(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(value)) {
    throw new Error('Invalid workspace app tool name')
  }
  return value
}

function builderManifestPath(value: string): string {
  if (
    !/^[A-Za-z0-9._-]+(?:[/][A-Za-z0-9._-]+)*$/.test(value) ||
    value.split('/').some(segment => segment === '..' || segment === '.')
  ) {
    throw new Error('Invalid workspace app manifest path')
  }
  return value
}

/** Portable instructions for an agent profile that builds workspace apps. */
export function workspaceAppBuilderInstructions(
  options: WorkspaceAppBuilderInstructionsOptions,
): string[] {
  const common = [
    'Build a working HTTP application in the current sandbox when the user asks for an app.',
    'Keep the same app ID for later revisions of that app.',
    'Treat a preview link as public. Do not embed secrets or private business facts in client code or responses.',
    'Read real business data through authorized product APIs. Do not fabricate records to make the app look complete.',
    'Report the app as available only after the host confirms its preview is ready.',
  ] as const
  if (options.manifestPath !== undefined) {
    const path = builderManifestPath(options.manifestPath)
    return [
      common[0],
      'Inspect the existing app projects and manifest before creating or updating an app.',
      'Keep each runnable project under apps/<id> relative to the sandbox working directory. Give it a package.json dev script; its HTTP server must listen on 0.0.0.0 and use PORT when supplied.',
      'Write ' + path + ' as JSON with exactly an apps array of { id, name, projectPath } records; each projectPath is apps/<id>.',
      'Do not put URLs, credentials, tokens, sandbox IDs, or preview IDs in that manifest.',
      'The host reads this manifest and owns server launch, port selection, preview creation, registration, and access policy.',
      ...common.slice(1),
    ]
  }
  const publish = toolName(options.publishTool)
  const list = options.listTool ? toolName(options.listTool) : undefined
  return [
    common[0],
    ...(list ? ['Use ' + list + ' to inspect the existing apps before creating or updating one.'] : []),
    'Start its server on 0.0.0.0 using an available, unclaimed port.',
    'Call ' + publish + ' with the app name, stable app ID when updating, and listening port.',
    'Use the host tool result as the source of the registered app URL and status; never invent a preview URL.',
    ...common.slice(1),
  ]
}
