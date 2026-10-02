import { describe, expect, it, vi } from 'vitest'
import { createAgentEnrollment, EnrollmentTargetError, type AgentEnrollmentClaim, type AgentEnrollmentTarget } from './index'

const identity = {
  enrollmentId: 'enrollment-1', agentId: 'agent-1', workspaceId: 'workspace-1', threadId: 'thread-1',
}

function fixture() {
  let retained: AgentEnrollmentTarget | null = null
  let claimed: AgentEnrollmentClaim | null = null
  let generation = 1
  let sandboxId = 'sandbox-1'
  let incarnation = 'incarnation-1'
  let sessionExists = true
  let authorized = true
  const session = { status: vi.fn(async () => sessionExists ? { id: 'thread-1-v1', status: 'idle' } : null) }
  const box = {
    get id() { return sandboxId },
    get filesystemIncarnationId() { return incarnation },
    filesystemIncarnationReadiness: 'ready',
    createSession: vi.fn(async () => ({ session, info: { id: 'thread-1-v1', status: 'idle' } })),
    session: vi.fn(() => session),
  }
  const instance = {
    key: 'agent:agent-1', get generation() { return generation }, get sandboxId() { return sandboxId },
    profileVersion: 'v1', box, sessionId: () => 'thread-1-v1',
  }
  const client = {
    instances: {
      ensure: vi.fn(async () => instance),
      get: vi.fn(async () => ({ key: instance.key, generation, sandboxId, profileVersion: 'v1' })),
    },
    get: vi.fn(async () => box),
  }
  const authorize = vi.fn(async () => { if (!authorized) throw new Error('denied') })
  const enrollment = createAgentEnrollment({
    authorize,
    client: () => client as never,
    store: {
      get: async () => retained,
      claimIfAbsent: async (claim) => { claimed ??= claim; return claimed },
      insertIfAbsent: async (target) => { retained ??= target; return retained },
    },
  })
  const request = { ...identity, instance: { key: 'agent:agent-1', profile: { version: 'v1', backend: { type: 'opencode' as const } }, create: {} as never } }
  return { enrollment, request, client, box, session, authorize,
    replace: () => { generation++; sandboxId = 'sandbox-2' },
    bumpGeneration: () => { generation++ },
    rotateFilesystem: () => { incarnation = 'incarnation-2' },
    revoke: () => { authorized = false },
    revokeDuringEnsure: () => { client.instances.ensure.mockImplementationOnce(async () => { authorized = false; return instance }) },
    dropSession: () => { sessionExists = false },
    stored: () => retained,
  }
}

