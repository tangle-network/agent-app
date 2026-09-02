import type { SandboxInstance } from '@tangle-network/sandbox'

type SandboxSession = ReturnType<SandboxInstance['session']>
type CreateSessionRequest = Parameters<SandboxInstance['createSession']>[0]
type CreatedSession = Awaited<ReturnType<SandboxInstance['createSession']>>
type SendMessageRequest = Parameters<SandboxSession['sendMessage']>[0]
type SendMessageOptions = NonNullable<Parameters<SandboxSession['sendMessage']>[1]>
type SentSessionMessage = Awaited<ReturnType<SandboxSession['sendMessage']>>

/** Backend configuration fixed when the Sandbox session is created. */
export type SandboxSessionTurnBackend = CreateSessionRequest['backend']

/** Message fields forwarded to the Sandbox session lane. */
export type SandboxSessionTurnMessage = Omit<SendMessageRequest, 'turnId'>

/** Request controls forwarded to the Sandbox session lane. */
export type SandboxSessionTurnSendOptions = SendMessageOptions

/** Options for admitting one browser-visible turn on the Sandbox message lane. */
export interface AdmitSandboxSessionTurnOptions {
  /** Authorized Sandbox instance for the product workspace. */
  box: Pick<SandboxInstance, 'createSession'>
  /** Stable session identity shared by the browser and the Workflow. */
  sessionId: string
  /** Stable idempotency identity for this logical user turn. */
  turnId: string
  /** Backend profile bound to the session at creation. */
  backend: SandboxSessionTurnBackend
  /** User message sent through the gateway-visible message lane. */
  message: SandboxSessionTurnMessage
  title?: string
  sendOptions?: SandboxSessionTurnSendOptions
}

/** Plain result safe to return from a durable admission step. */
export interface SandboxSessionTurnAdmission {
  sessionId: string
  turnId: string
  receipt: SentSessionMessage
}

function stableId(value: string, field: 'sessionId' | 'turnId'): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`Sandbox session turn requires a non-empty ${field}`)
  return normalized
}

/**
 * Create or reuse one Sandbox session, then admit one stable turn.
 *
 * The Sandbox API owns idempotency for repeated `turnId` values. This helper
 * does not keep process-local state, so retries remain safe across Workers.
 */
export async function admitSandboxSessionTurn(
  options: AdmitSandboxSessionTurnOptions,
): Promise<SandboxSessionTurnAdmission> {
  const sessionId = stableId(options.sessionId, 'sessionId')
  const turnId = stableId(options.turnId, 'turnId')
  if (options.message.parts.length === 0) {
    throw new Error('Sandbox session turn requires at least one message part')
  }

  const created = await options.box.createSession({
    sessionId,
    backend: options.backend,
    ...(options.title !== undefined ? { title: options.title } : {}),
  })
  if (!isExpectedSession(created, sessionId)) {
    throw new Error(`Sandbox returned a different session for ${sessionId}`)
  }

  const receipt = await created.session.sendMessage(
    { ...options.message, turnId },
    options.sendOptions,
  )
  return { sessionId, turnId, receipt }
}

function isExpectedSession(
  created: CreatedSession,
  sessionId: string,
): created is CreatedSession & { info: { id: string }; session: { id: string } } {
  return created.info.id === sessionId && created.session.id === sessionId
}
