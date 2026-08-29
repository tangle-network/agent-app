import { describe, expect, it } from 'vitest'
import {
  formatSandboxProvisioningUserMessage,
  formatSandboxProvisioningSupportDetails,
  isSandboxApiBearerAuthFailure,
  isSandboxApiSandboxMissingFailure,
  isSandboxBoxConfigFailure,
  isSandboxAuthFailure,
  isSandboxHostCapacityFailure,
  serializeSandboxProvisioningError,
} from './diagnostics'

describe('sandbox provisioning error diagnostics', () => {
  it.each(['PAYLOAD_TOO_LARGE', 'FILE_TOO_LARGE'])(
    'surfaces sandbox attachment size failures for %s',
    (code) => {
      const diagnostics = serializeSandboxProvisioningError(new Error('hydration failed', {
        cause: Object.assign(new Error('upload failed'), { code, status: 413 }),
      }))

      expect(formatSandboxProvisioningUserMessage(diagnostics))
        .toBe('An attachment is too large for the sandbox to accept. Use a smaller file and try again.')
    },
  )

  it('names the Vault copy — not the sandbox service — when hydration did not finish', () => {
    const diagnostics = serializeSandboxProvisioningError(
      Object.assign(new Error('Vault hydration is incomplete (100 heads processed)'), {
        name: 'VaultHydrationIncompleteError',
        code: 'vault.hydration_incomplete',
      }),
    )

    expect(formatSandboxProvisioningUserMessage(diagnostics))
      .toBe('I couldn\'t finish copying your Vault into the sandbox, so I stopped rather than work from a partial copy. The copy resumes where it left off — try again in a moment.')
  })

  it('surfaces a bare 413 as an attachment size failure', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('hydration failed', {
      cause: Object.assign(new Error('upload failed'), { status: 413 }),
    }))

    expect(formatSandboxProvisioningUserMessage(diagnostics))
      .toBe('An attachment is too large for the sandbox to accept. Use a smaller file and try again.')
  })

  it('surfaces staged-data contention separately and retains retry timing', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('hydration failed', {
      cause: Object.assign(new Error('staging budget exhausted'), { code: 'UPLOAD_BUDGET_EXHAUSTED', status: 429, retryAfterMs: 2500 }),
    }))

    expect(formatSandboxProvisioningUserMessage(diagnostics))
      .toBe('Too much attachment data is staged in the sandbox at once. Retry shortly.')
    expect(formatSandboxProvisioningSupportDetails(diagnostics)).toContain('retryAfterMs=2500')
  })

  it('does not blame attachments for a rate-limit 429 without the budget code', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('provisioning failed', {
      cause: Object.assign(new Error('too many requests'), { status: 429 }),
    }))

    expect(formatSandboxProvisioningUserMessage(diagnostics))
      .toBe('I\'m unable to connect to the sandbox right now. This usually means the sandbox service is not configured or is temporarily unavailable.')
  })

  it('serializes a bounded safe cause chain from nested provisioning errors', () => {
    const execCause = Object.assign(new Error('exec write timed out'), {
      name: 'SandboxExecError',
      code: 'EXEC_TIMEOUT',
      status: 504,
      endpoint: '/api/boxes/gtm-b785fa67d411b19e/exec',
      origin: 'sidecar',
      retryAfterMs: 1500,
      sidecarVersion: '0.39.0',
      containerImage: 'ghcr.io/tangle-network/agent:sha-123',
      bearerToken: 'secret-token',
      apiKey: 'secret-key',
    })
    const writerCause = new Error('deferred file write failed on new box gtm-b785fa67d411b19e', {
      cause: execCause,
    })
    writerCause.name = 'DeferredProfileWriteError'
    const topLevel = new Error('Sandbox provisioning failed', { cause: writerCause })

    const diagnostics = serializeSandboxProvisioningError(topLevel)

    expect(diagnostics).toEqual({
      message: 'Sandbox provisioning failed',
      causes: [
        { name: 'Error', message: 'Sandbox provisioning failed' },
        {
          name: 'DeferredProfileWriteError',
          message: 'deferred file write failed on new box gtm-b785fa67d411b19e',
        },
        {
          name: 'SandboxExecError',
          message: 'exec write timed out',
          code: 'EXEC_TIMEOUT',
          status: 504,
          endpoint: '/api/boxes/gtm-b785fa67d411b19e/exec',
          origin: 'sidecar',
          retryAfterMs: 1500,
          sidecarVersion: '0.39.0',
          containerImage: 'ghcr.io/tangle-network/agent:sha-123',
        },
      ],
      truncated: false,
      cycle: false,
    })
    expect(JSON.stringify(diagnostics)).not.toContain('secret-token')
    expect(JSON.stringify(diagnostics)).not.toContain('secret-key')
  })

  it('formats concise support details from actionable nested cause fields', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('new box failed', {
      cause: Object.assign(new Error('exec write timed out'), {
        name: 'SandboxExecError',
        code: 'EXEC_TIMEOUT',
        status: 504,
        endpoint: '/exec',
      }),
    }))

    expect(formatSandboxProvisioningSupportDetails(diagnostics))
      .toBe('Support details: SandboxExecError; code=EXEC_TIMEOUT; status=504; endpoint=/exec; exec write timed out')
  })

  it('classifies reused sandbox AUTH_ERROR diagnostics for a distinct user message without leaking credentials', () => {
    const authCause = Object.assign(new Error('Missing or invalid authentication Authorization: Bearer secret-runtime-token'), {
      name: 'AuthError',
      code: 'AUTH_ERROR',
      status: 401,
      endpoint: '/v1/sandboxes/sandbox-9e916f2e5431/runtime/terminals/commands?token=secret-query-token',
      origin: 'sandbox-api',
      authToken: 'secret-field-token',
    })
    const writerCause = new Error('deferred file write failed on reused box gtm-b785fa67d411b19e', {
      cause: authCause,
    })
    writerCause.name = 'DeferredProfileWriteError'
    const diagnostics = serializeSandboxProvisioningError(new Error('Sandbox provisioning failed', { cause: writerCause }))

    expect(isSandboxAuthFailure(diagnostics)).toBe(true)
    expect(isSandboxApiBearerAuthFailure(diagnostics)).toBe(false)
    expect(formatSandboxProvisioningUserMessage(diagnostics))
      .toContain('runtime authentication failed')
    expect(formatSandboxProvisioningUserMessage(diagnostics))
      .toContain('reused with stale credentials')
    expect(formatSandboxProvisioningSupportDetails(diagnostics))
      .toBe('Support details: AuthError; code=AUTH_ERROR; status=401; endpoint=/v1/sandboxes/sandbox-9e916f2e5431/runtime/terminals/commands?token=[REDACTED]; origin=sandbox-api; Missing or invalid authentication Authorization: [REDACTED]')

    const rendered = JSON.stringify({ diagnostics, supportDetails: formatSandboxProvisioningSupportDetails(diagnostics) })
    expect(rendered).not.toContain('secret-runtime-token')
    expect(rendered).not.toContain('secret-query-token')
    expect(rendered).not.toContain('secret-field-token')
  })

  it('classifies sandbox API bearer 401 separately from runtime auth failures', () => {
    const authCause = Object.assign(new Error('Missing or invalid authentication'), {
      name: 'AuthError',
      code: 'AUTH_ERROR',
      status: 401,
      endpoint: '/v1/sandboxes/sandbox-7d846d0cd24e',
      origin: 'sandbox-api',
    })
    const diagnostics = serializeSandboxProvisioningError(new Error('Sandbox provisioning failed', {
      cause: new Error('writeProfileFilesToBox: file-API batch write failed', { cause: authCause }),
    }))

    expect(isSandboxAuthFailure(diagnostics)).toBe(true)
    expect(isSandboxApiBearerAuthFailure(diagnostics)).toBe(true)
    expect(formatSandboxProvisioningUserMessage(diagnostics))
      .toContain('sandbox API credential was rejected')
    expect(formatSandboxProvisioningUserMessage(diagnostics))
      .not.toContain('runtime authentication failed')
  })

  it('preserves typed egress recovery code and phase in safe diagnostics', () => {
    const diagnostics = serializeSandboxProvisioningError(Object.assign(new Error('Egress proxy recovery required'), {
      name: 'EgressProxyRecoveryError',
      code: 'EGRESS_PROXY_RECOVERY_REQUIRED',
      status: 409,
      phase: 'egress_proxy_recovery',
    }))

    expect(diagnostics.causes[0]).toMatchObject({
      code: 'EGRESS_PROXY_RECOVERY_REQUIRED',
      status: 409,
      phase: 'egress_proxy_recovery',
    })
    expect(formatSandboxProvisioningSupportDetails(diagnostics))
      .toContain('phase=egress_proxy_recovery')
    expect(formatSandboxProvisioningUserMessage(diagnostics))
      .toContain('Sandbox recovery is required')
  })

  it('classifies sandbox API non-runtime subresource 401s as bearer failures', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('Sandbox provisioning failed', {
      cause: Object.assign(new Error('Missing or invalid authentication'), {
        name: 'AuthError',
        code: 'AUTH_ERROR',
        status: 401,
        endpoint: '/v1/sandboxes/sandbox-7d846d0cd24e/files/write',
        origin: 'sandbox-api',
      }),
    }))

    expect(isSandboxApiBearerAuthFailure(diagnostics)).toBe(true)
  })

  it('classifies absolute sandbox API URLs as bearer failures', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('Sandbox provisioning failed', {
      cause: Object.assign(new Error('Missing or invalid authentication'), {
        name: 'AuthError',
        code: 'AUTH_ERROR',
        status: 401,
        endpoint: 'https://sandbox.tangle.tools/v1/sandboxes/sandbox-7d846d0cd24e/files/write?token=secret-query-token',
        origin: 'sandbox-api',
      }),
    }))

    expect(isSandboxApiBearerAuthFailure(diagnostics)).toBe(true)
  })

  it('does not classify absolute runtime URLs as sandbox API bearer failures', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('Sandbox provisioning failed', {
      cause: Object.assign(new Error('Missing or invalid authentication'), {
        name: 'AuthError',
        code: 'AUTH_ERROR',
        status: 401,
        endpoint: 'https://sandbox.tangle.tools/v1/sandboxes/sandbox-7d846d0cd24e/runtime/files/write',
        origin: 'sandbox-api',
      }),
    }))

    expect(isSandboxApiBearerAuthFailure(diagnostics)).toBe(false)
  })

  it('keeps generic provisioning failures on the generic unavailable user message', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('provisioner blew up'))

    expect(isSandboxAuthFailure(diagnostics)).toBe(false)
    expect(formatSandboxProvisioningUserMessage(diagnostics))
      .toContain('connect to the sandbox right now')
    expect(formatSandboxProvisioningUserMessage(diagnostics))
      .not.toContain('runtime authentication failed')
  })

  it('redacts secret-like values from nested messages, names, and support details', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('request failed', {
      cause: Object.assign(
        new Error('request to https://sidecar/api/exec?token=sk-live-xyz&workspace=ok failed with Authorization: Bearer abc.def.ghi api_key=plain-secret'),
        {
          name: 'SandboxExecError token=sk-name-secret',
          code: 'EXEC_FAILED',
          endpoint: 'https://sidecar/api/exec?api_key=secret-key&box=gtm-1',
        },
      ),
    }))

    expect(JSON.stringify(diagnostics)).not.toContain('sk-live-xyz')
    expect(JSON.stringify(diagnostics)).not.toContain('abc.def.ghi')
    expect(JSON.stringify(diagnostics)).not.toContain('plain-secret')
    expect(JSON.stringify(diagnostics)).not.toContain('secret-key')
    expect(diagnostics.causes[1]).toMatchObject({
      name: 'SandboxExecError token=[REDACTED]',
      endpoint: 'https://sidecar/api/exec?api_key=[REDACTED]&box=gtm-1',
    })
    expect(diagnostics.causes[1]?.message).toContain('token=[REDACTED]')
    expect(diagnostics.causes[1]?.message).toContain('Authorization: [REDACTED]')
    expect(diagnostics.causes[1]?.message).toContain('api_key=[REDACTED]')

    const supportDetails = formatSandboxProvisioningSupportDetails(diagnostics)
    expect(supportDetails).toContain('token=[REDACTED]')
    expect(supportDetails).toContain('api_key=[REDACTED]')
    expect(supportDetails).not.toContain('sk-live-xyz')
    expect(supportDetails).not.toContain('plain-secret')
    expect(supportDetails).not.toContain('secret-key')
  })

  it('redacts authorization assignments and JSON-like token fields without Bearer scheme', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('request failed', {
      cause: Object.assign(
        new Error('authorization: abc123def456 authorization=def456abc789 Authorization: ghi789abc123 "token":"json-secret" "authorization":"auth-json-secret" TWITTER_AUTH_TOKEN=twitter-secret'),
        {
          name: 'SandboxExecError',
          code: 'AUTH_FAILED',
          endpoint: '/exec?authorization=query-secret&workspace=ok',
        },
      ),
    }))

    const serialized = JSON.stringify(diagnostics)
    expect(serialized).not.toContain('abc123def456')
    expect(serialized).not.toContain('def456abc789')
    expect(serialized).not.toContain('ghi789abc123')
    expect(serialized).not.toContain('json-secret')
    expect(serialized).not.toContain('auth-json-secret')
    expect(serialized).not.toContain('twitter-secret')
    expect(serialized).not.toContain('query-secret')
    expect(diagnostics.causes[1]?.message).toContain('authorization: [REDACTED]')
    expect(diagnostics.causes[1]?.message).toContain('authorization=[REDACTED]')
    expect(diagnostics.causes[1]?.message).toContain('Authorization: [REDACTED]')
    expect(diagnostics.causes[1]?.message).toContain('"token":"[REDACTED]"')
    expect(diagnostics.causes[1]?.message).toContain('authorization: [REDACTED]')
    expect(diagnostics.causes[1]?.message).toContain('TWITTER_AUTH_TOKEN=[REDACTED]')
    expect(diagnostics.causes[1]?.endpoint).toBe('/exec?authorization=[REDACTED]&workspace=ok')

    const supportDetails = formatSandboxProvisioningSupportDetails(diagnostics)
    expect(supportDetails).toContain('authorization=[REDACTED]')
    expect(supportDetails).not.toContain('abc123def456')
    expect(supportDetails).not.toContain('auth-json-secret')
    expect(supportDetails).not.toContain('twitter-secret')
    expect(supportDetails).not.toContain('query-secret')
  })

  it('redacts full authorization values with scheme-prefixed credentials', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('request failed', {
      cause: Object.assign(
        new Error('Authorization: Basic dXNlcjpwYXNz; authorization=Digest username="agent", response="abc123"; AUTHORIZATION: Negotiate YII-secret; authorization: Unknown scheme-value; "authorization":"Basic json-secret=="'),
        {
          name: 'SandboxExecError',
          code: 'AUTH_FAILED',
          endpoint: '/exec?authorization=query-secret&workspace=ok',
        },
      ),
    }))

    const serialized = JSON.stringify(diagnostics)
    expect(serialized).not.toContain('dXNlcjpwYXNz')
    expect(serialized).not.toContain('abc123')
    expect(serialized).not.toContain('YII-secret')
    expect(serialized).not.toContain('scheme-value')
    expect(serialized).not.toContain('json-secret')
    expect(serialized).not.toContain('query-secret')
    expect(diagnostics.causes[1]?.message).toContain('Authorization: [REDACTED]')
    expect(diagnostics.causes[1]?.message).toContain('authorization=[REDACTED]')
    expect(diagnostics.causes[1]?.message).toContain('AUTHORIZATION: [REDACTED]')
    expect(diagnostics.causes[1]?.message).toContain('authorization: [REDACTED]')

    const supportDetails = formatSandboxProvisioningSupportDetails(diagnostics)
    expect(supportDetails).toContain('authorization=[REDACTED]')
    expect(supportDetails).not.toContain('dXNlcjpwYXNz')
    expect(supportDetails).not.toContain('query-secret')
  })

  it('redacts authorization credentials without dropping trailing prose', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('request failed', {
      cause: Object.assign(
        new Error('request failed with Authorization: Basic dXNlcjpwYXNz and status 401'),
        { name: 'SandboxExecError', code: 'AUTH_FAILED', status: 401 },
      ),
    }))

    expect(JSON.stringify(diagnostics)).not.toContain('dXNlcjpwYXNz')
    expect(diagnostics.causes[1]?.message).toContain('Authorization: [REDACTED] and status 401')
    expect(formatSandboxProvisioningSupportDetails(diagnostics)).toContain('and status 401')
  })

  it('redacts unknown authorization scheme credentials while preserving clear trailing prose', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('request failed', {
      cause: Object.assign(
        new Error('request failed with Authorization: MyScheme abc123 and status 401'),
        { name: 'SandboxExecError', code: 'AUTH_FAILED', status: 401 },
      ),
    }))

    const serialized = JSON.stringify(diagnostics)
    expect(serialized).not.toContain('abc123')
    expect(diagnostics.causes[1]?.message).toContain('Authorization: [REDACTED] and status 401')
    expect(formatSandboxProvisioningSupportDetails(diagnostics)).not.toContain('abc123')
    expect(formatSandboxProvisioningSupportDetails(diagnostics)).toContain('and status 401')
  })

  it('redacts custom authorization schemes with token-safe scheme characters', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('request failed', {
      cause: Object.assign(
        new Error('authorization: AWS4-HMAC-SHA256 aws-secret and status 401; authorization: OAuth2 token123 failed; authorization: Key1 secret456 failed; authorization: My_Scheme under-secret failed'),
        { name: 'SandboxExecError', code: 'AUTH_FAILED', status: 401 },
      ),
    }))

    const serialized = JSON.stringify(diagnostics)
    expect(serialized).not.toContain('aws-secret')
    expect(serialized).not.toContain('token123')
    expect(serialized).not.toContain('secret456')
    expect(serialized).not.toContain('under-secret')
    expect(formatSandboxProvisioningSupportDetails(diagnostics)).not.toContain('token123')
  })

  it('redacts ambiguous semicolon-separated unknown authorization values conservatively', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('request failed', {
      cause: Object.assign(
        new Error('Authorization: MyScheme value1; value2; param=ok'),
        { name: 'SandboxExecError', code: 'AUTH_FAILED' },
      ),
    }))

    const serialized = JSON.stringify(diagnostics)
    expect(serialized).not.toContain('value1')
    expect(serialized).not.toContain('value2')
    expect(diagnostics.causes[1]?.message).toContain('Authorization: [REDACTED]')
    expect(formatSandboxProvisioningSupportDetails(diagnostics)).not.toContain('value2')
  })

  it('redacts comma and semicolon chunks in unquoted secret field values', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('request failed', {
      cause: Object.assign(
        new Error('authorization: abc;def key: abc,def token=abc;def password: abc,def secret: abc;def credential=abc,def'),
        { name: 'SandboxExecError', code: 'AUTH_FAILED' },
      ),
    }))

    const serialized = JSON.stringify(diagnostics)
    expect(serialized).not.toContain('abc;def')
    expect(serialized).not.toContain('abc,def')
    expect(diagnostics.causes[1]?.message).toContain('authorization: [REDACTED]')
    expect(diagnostics.causes[1]?.message).toContain('key: [REDACTED]')
    expect(diagnostics.causes[1]?.message).toContain('token=[REDACTED]')
    expect(diagnostics.causes[1]?.message).toContain('password: [REDACTED]')
    expect(diagnostics.causes[1]?.message).toContain('secret: [REDACTED]')
    expect(diagnostics.causes[1]?.message).toContain('credential=[REDACTED]')
  })

  it('redacts delimiter-space chunks in unquoted secret field values', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('request failed', {
      cause: Object.assign(
        new Error('key: abc; def token=ghi, jkl password: mno; pqr'),
        { name: 'SandboxExecError', code: 'AUTH_FAILED' },
      ),
    }))

    const serialized = JSON.stringify(diagnostics)
    expect(serialized).not.toContain('abc')
    expect(serialized).not.toContain('def')
    expect(serialized).not.toContain('ghi')
    expect(serialized).not.toContain('jkl')
    expect(serialized).not.toContain('mno')
    expect(serialized).not.toContain('pqr')
    expect(diagnostics.causes[1]?.message).toContain('key: [REDACTED]')
    expect(diagnostics.causes[1]?.message).toContain('token=[REDACTED]')
    expect(diagnostics.causes[1]?.message).toContain('password: [REDACTED]')
  })

  it('redacts folded authorization continuation lines', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('request failed', {
      cause: new Error('Authorization: Negotiate first-line\n second-line\nstatus 401'),
    }))

    expect(JSON.stringify(diagnostics)).not.toContain('first-line')
    expect(JSON.stringify(diagnostics)).not.toContain('second-line')
    expect(diagnostics.causes[1]?.message).toContain('Authorization: [REDACTED]\nstatus 401')
  })

  it('redacts bare key values in JSON-like, colon, env, and support details', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('Platform sandbox key provision failed (400): {"data":{"key":"REALKEY-abc-123"}}', {
      cause: Object.assign(new Error('key: REALKEY-def-456 KEY=topsecret123 credential: raw-credential token-count: 4 tokens: 4 tokenCount: 4 keyboard: qwerty monkey: x'), {
        name: 'SandboxKeyProvisionError',
        code: 'KEY_PROVISION_FAILED',
        endpoint: '/v1/keys/provision?key=query-real-key&workspace=ok',
      }),
    }))

    const serialized = JSON.stringify(diagnostics)
    expect(serialized).not.toContain('REALKEY-abc-123')
    expect(serialized).not.toContain('REALKEY-def-456')
    expect(serialized).not.toContain('topsecret123')
    expect(serialized).not.toContain('raw-credential')
    expect(serialized).not.toContain('query-real-key')
    expect(diagnostics.message).toContain('"key":"[REDACTED]"')
    expect(diagnostics.causes[1]?.message).toContain('key: [REDACTED]')
    expect(diagnostics.causes[1]?.message).toContain('KEY=[REDACTED]')
    expect(diagnostics.causes[1]?.message).toContain('credential: [REDACTED]')
    expect(diagnostics.causes[1]?.message).toContain('token-count: 4')
    expect(diagnostics.causes[1]?.message).toContain('tokens: 4')
    expect(diagnostics.causes[1]?.message).toContain('tokenCount: 4')
    expect(diagnostics.causes[1]?.message).toContain('keyboard: qwerty')
    expect(diagnostics.causes[1]?.message).toContain('monkey: x')
    expect(diagnostics.causes[1]?.endpoint).toBe('/v1/keys/provision?key=[REDACTED]&workspace=ok')

    const supportDetails = formatSandboxProvisioningSupportDetails(diagnostics)
    expect(supportDetails).toContain('key=[REDACTED]')
    expect(supportDetails).not.toContain('query-real-key')
    expect(supportDetails).not.toContain('REALKEY-def-456')
  })

  it('marks truncated cause chains explicitly', () => {
    const third = new Error('third')
    const second = new Error('second', { cause: third })
    const first = new Error('first', { cause: second })

    const diagnostics = serializeSandboxProvisioningError(first, { maxDepth: 2 })

    expect(diagnostics.truncated).toBe(true)
    expect(diagnostics.truncatedAtDepth).toBe(2)
    expect(diagnostics.causes).toEqual([
      { name: 'Error', message: 'first' },
      { name: 'Error', message: 'second' },
      { name: 'CauseChainTruncated', message: 'cause chain truncated after 2 entries' },
    ])
  })

  it('marks cause chain cycles explicitly', () => {
    const first = new Error('first')
    const second = new Error('second')
    Object.defineProperty(first, 'cause', { value: second })
    Object.defineProperty(second, 'cause', { value: first })

    const diagnostics = serializeSandboxProvisioningError(first)

    expect(diagnostics.cycle).toBe(true)
    expect(diagnostics.truncated).toBe(false)
    expect(diagnostics.causes).toEqual([
      { name: 'Error', message: 'first' },
      { name: 'Error', message: 'second' },
      { name: 'CauseChainCycle', message: 'cause chain cycle detected after 2 entries' },
    ])
  })

  it('marks cause chain cycles that return to a seen object at max depth', () => {
    const first = new Error('first')
    const second = new Error('second')
    const third = new Error('third')
    Object.defineProperty(first, 'cause', { value: second })
    Object.defineProperty(second, 'cause', { value: third })
    Object.defineProperty(third, 'cause', { value: first })

    const diagnostics = serializeSandboxProvisioningError(first, { maxDepth: 3 })

    expect(diagnostics.cycle).toBe(true)
    expect(diagnostics.truncated).toBe(false)
    expect(diagnostics.truncatedAtDepth).toBeUndefined()
    expect(diagnostics.causes).toEqual([
      { name: 'Error', message: 'first' },
      { name: 'Error', message: 'second' },
      { name: 'Error', message: 'third' },
      { name: 'CauseChainCycle', message: 'cause chain cycle detected after 3 entries' },
    ])
  })

  it('preserves primitive causes as sanitized message entries', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('top', {
      cause: 'token=secret-value failed',
    }))

    expect(diagnostics).toEqual({
      message: 'top',
      causes: [
        { name: 'Error', message: 'top' },
        { message: 'token=[REDACTED] failed' },
      ],
      truncated: false,
      cycle: false,
    })
  })

  it('reports absent nested details explicitly', () => {
    const diagnostics = serializeSandboxProvisioningError({})

    expect(diagnostics).toEqual({ message: 'Sandbox unavailable', causes: [], truncated: false, cycle: false })
    expect(formatSandboxProvisioningSupportDetails(diagnostics))
      .toBe('Support details: no nested sandbox cause details were available.')
  })
})