describe('createAgentEnrollment', () => {
  it('stores the actual SDK target once and resolves the same session without provisioning', async () => {
    const f = fixture()
    const target = await f.enrollment.enroll('owner', f.request)
    expect(target).toMatchObject({ ...identity, instanceKey: 'agent:agent-1', generation: 1, profileVersion: 'v1', sandboxId: 'sandbox-1', filesystemIncarnationId: 'incarnation-1', sessionId: 'thread-1-v1' })
    expect(f.box.createSession).toHaveBeenCalledWith({ sessionId: 'thread-1-v1', retention: 'workspace', backend: f.request.instance.profile.backend })
    const resolved = await f.enrollment.resolve('owner', identity.enrollmentId)
    expect(resolved.target).toEqual(target)
    expect(resolved.session).toBe(f.session)
    expect(f.client.instances.ensure).toHaveBeenCalledTimes(1)
    await f.enrollment.enroll('owner', f.request)
    expect(f.client.instances.ensure).toHaveBeenCalledTimes(1)
  })

  it('rejects a different generation, filesystem, or missing session without replacing the box', async () => {
    const f = fixture()
    await f.enrollment.enroll('owner', f.request)
    f.bumpGeneration()
    await expect(f.enrollment.resolve('owner', identity.enrollmentId)).rejects.toThrow(EnrollmentTargetError)
    expect(f.client.instances.ensure).toHaveBeenCalledTimes(1)
    const replacement = fixture()
    await replacement.enrollment.enroll('owner', replacement.request)
    replacement.replace()
    await expect(replacement.enrollment.resolve('owner', identity.enrollmentId)).rejects.toThrow(EnrollmentTargetError)
    const g = fixture()
    await g.enrollment.enroll('owner', g.request)
    g.rotateFilesystem()
    await expect(g.enrollment.resolve('owner', identity.enrollmentId)).rejects.toThrow(EnrollmentTargetError)
    const h = fixture()
    await h.enrollment.enroll('owner', h.request)
    h.dropSession()
    await expect(h.enrollment.resolve('owner', identity.enrollmentId)).rejects.toThrow(EnrollmentTargetError)
  })

  it('rechecks authorization on both entrypoints and rejects conflicting enrollment input', async () => {
    const f = fixture()
    await f.enrollment.enroll('owner', f.request)
    await expect(f.enrollment.enroll('owner', { ...f.request, agentId: 'other-agent' })).rejects.toThrow(EnrollmentTargetError)
    f.revoke()
    await expect(f.enrollment.resolve('owner', identity.enrollmentId)).rejects.toThrow('denied')
    await expect(f.enrollment.enroll('owner', f.request)).rejects.toThrow('denied')
  })

  it('does not create a session or write a target if authority is revoked during ensure', async () => {
    const f = fixture()
    f.revokeDuringEnsure()
    await expect(f.enrollment.enroll('owner', f.request)).rejects.toThrow('denied')
    expect(f.box.createSession).not.toHaveBeenCalled()
    expect(f.stored()).toBeNull()
  })

  it('does not call ensure when authority is revoked while obtaining the SDK client', async () => {
    const f = fixture()
    let authorized = true
    const enrollment = createAgentEnrollment({
      authorize: async () => { if (!authorized) throw new Error('denied') },
      client: async () => { authorized = false; return f.client as never },
      store: { get: async () => null, claimIfAbsent: async claim => claim,
        insertIfAbsent: async target => target },
    })
    await expect(enrollment.enroll('owner', f.request)).rejects.toThrow('denied')
    expect(f.client.instances.ensure).not.toHaveBeenCalled()
  })

  it('does not call ensure when authority is revoked while reading the target store', async () => {
    const f = fixture()
    let authorized = true
    const enrollment = createAgentEnrollment({
      authorize: async () => { if (!authorized) throw new Error('denied') },
      client: () => f.client as never,
      store: {
        claimIfAbsent: async claim => claim,
        get: async () => { authorized = false; return null },
        insertIfAbsent: async target => target,
      },
    })
    await expect(enrollment.enroll('owner', f.request)).rejects.toThrow('denied')
    expect(f.client.instances.ensure).not.toHaveBeenCalled()
  })

  it('does not let a losing profile request mutate the winning instance', async () => {
    const f = fixture()
    let stored: AgentEnrollmentTarget | null = null
    let claimed: AgentEnrollmentClaim | null = null
    let liveProfileVersion = 'v1'
    const ensure = vi.fn(async (options: typeof f.request.instance) => {
      liveProfileVersion = options.profile.version
      return { key: options.key, generation: 1, sandboxId: 'sandbox-1',
        profileVersion: options.profile.version, box: f.box,
        sessionId: () => 'thread-1-v1' } as never
    })
    const client = { ...f.client, instances: { ...f.client.instances, ensure } }
    const enrollment = createAgentEnrollment({
      authorize: async () => {}, client: () => client as never,
      store: {
        get: async () => stored,
        claimIfAbsent: async claim => { claimed ??= claim; return claimed },
        insertIfAbsent: async target => { stored ??= target; return stored },
      },
    })
    const results = await Promise.allSettled([
      enrollment.enroll('owner', f.request),
      enrollment.enroll('owner', { ...f.request, instance: { ...f.request.instance,
        profile: { ...f.request.instance.profile, version: 'v2' } } }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(liveProfileVersion).toBe('v1')
  })

  it('retains the first target when concurrent callers race for one enrollment id', async () => {
    const f = fixture()
    let stored: AgentEnrollmentTarget | null = null
    let claimed: AgentEnrollmentClaim | null = null
    const enrollment = createAgentEnrollment({
      authorize: async () => {}, client: () => f.client as never,
      store: {
        get: async () => stored,
        claimIfAbsent: async claim => { claimed ??= claim; return claimed },
        insertIfAbsent: async target => { stored ??= target; return stored },
      },
    })
    const results = await Promise.allSettled([
      enrollment.enroll('owner', f.request),
      enrollment.enroll('owner', { ...f.request, agentId: 'other-agent' }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(stored).toMatchObject({ agentId: results[0].status === 'fulfilled' ? f.request.agentId : 'other-agent' })
  })

  it('denies a result when authority is revoked while SDK session status is read', async () => {
    const f = fixture()
    await f.enrollment.enroll('owner', f.request)
    f.session.status.mockImplementationOnce(async () => {
      f.revoke()
      return { id: 'thread-1-v1', status: 'idle' }
    })
    await expect(f.enrollment.resolve('owner', identity.enrollmentId)).rejects.toThrow('denied')
  })
})
