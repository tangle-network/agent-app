import type { AgentEnrollmentIdentity } from '../agent-enrollment/index.js'
import type { ConnectToChatGPTProps } from './chatgpt-types.js'

// A directory destination, NOT an install URL. Never build a URL from an ID.
export const CHATGPT_PLUGINS_URL = 'https://chatgpt.com/plugins'
export const CHATGPT_SETUP_URL = 'https://developers.openai.com/plugins/deploy/connect-chatgpt'
export const CHATGPT_PACKAGE_URL = 'https://developers.openai.com/plugins/build/plugins'

const identityKeys = ['enrollmentId', 'agentId', 'workspaceId', 'threadId'] as const
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

function validIdentity(value: AgentEnrollmentIdentity | undefined): boolean {
  return !!value && identityKeys.every(key => nonempty(value[key]))
}

/** Only compare display identities. Authorization remains exclusively with the host. */
function sameIdentity(left: AgentEnrollmentIdentity, right: AgentEnrollmentIdentity): boolean {
  return validIdentity(right) && identityKeys.every(key => left[key] === right[key])
}

function publicEndpoint(value: string): string | null {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\s\\]/.test(value)) return null
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) return null
    return url.href
  } catch {
    return null
  }
}

export interface ChatGPTView {
  status: 'setup' | 'checking' | 'registered' | 'connected' | 'error' | 'unavailable'
  label: string
  description: string
  action: string | null
  endpoint: string | null
  connectionId?: string
}

/** Pure projection: no network, effects, credentials, persistence, or auto-success. */
export function chatGPTView(props: ConnectToChatGPTProps): ChatGPTView {
  const endpoint = publicEndpoint(props.endpoint)
  if (!endpoint || !nonempty(props.app?.name) || !validIdentity(props.enrollment)) {
    return {
      status: 'unavailable', label: 'Setup unavailable', action: null, endpoint: null,
      description: 'The app needs a saved agent and a credential-free HTTPS MCP endpoint. Ask the app owner to check its setup.',
    }
  }
  const setup: ChatGPTView = {
    status: 'setup', label: 'Ready to set up', action: 'Connect to ChatGPT', endpoint,
    description: 'Use this agent from ChatGPT with its existing workspace and conversation. Start with an existing connection when one is available.',
  }
  const failure: ChatGPTView = {
    status: 'error', label: 'Connection not confirmed', action: 'Review in ChatGPT', endpoint,
    description: 'Review the connection and sign-in in ChatGPT, then refresh this page. This panel does not change your agent or permissions.',
  }
  const state = props.connection
  if (!state || state.status === 'setup') return setup
  if (state.status === 'checking') return {
    status: 'checking', label: 'Checking connection…', action: null, endpoint,
    description: 'Waiting for this app to check the selected agent. Setup and permission changes stay in ChatGPT and the existing consent flow.',
  }
  if (state.status === 'error') return failure
  if (state.status !== 'registered' && state.status !== 'connected') return failure
  const registration = state.registration
  // IDs are only displayed. This check does not register, normalize, or verify one.
  if (!registration || !nonempty(registration.connectionId)
    || !/^(?:plugin_asdk_app_|asdk_app_|connector_|templated_apps_)[A-Za-z0-9][A-Za-z0-9_-]*$/.test(registration.connectionId)
    || publicEndpoint(registration.endpoint) !== endpoint) return failure
  if (state.status === 'connected' && !sameIdentity(props.enrollment, state.enrollment)) {
    return {
      ...failure,
      description: 'The saved connection check is for a different agent or conversation. Refresh this page to check the current selection; no replacement agent is created here.',
    }
  }
  return state.status === 'connected' ? {
    status: 'connected', label: 'Connected to this agent', action: 'Open ChatGPT', endpoint,
    connectionId: registration.connectionId,
    description: 'This app reports a confirmed connection for the selected agent and conversation. In a new ChatGPT conversation, select the connection from the tools menu.',
  } : {
    status: 'registered', label: 'Connection registered', action: 'Use existing connection', endpoint,
    connectionId: registration.connectionId,
    description: 'Reuse this registered connection in ChatGPT. Complete the existing sign-in and consent flow if asked. Registration alone does not confirm access to this agent.',
  }
}