/**
 * Verbatim shape the sandbox API returned for a resume onto a host whose slot
 * budget was exhausted. Captured live rather than written from the docs,
 * because the signal is the message text — the API returns a generic
 * `SERVER_ERROR` for it.
 */
function hostExhaustedResumeError(): Error {
  const container = 'e5ea31d6e370acf5e37bf8464755813f033d0fe7eb903420061002fa3ae8756c'
  const serverError = Object.assign(
    new Error(
      `Failed to resume project: Failed to start container ${container}: `
      + `Host capacity reservation failed before resume: container ${container} `
      + 'host has no available slot',
    ),
    {
      name: 'ServerError',
      code: 'SERVER_ERROR',
      status: 500,
      endpoint: '/v1/sandboxes/sandbox-01626d7a7d6b/resume',
      origin: 'sandbox-api',
    },
  )
  return Object.assign(
    new Error(
      'reused sandbox gtm:workspace:b63f531c8d5dbf5b70db2485c5ac9778:e2 failed liveness '
      + 'recovery at resume: the box did not reach running after a state-preserving restart.',
      { cause: serverError },
    ),
    { name: 'SandboxRecoveryFailedError', phase: 'resume' },
  )
}

describe('sandbox host capacity failures', () => {
  it('recognises a resume that failed because the host has no free slot', () => {
    const diagnostics = serializeSandboxProvisioningError(hostExhaustedResumeError())
    expect(isSandboxHostCapacityFailure(diagnostics)).toBe(true)
  })

  it('is distinct from a missing sandbox, so each records its own cause', () => {
    const diagnostics = serializeSandboxProvisioningError(hostExhaustedResumeError())
    expect(isSandboxApiSandboxMissingFailure(diagnostics)).toBe(false)
  })

  it('does not fire on unrelated sandbox-api server errors', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('resume failed', {
      cause: Object.assign(new Error('Failed to resume project: fetch failed'), {
        code: 'SERVER_ERROR',
        status: 500,
        endpoint: '/v1/sandboxes/sandbox-01626d7a7d6b/resume',
        origin: 'sandbox-api',
      }),
    }))
    expect(isSandboxHostCapacityFailure(diagnostics)).toBe(false)
  })

  it('does not fire on capacity wording from anywhere but the sandbox API', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('vault sync failed', {
      cause: Object.assign(new Error('host has no available slot'), {
        status: 500,
        origin: 'vault',
      }),
    }))
    expect(isSandboxHostCapacityFailure(diagnostics)).toBe(false)
  })
})

