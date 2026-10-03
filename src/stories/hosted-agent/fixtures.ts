import type { LineMember } from '@tangle-network/sandbox'
import type {
  LineBillingView, LineMembersClient, LineSetupClient, LineSetupLine, LineSetupSnapshot,
} from '../../hosted-agent/react'

export const workspaceName = 'Example workspace'

export const setupEmpty: LineSetupSnapshot = {
  workspaceName,
  lines: [],
  connections: [{
    id: 'conn_email',
    label: 'Owned mailbox',
    providerId: 'inkbox',
    identities: [{ kind: 'email', transport: 'email', label: 'agent@example.com' }],
  }],
  targets: [{ id: 'agent_guide', label: 'Guide', kind: 'agent', modes: ['per-member', 'shared'] }],
}

const connectedLine: LineSetupLine = {
  id: 'ln_email',
  connectionId: 'conn_email',
  transport: 'email',
  address: 'agent@example.com',
  connect: null,
  routerAddress: null,
  providerNumberId: null,
  status: 'active',
  answering: true,
  canDisconnect: true,
  targetId: 'agent_guide',
  targetLabel: 'Guide',
  boxMode: 'per-member',
  lastTurn: { kind: 'latest', at: '2026-09-28T04:00:00Z', status: 'answered' },
}

export const setupConnected: LineSetupSnapshot = {
  ...setupEmpty,
  lines: [connectedLine],
}

export const setupDisconnected: LineSetupSnapshot = {
  ...setupConnected,
  lines: [{
    ...connectedLine,
    answering: false,
    targetId: null,
    targetLabel: null,
    lastTurn: { kind: 'none' },
  }],
}

export const setupMultiNumberDisconnected: LineSetupSnapshot = {
  ...setupEmpty,
  connections: [{
    id: 'conn_whatsapp',
    label: 'Owned WhatsApp account',
    providerId: 'whatsapp',
    identities: [
      { kind: 'number', transport: 'whatsapp', label: '+1 303 555 0101', phoneNumberId: 'pn_owned_a' },
      { kind: 'number', transport: 'whatsapp', label: '+1 303 555 0102', phoneNumberId: 'pn_owned_b' },
    ],
  }],
  lines: [{
    ...connectedLine,
    id: 'ln_whatsapp',
    connectionId: 'conn_whatsapp',
    transport: 'whatsapp',
    address: '+13035550101',
    providerNumberId: 'pn_owned_a',
    answering: false,
    targetId: null,
    targetLabel: null,
    lastTurn: { kind: 'none' },
  }],
}

export const setupManualNumberReconnect: LineSetupSnapshot = {
  ...setupMultiNumberDisconnected,
  connections: [{
    id: 'conn_whatsapp',
    label: 'Owned WhatsApp account',
    providerId: 'whatsapp',
    identities: [{ kind: 'number', transport: 'whatsapp', label: 'Enter provider number ID', requiresPhoneNumberId: true }],
  }],
}

export function createSetupClient(initial: LineSetupSnapshot): LineSetupClient {
  let snapshot = structuredClone(initial)
  return {
    async load() { return structuredClone(snapshot) },
    async connect(input) {
      const target = snapshot.targets.find(item => item.id === input.targetId)
      const line = snapshot.lines.find(item => item.connectionId === input.connectionId && item.transport === input.transport)
      if (line) {
        line.targetId = input.targetId
        line.targetLabel = target?.label ?? null
        line.boxMode = input.boxMode
        line.answering = false
        return
      }
      snapshot.lines.push({
        id: 'ln_email',
        connectionId: input.connectionId,
        transport: input.transport,
        address: 'agent@example.com',
        connect: null,
        routerAddress: null,
        providerNumberId: input.phoneNumberId ?? null,
        status: 'active',
        answering: false,
        canDisconnect: true,
        targetId: input.targetId,
        targetLabel: target?.label ?? null,
        boxMode: input.boxMode,
        lastTurn: { kind: 'none' },
      })
    },
    async disconnect(lineId) {
      const line = snapshot.lines.find(item => item.id === lineId)
      if (!line) throw new Error('Line not found.')
      line.answering = false
      line.targetId = null
      line.targetLabel = null
    },
  }
}

