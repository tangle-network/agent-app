import { describe, it, expect } from 'vitest'
import { buildDelegationMcpServer, DELEGATION_MCP_SERVER_KEY, DELEGATION_TOOLS } from '../src/delegation/index'

describe('buildDelegationMcpServer', () => {
  it('returns undefined with no api key (fail-closed)', () => {
    expect(buildDelegationMcpServer({})).toBeUndefined()
    expect(buildDelegationMcpServer({ apiKey: '' })).toBeUndefined()
  })

  it('builds the stdio server, bakes the key, and forwards only defined trace env', () => {
    const s = buildDelegationMcpServer({
      apiKey: 'sk-tan-x',
      forwardEnv: { SANDBOX_BASE_URL: 'https://sb', TRACE_ID: 'tr1', OTEL_EXPORTER_OTLP_HEADERS: undefined },
    })
    expect(s).toBeDefined()
    expect(s!.transport).toBe('stdio')
    expect((s as { type?: string }).type).toBeUndefined() // transport shape, not the inlineProfile output shape
    expect(s!.command).toBe('npx')
    expect(s!.args).toEqual(['-y', '@tangle-network/agent-runtime', 'mcp'])
    expect(s!.env).toEqual({ TANGLE_API_KEY: 'sk-tan-x', SANDBOX_BASE_URL: 'https://sb', TRACE_ID: 'tr1' })
    expect(s!.env.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined()
    expect(s!.metadata.tools).toEqual(DELEGATION_TOOLS)
  })

  it('honors a custom package spec', () => {
    const s = buildDelegationMcpServer({ apiKey: 'k', packageSpec: '@tangle-network/agent-runtime@0.41.0' })
    expect(s!.args).toEqual(['-y', '@tangle-network/agent-runtime@0.41.0', 'mcp'])
  })

  it('exposes the stable server key', () => {
    expect(DELEGATION_MCP_SERVER_KEY).toBe('agent-runtime-delegation')
  })
})