describe('sandbox missing failures', () => {
  const missingContainerMessage =
    'Failed to resume project: Failed to start container 0c44dc7e5f62: '
    + 'Host-agent startContainer failed (404): {"error":"Container not found","code":"NOT_FOUND"}'

  it('recognises a resume whose backing container is missing', () => {
    const diagnostics = serializeSandboxProvisioningError(Object.assign(new Error(missingContainerMessage), {
      name: 'ServerError',
      code: 'SERVER_ERROR',
      status: 500,
      endpoint: '/v1/sandboxes/sandbox-stale/resume',
      origin: 'sandbox-api',
    }))

    expect(isSandboxApiSandboxMissingFailure(diagnostics)).toBe(true)
  })

  it('does not trust the same message outside a sandbox API resume', () => {
    const diagnostics = serializeSandboxProvisioningError(Object.assign(new Error(missingContainerMessage), {
      status: 500,
      endpoint: '/v1/sandboxes/sandbox-stale/resume',
      origin: 'vault',
    }))

    expect(isSandboxApiSandboxMissingFailure(diagnostics)).toBe(false)
  })

  it('does not trust the nested 404 on another sandbox API endpoint', () => {
    const diagnostics = serializeSandboxProvisioningError(Object.assign(new Error(missingContainerMessage), {
      status: 500,
      endpoint: '/v1/sandboxes/sandbox-stale/egress',
      origin: 'sandbox-api',
    }))

    expect(isSandboxApiSandboxMissingFailure(diagnostics)).toBe(false)
  })

  it('does not treat a runtime-sidecar 404 as a missing sandbox', () => {
    const diagnostics = serializeSandboxProvisioningError(Object.assign(new Error('file not found'), {
      status: 404,
      endpoint: '/v1/sandboxes/sandbox-live/runtime/files/read',
      origin: 'sandbox-api',
    }))

    expect(isSandboxApiSandboxMissingFailure(diagnostics)).toBe(false)
  })

  it('does not treat a generic resume 500 as a missing sandbox', () => {
    const diagnostics = serializeSandboxProvisioningError(Object.assign(new Error('Failed to resume project'), {
      status: 500,
      endpoint: '/v1/sandboxes/sandbox-stale/resume',
      origin: 'sandbox-api',
    }))

    expect(isSandboxApiSandboxMissingFailure(diagnostics)).toBe(false)
  })
})

