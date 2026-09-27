// Real provider invocation through the installed App package. No mocked transport.
// Run only against a disposable account with an operator-approved action.
import { readFile, writeFile } from 'node:fs/promises'
import { invokeIntegrationHub } from '@tangle-network/agent-app/integrations'
import { integrationToolName } from '@tangle-network/agent-integrations/catalog'

function need(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

if (need('PROOF_ACK_DISPOSABLE_ACCOUNT') !== 'yes') throw new Error('A disposable account must be acknowledged')
const base = new URL(need('PROOF_HUB_URL'))
if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
  throw new Error('PROOF_HUB_URL must be an HTTPS origin')
}
const key = need('PROOF_HUB_API_KEY')
const userId = need('PROOF_USER_ID')
const expected = Number(need('PROOF_EXPECT_STATUS'))
if (![200, 409, 502].includes(expected)) throw new Error('PROOF_EXPECT_STATUS must be 200, 409, or 502')
const args = JSON.parse(await readFile(need('PROOF_INPUT_FILE'), 'utf8'))
if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('The action input must be a JSON object')
const toolName = integrationToolName(need('PROOF_PROVIDER'), need('PROOF_CONNECTOR'), need('PROOF_ACTION'))
const calls = []
const fetchImpl = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.origin !== base.origin) throw new Error('Unexpected Hub transport origin')
  const response = await fetch(input, {
    ...init,
    redirect: 'error',
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  })
  // Never persist input bodies, credentials, tokens, or provider response bodies.
  calls.push({ method: init?.method ?? 'GET', path: url.pathname, status: response.status,
    requestId: response.headers.get('x-request-id') })
  return response
}

let receipt
try {
  const outcome = await invokeIntegrationHub({ userId, toolName, args }, {
    baseUrl: base.origin,
    apiKeyResolver: async requestedUserId => requestedUserId === userId ? key : null,
    fetchImpl,
  })
  const approved = calls.some(call => /\/approvals\/[^/]+\/approve$/.test(call.path))
  const ok = outcome.status === expected && calls.length > 0 && !approved
    && (expected !== 200 || outcome.body.success === true)
    && (expected !== 409 || outcome.body.code === 'HUB_APPROVAL_REQUIRED')
    && (expected !== 502 || outcome.body.code === 'HUB_POLICY_DENIED')
  receipt = { ok, expectedStatus: expected, status: outcome.status,
    success: outcome.body.success === true, code: outcome.body.code ?? null,
    approvalPresent: Boolean(outcome.body.approval), approvalRequestSent: approved,
    resultType: outcome.body.result === null ? 'null' : typeof outcome.body.result, calls }
} catch {
  // Raw errors can contain provider data. Inspect them only in the operator's restricted logs.
  receipt = { ok: false, error: 'Invocation failed before a valid outcome was returned', calls }
}
await writeFile(need('PROOF_OUTPUT'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify(receipt))
if (!receipt.ok) process.exitCode = 1
