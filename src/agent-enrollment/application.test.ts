import { describe, expect, it, vi } from 'vitest'
import type { LineApplicationRequest } from '@tangle-network/sandbox/core'
import { createEnrolledApplicationLineHandler, type LiveSharedEnrollmentMember } from './application'

// Sandbox 0.59.0 drops subjectId. ADC's signed callback parser adds it before release.
vi.mock('@tangle-network/sandbox/core', async importOriginal => {
  const actual = await importOriginal<typeof import('@tangle-network/sandbox/core')>()
  return {
    ...actual,
    parseLineApplicationRequest: (value: unknown) => ({
      ...actual.parseLineApplicationRequest(value),
      subjectId: (value as { subjectId?: unknown }).subjectId,
    }),
  }
})

const binding = 'global-agent-app'
const subjectId = 'customer-subject'
const base: LineApplicationRequest = {
  version: 1, binding, messageId: 'msg_builder', lineId: 'ln_shared',
  attachmentId: 'lat_shared', memberId: 'mem_customer', lineThreadId: 'thread_customer',
  ownerUserId: 'owner_global', sender: { address: '+15550100001', role: 'owner' },
  transport: 'imessage', receivedAt: '2026-10-02T00:00:00Z', text: '@builder hello',
}

function callback(text: string, messageId: string) {
  const body = { ...base, subjectId, messageId, text }
  return new Request('https://app.example.com/shared-line', {
    method: 'POST', headers: { 'content-type': 'application/json',
      'idempotency-key': `line-application:${messageId}` },
    body: JSON.stringify(body),
  })
}

function member(appId: string): LiveSharedEnrollmentMember {
  return {
    binding, subjectId, appId, lineId: base.lineId, attachmentId: base.attachmentId,
    memberId: base.memberId, ownerUserId: base.ownerUserId, senderAddress: base.sender.address,
    grantRevision: 'revision-1',
    enrollmentId: `enrollment-${appId}`, agentId: `agent-${appId}`,
    workspaceId: `workspace-${appId}`, threadId: `thread-${appId}`,
  }
}

function fixture(allowed = new Set(['builder', 'other'])) {
  const admitted: string[] = []
  const resolved: string[] = []
  let grant = true
  const handler = createEnrolledApplicationLineHandler({
    authenticate: async () => ({ principal: 'owner', binding }),
    selectApp: async (_auth, input) => input.text.split(' ')[0]?.slice(1) ?? '',
    lookup: async (_principal, inputBinding, inputSubject, appId) => grant && allowed.has(appId)
      && inputBinding === binding && inputSubject === subjectId ? member(appId) : null,
    enrollment: { resolve: async (_principal, id) => {
      resolved.push(id)
      const appId = id.slice('enrollment-'.length)
      return { target: { ...member(appId), enrollmentId: id }, box: {}, session: {} } as never
    } },
    read: async (target) => admitted.includes(target.target.enrollmentId)
      ? { state: 'completed', executionId: 'exec_done', text: target.target.agentId }
      : { state: 'missing' },
    admit: async target => { admitted.push(target.target.enrollmentId) },
  })
  return { handler, admitted, resolved, revoke: () => { grant = false } }
}

describe('shared enrolled application line', () => {
  it('routes two allowed apps on one signed endpoint to distinct retained targets', async () => {
    const f = fixture()
    const builder = await f.handler(callback('@builder hello', 'msg_builder'))
    const other = await f.handler(callback('@other hello', 'msg_other'))
    expect(builder.status).toBe(200)
    expect(other.status).toBe(200)
    expect((await builder.json()).text).toBe('agent-builder')
    expect((await other.json()).text).toBe('agent-other')
    expect(f.admitted).toEqual(['enrollment-builder', 'enrollment-other'])
  })

  it('denies an ungranted app before target resolution or admission', async () => {
    const f = fixture()
    const response = await f.handler(callback('@foreign hello', 'msg_foreign'))
    expect(response.status).toBe(403)
    expect(f.resolved).toEqual([])
    expect(f.admitted).toEqual([])
  })

  it('denies after a live member grant disappears during target resolution', async () => {
    const f = fixture()
    const original = f.resolved.push.bind(f.resolved)
    f.resolved.push = (...ids) => { const count = original(...ids); f.revoke(); return count }
    const response = await f.handler(callback('@builder hello', 'msg_builder'))
    expect(response.status).toBe(403)
    expect(f.admitted).toEqual([])
  })

  it('does not return output read from the old target after a same-app member remap', async () => {
    let enrollmentId = 'enrollment-builder'
    let revision = 'revision-1'
    const handler = createEnrolledApplicationLineHandler({
      authenticate: async () => ({ principal: 'owner', binding }),
      selectApp: async () => 'builder',
      lookup: async () => ({ ...member('builder'), enrollmentId, grantRevision: revision }),
      enrollment: { resolve: async (_principal, id) => ({
        target: { ...member('builder'), enrollmentId: id }, box: {}, session: {},
      }) as never },
      read: async () => {
        enrollmentId = 'enrollment-replacement'
        revision = 'revision-2'
        return { state: 'completed', executionId: 'old-execution', text: 'old private output' }
      },
      admit: async () => { throw new Error('completed output must not be admitted') },
    })
    const response = await handler(callback('@builder hello', 'msg_remap'))
    expect(response.status).toBe(403)
  })

  it('does not return output after the pinned SDK target generation changes', async () => {
    let generation = 1
    const handler = createEnrolledApplicationLineHandler({
      authenticate: async () => ({ principal: 'owner', binding }),
      selectApp: async () => 'builder',
      lookup: async () => member('builder'),
      enrollment: { resolve: async () => ({
        target: { ...member('builder'), instanceKey: 'agent:builder', configurationDigest: 'digest',
          profileVersion: 'v1', generation, sandboxId: 'sandbox-1',
          filesystemIncarnationId: 'incarnation-1', sessionId: 'session-1' },
        box: {}, session: {},
      }) as never },
      read: async () => {
        generation = 2
        return { state: 'completed', executionId: 'old-execution', text: 'old private output' }
      },
      admit: async () => { throw new Error('completed output must not be admitted') },
    })
    const response = await handler(callback('@builder hello', 'msg_generation'))
    expect(response.status).toBe(403)
  })
})