/**
 * The other shape the platform throws when a box cannot be brought up: the
 * resume succeeds, the sidecar never answers, the state-preserving restart does
 * not help. Captured live from Drew's workspace after host slots were freed.
 */
function unresponsiveProbeError(): Error {
  return Object.assign(
    new Error(
      'resumed sandbox gtm:workspace:b63f531c8d5dbf5b70db2485c5ac9778:e2 failed liveness '
      + 'recovery at probe: the box is still unresponsive after a state-preserving restart. '
      + 'The workspace is preserved; pass forceNew to replace the box.',
    ),
    { name: 'SandboxRecoveryFailedError', phase: 'probe' },
  )
}

describe('unbringable sandbox detection', () => {
  it.each([
    ['a resume onto a full host', hostExhaustedResumeError],
    ['a box that never answers its probe', unresponsiveProbeError],
  ])('treats %s as a box to replace', (_label, build) => {
    const diagnostics = serializeSandboxProvisioningError(build())
    const unrecoverable = diagnostics.causes.some((cause) =>
      cause.name === 'SandboxRecoveryFailedError'
      || (typeof cause.message === 'string' && cause.message.includes('pass forceNew to replace the box')))
    expect(unrecoverable).toBe(true)
  })

  it('leaves an ordinary provisioning error alone', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('vault hydration failed', {
      cause: Object.assign(new Error('upload failed'), { code: 'PAYLOAD_TOO_LARGE', status: 413 }),
    }))
    const unrecoverable = diagnostics.causes.some((cause) =>
      cause.name === 'SandboxRecoveryFailedError'
      || (typeof cause.message === 'string' && cause.message.includes('pass forceNew to replace the box')))
    expect(unrecoverable).toBe(false)
  })

  it('names the sandbox the platform could not start, for the recovery record', () => {
    const diagnostics = serializeSandboxProvisioningError(hostExhaustedResumeError())
    const id = diagnostics.causes
      .map((cause) => typeof cause.endpoint === 'string' ? /\/v1\/sandboxes\/([^/?#]+)/.exec(cause.endpoint)?.[1] : undefined)
      .find(Boolean)
    expect(id).toBe('sandbox-01626d7a7d6b')
  })
})

/**
 * The third way a box dies permanently, captured live from gtm production after
 * the first two were fixed. The platform cannot rebuild the box's proxy because
 * the egress policy it was created with is no longer recorded — and policy is
 * applied at creation, so no retry against that box can ever succeed.
 */
function egressPolicyMissingResumeError(): Error {
  return Object.assign(
    new Error(
      'Failed to resume project: Model-key refresh for sandbox-784ae3a20d71 has no recorded '
      + 'egress policy — cannot rebuild the proxy config; re-apply the sandbox egress policy and retry',
    ),
    {
      name: 'ServerError',
      code: 'SERVER_ERROR',
      status: 500,
      endpoint: '/v1/sandboxes/sandbox-784ae3a20d71/resume',
      origin: 'sandbox-api',
    },
  )
}

describe('sandbox box-config failures', () => {
  it('recognises a resume that failed because the box has no recorded egress policy', () => {
    const diagnostics = serializeSandboxProvisioningError(egressPolicyMissingResumeError())
    expect(isSandboxBoxConfigFailure(diagnostics)).toBe(true)
  })

  it('is distinct from a host-capacity failure, so each stays legible', () => {
    const diagnostics = serializeSandboxProvisioningError(egressPolicyMissingResumeError())
    expect(isSandboxHostCapacityFailure(diagnostics)).toBe(false)
  })

  // A bare 500 from the sandbox API is transient far more often than not.
  // Treating one as unbringable deletes a healthy box, so the match is narrow.
  it('does not fire on an ordinary sandbox-api 500', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('resume failed', {
      cause: Object.assign(new Error('Failed to resume project: fetch failed'), {
        code: 'SERVER_ERROR',
        status: 500,
        endpoint: '/v1/sandboxes/sandbox-1/resume',
        origin: 'sandbox-api',
      }),
    }))
    expect(isSandboxBoxConfigFailure(diagnostics)).toBe(false)
  })

  it('does not fire on the same wording from anywhere but the sandbox API', () => {
    const diagnostics = serializeSandboxProvisioningError(new Error('vault sync failed', {
      cause: Object.assign(new Error('has no recorded egress policy'), {
        status: 500,
        origin: 'vault',
      }),
    }))
    expect(isSandboxBoxConfigFailure(diagnostics)).toBe(false)
  })
})
