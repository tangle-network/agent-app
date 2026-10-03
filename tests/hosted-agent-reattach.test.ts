import { isDeepStrictEqual } from 'node:util'
import { LinesClient } from '@tangle-network/sandbox/core'
import { describe, expect, it, vi } from 'vitest'
import { createHostedAgent } from '../src/hosted-agent'

const OWNER = 'owner@example.com'
const MAILBOX = 'assistant@example.com'

function emailHub(legacy?: Record<string, unknown>) {
  let attachment: Record<string, unknown> | null = legacy
    ? { ...legacy, id: 'lat_mail', status: 'active', request: legacy }
    : null
  const requests: { path: string; method: string; body: Record<string, unknown> | undefined }[] = []
  const line = () => ({ id: 'ln_mail', transport: 'email', address: MAILBOX, status: 'active', attachment,
    clientReference: legacy ? 'hosted-agent' : null })
  const fetch = vi.fn(async (path: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET'
    const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : undefined
    requests.push({ path, method, body })
    if (path === '/v1/lines' && method === 'POST') {
      if (!legacy && body?.address !== MAILBOX) return Response.json({ message: 'Resend requires a mailbox address' }, { status: 400 })
      return Response.json({ success: true, data: { line: line() } })
    }
    if (path === '/v1/lines/ln_mail/attachment' && method === 'PUT') {
      // Current Hub rejects email guest/onboard admission before attachment equality.
      if (body?.unknownSenders !== 'reject')
        return Response.json({ message: 'Email lines require declared members' }, { status: 400 })
      if (attachment && !isDeepStrictEqual(body, attachment.request))
        return Response.json({ message: 'Line is attached; detach it before attaching it differently' }, { status: 409 })
      attachment = { ...body, id: 'lat_mail', status: 'active', request: body }
      return Response.json({ success: true, data: { attachment } })
    }
    if (path === '/v1/lines/ln_mail/members') {
      const declared = attachment?.members as { address: string; role: string; label?: string }[]
      return Response.json({ success: true, data: { members: [
        ...declared.map(member => ({ ...member, label: member.label ?? null, source: 'declared', status: 'active' })),
        { address: 'guest@example.com', role: 'guest', label: null, source: 'guest', status: 'active' },
      ] } })
    }
    if (path === '/v1/lines/ln_mail') return Response.json({ success: true, data: { line: line() } })
    throw new Error(`Unexpected local Hub request: ${method} ${path}`)
  })

  return { client: { lines: new LinesClient({ fetch }) }, requests, fetch }
}