/** Let a mutation succeed, fail its next read once, then allow Retry to recover. */
export function createSetupRefreshFailureClient(initial: LineSetupSnapshot): LineSetupClient {
  const client = createSetupClient(initial)
  let failNextLoad = false
  return {
    ...client,
    async load() {
      if (failNextLoad) {
        failNextLoad = false
        throw new Error('The updated line could not be loaded.')
      }
      return client.load()
    },
    async connect(input) { await client.connect(input); failNextLoad = true },
    async disconnect(lineId) { await client.disconnect(lineId); failNextLoad = true },
  }
}

export const memberRoles = [
  { value: 'owner', label: 'Owner', tools: 'act' },
  { value: 'manager', label: 'Manager', tools: 'act' },
  { value: 'member', label: 'Member', tools: 'act' },
  { value: 'chat-only', label: 'Guest', tools: 'chat' },
] as const

export const members: LineMember[] = [
  {
    id: 'mem_owner', lineId: 'ln_email', attachmentId: 'att_1',
    address: 'owner@example.com', role: 'owner', label: 'Owner', source: 'declared',
    status: 'active', createdAt: '2026-09-28T03:00:00Z', updatedAt: '2026-09-28T03:00:00Z',
  },
  {
    id: 'mem_invited', lineId: 'ln_email', attachmentId: 'att_1',
    address: 'teammate@example.com', role: 'member', label: 'Teammate', source: 'declared',
    status: 'invited', createdAt: '2026-09-28T03:30:00Z', updatedAt: '2026-09-28T03:30:00Z',
  },
  {
    id: 'mem_stopped', lineId: 'ln_email', attachmentId: 'att_1',
    address: 'paused@example.com', role: 'chat-only', label: 'Paused member', source: 'declared',
    status: 'stopped', createdAt: '2026-09-28T03:45:00Z', updatedAt: '2026-09-28T03:45:00Z',
  },
]

export function createMembersClient(initial: LineMember[]): LineMembersClient {
  let rows = structuredClone(initial)
  let nextId = 1
  return {
    async list() { return structuredClone(rows) },
    async add(lineId, input) {
      const now = new Date().toISOString()
      rows.push({
        id: `mem_added_${nextId++}`, lineId, attachmentId: 'att_1',
        address: input.address, role: input.role, label: input.label ?? null,
        source: 'declared', status: 'invited', createdAt: now, updatedAt: now,
      })
    },
    async update(_lineId, memberId, patch) {
      const row = rows.find(item => item.id === memberId)
      if (!row) throw new Error('Member not found.')
      if (patch.role !== undefined) row.role = patch.role
      if (patch.label !== undefined) row.label = patch.label
      row.updatedAt = new Date().toISOString()
    },
    async remove(_lineId, memberId) {
      const row = rows.find(item => item.id === memberId)
      if (!row) throw new Error('Member not found.')
      row.status = 'removed'
      row.updatedAt = new Date().toISOString()
    },
  }
}

/** Retain the successful write while the next member list read fails once. */
export function createMembersRefreshFailureClient(initial: LineMember[]): LineMembersClient {
  const client = createMembersClient(initial)
  let failNextList = false
  return {
    ...client,
    async list(lineId) {
      if (failNextList) {
        failNextList = false
        throw new Error('The updated member list could not be loaded.')
      }
      return client.list(lineId)
    },
    async add(lineId, input) { await client.add(lineId, input); failNextList = true },
    async update(lineId, memberId, patch) { await client.update(lineId, memberId, patch); failNextList = true },
    async remove(lineId, memberId) { await client.remove(lineId, memberId); failNextList = true },
  }
}

export const billingUnverified: LineBillingView = {
  workspaceName,
  lineAddress: 'agent@example.com',
  linePayer: { kind: 'unverified' },
  turnPayer: { kind: 'owner', label: 'Agent owner' },
  allowance: { turnsPerMemberPerDay: 100, used: 12, limit: 100, resetsAt: '2026-09-29T00:00:00Z' },
}

export const billingVerified: LineBillingView = {
  ...billingUnverified,
  linePayer: { kind: 'workspace', label: workspaceName },
  turnPayer: { kind: 'member', label: 'Each member' },
}
