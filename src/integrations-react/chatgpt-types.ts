import type { AgentEnrollmentIdentity } from '../agent-enrollment/index.js'
import type { AgentIdentityConfig } from '../config/index.js'

/** Display facts from the host's existing, authorized ChatGPT registration record. */
export interface ChatGPTRegistration {
  /** A real registered connection ID, not a generated package ID or OAuth client ID. */
  connectionId: string
  /** The exact MCP resource associated with that registration. */
  endpoint: string
}

/**
 * Read-only host observation, not an OAuth or installation state machine.
 * Omit it when setup has not been checked. Never infer connected from a click,
 * package generation/import, a syntactically valid ID, or a window message.
 */
export type ChatGPTConnectionState =
  | { status: 'setup' }
  | { status: 'checking' }
  | { status: 'error' }
  | { status: 'registered'; registration: ChatGPTRegistration }
  | {
      status: 'connected'
      registration: ChatGPTRegistration
      /** The native identity confirmed by the host's existing authorized read path. */
      enrollment: AgentEnrollmentIdentity
    }

export interface ConnectToChatGPTProps {
  /** Pass the existing AgentAppConfig.identity; no second app metadata registry. */
  app: Pick<AgentIdentityConfig, 'name'>
  /** Display-only identity from the existing authenticated enrollment. */
  enrollment: AgentEnrollmentIdentity
  /** The same reviewed, public HTTPS resource used by createAgentsHandler. */
  endpoint: string
  /** Host-controlled. Loading/error must replace a previous connected observation. */
  connection?: ChatGPTConnectionState
  className?: string
}