describe('hosted email setup through the Sandbox SDK', () => {
  it('forwards the Resend mailbox and retains shared policy on a setup retry', async () => {
    const hub = emailHub()
    const config = { client: hub.client, owner: OWNER, profile: { name: 'Mail' } }
    const agent = createHostedAgent({ ...config, attachment: { clientReference: 'host-mail' }, freeTurnsPerDay: 30 })
    const first = await agent.attachLine('hubconn_resend', { transport: 'email', address: MAILBOX, mode: 'shared' })
    const repeated = await createHostedAgent(config).attachLine('hubconn_resend', { transport: 'email', address: MAILBOX })

    expect(repeated.id).toBe(first.id)
    expect(repeated.attachment?.id).toBe(first.attachment?.id)
    expect(hub.requests.filter(request => request.path === '/v1/lines').map(request => request.body)).toEqual([
      { connectionId: 'hubconn_resend', transport: 'email', address: MAILBOX },
      { connectionId: 'hubconn_resend', transport: 'email', address: MAILBOX },
    ])
    const attachments = hub.requests.filter(request => request.method === 'PUT').map(request => request.body)
    expect(attachments).toHaveLength(2)
    expect(attachments[1]).toEqual(attachments[0])
    expect(attachments[1]).toMatchObject({
      mode: 'shared', unknownSenders: 'reject', clientReference: 'host-mail',
      limits: { turnsPerMemberPerDay: 30 },
      members: [{ address: OWNER, role: 'owner' }],
      instance: { keyPrefix: 'hosted:ln_mail:', create: { resources: { cpuCores: 2, memoryMB: 2048, diskGB: 2 } } },
      respond: { backend: { profile: { model: { default: 'openai/gpt-5.6-luna' } } } },
    })
    expect(hub.requests.every(request => request.method !== 'DELETE')).toBe(true)
  })

  it('forwards the host-selected member instance namespace through the SDK', async () => {
    const hub = emailHub()
    const instance = { keyPrefix: 'product-mail:', create: { name: 'customer-home' } }
    const agent = createHostedAgent({ client: hub.client, owner: OWNER, profile: {}, attachment: { instance } })
    await agent.attachLine('hubconn_resend', { transport: 'email', address: MAILBOX })
    expect(hub.requests.find(request => request.method === 'PUT')?.body?.instance).toEqual(instance)
  })

  it.each(['guest', 'onboard'])('surfaces migration for legacy email %s admission before changing its attachment', async unknownSenders => {
    const backend = { profile: { name: 'Legacy Mail' } }
    const legacy = {
      mode: 'shared', unknownSenders, clientReference: 'hosted-agent',
      members: [{ address: OWNER, role: 'owner' }, { address: 'member@example.com', role: 'member', label: 'Member' }],
      roles: { owner: { context: 'own', tools: 'act' }, member: { context: 'own', tools: 'act' }, guest: { context: 'own', tools: 'act' } },
      respond: { kind: 'agent', backend },
      limits: { turnsPerMemberPerDay: 17, noticesPerSenderPerDay: 2, noticesPerLinePerDay: 50 },
      instance: { keyPrefix: 'hosted:', create: { name: 'retained-home', resources: { cpuCores: 2, memoryMB: 2048, diskGB: 2 } } },
    }
    const hub = emailHub(legacy)
    const agent = createHostedAgent({ client: hub.client, owner: OWNER, profile: {}, backend })
    await expect(agent.attachLine('hubconn_inkbox', { transport: 'email' }))
      .rejects.toMatchObject({ code: 'line_policy_migration_required' })
    await expect(agent.attachExistingLine('ln_mail'))
      .rejects.toMatchObject({ code: 'line_policy_migration_required' })
    expect(hub.requests[0]?.body).toEqual({ connectionId: 'hubconn_inkbox', transport: 'email' })
    expect(hub.requests.map(request => request.method)).toEqual(['POST', 'GET'])
    const retained = await hub.client.lines.get('ln_mail')
    expect(retained.attachment).toMatchObject({ ...legacy, id: 'lat_mail', status: 'active' })
  })

  it.each(['', 'not-a-mailbox', 'two@example.com other@example.com'])('rejects invalid mailbox %j before Hub setup', async address => {
    const hub = emailHub()
    const agent = createHostedAgent({ client: hub.client, owner: OWNER, profile: {} })
    await expect(agent.attachLine('hubconn_resend', { transport: 'email', address })).rejects.toMatchObject({ code: 'email_address_invalid' })
    expect(hub.fetch).not.toHaveBeenCalled()
  })

  it('rejects an email address on a different transport before Hub setup', async () => {
    const hub = emailHub()
    const agent = createHostedAgent({ client: hub.client, owner: OWNER, profile: {} })
    await expect(agent.attachLine('hubconn_inkbox', { address: MAILBOX })).rejects.toMatchObject({ code: 'email_address_not_allowed' })
    expect(hub.fetch).not.toHaveBeenCalled()
  })

  it('does not attach an existing line under a different requested mailbox', async () => {
    const hub = emailHub()
    const agent = createHostedAgent({ client: hub.client, owner: OWNER, profile: {} })
    await expect(agent.attachExistingLine('ln_mail', { transport: 'email', address: 'different@example.com' }))
      .rejects.toMatchObject({ code: 'line_address_mismatch' })
    expect(hub.requests.map(request => request.method)).toEqual(['GET'])
  })
})
