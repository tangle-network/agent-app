import { ConnectToChatGPT, type ConnectToChatGPTProps } from '@tangle-network/agent-app/integrations-react'
import type { AgentAppConfig } from '@tangle-network/agent-app/config'

/** Read-only data from each app's existing authenticated loader/configuration. */
export interface ExistingAppConnection {
  config: Pick<AgentAppConfig, 'identity'>
  enrollment: ConnectToChatGPTProps['enrollment']
  endpoint: string
  connection?: ConnectToChatGPTProps['connection']
}

/** Two independent apps consume the SAME installed component without adapters. */
export function Connections({ builder, gtm }: {
  builder: ExistingAppConnection
  gtm: ExistingAppConnection
}) {
  return <main className="mx-auto grid w-full min-w-0 max-w-5xl gap-6 p-4 lg:grid-cols-2">
    <ConnectToChatGPT
      app={builder.config.identity}
      enrollment={builder.enrollment}
      endpoint={builder.endpoint}
      connection={builder.connection}
    />
    <ConnectToChatGPT
      app={gtm.config.identity}
      enrollment={gtm.enrollment}
      endpoint={gtm.endpoint}
      connection={gtm.connection}
    />
  </main>
}
