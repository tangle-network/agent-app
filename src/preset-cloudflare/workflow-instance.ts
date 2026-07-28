/**
 * The structural part of a Cloudflare Workflow instance used to prove that a
 * failed create call actually left an addressable durable instance behind.
 */
export interface CloudflareWorkflowInstanceLike<TStatus = unknown> {
  status(): Promise<TStatus>
}

/** The structural binding implemented by Cloudflare's `Workflow<TParams>`. */
export interface CloudflareWorkflowBindingLike<
  TParams,
  TStatus = unknown,
  TInstance extends CloudflareWorkflowInstanceLike<TStatus> =
    CloudflareWorkflowInstanceLike<TStatus>,
> {
  create(input: { id: string; params: TParams }): Promise<TInstance>
  get(id: string): Promise<TInstance>
}

export interface EnsureCloudflareWorkflowInstanceResult<
  TStatus,
  TInstance extends CloudflareWorkflowInstanceLike<TStatus>,
> {
  instance: TInstance
  /** False only when create failed but the same id was proven readable. */
  created: boolean
  /** Present on reuse because reading status is the proof the instance exists. */
  status?: TStatus
}

/**
 * Create one durable Workflow instance, or prove an instance with the same id
 * already exists before accepting a create error as an idempotent retry.
 *
 * Cloudflare does not expose a stable duplicate-error class. Matching error
 * text can therefore swallow unrelated failures. This helper uses the durable
 * resource itself as proof: `get(id).status()` must succeed, otherwise the
 * original create error is rethrown.
 */
export async function ensureCloudflareWorkflowInstance<
  TParams,
  TStatus,
  TInstance extends CloudflareWorkflowInstanceLike<TStatus>,
>(
  binding: CloudflareWorkflowBindingLike<TParams, TStatus, TInstance>,
  input: { id: string; params: TParams },
): Promise<EnsureCloudflareWorkflowInstanceResult<TStatus, TInstance>> {
  try {
    return {
      instance: await binding.create(input),
      created: true,
    }
  } catch (createError) {
    try {
      const instance = await binding.get(input.id)
      const status = await instance.status()
      return { instance, created: false, status }
    } catch {
      throw createError
    }
  }
}
