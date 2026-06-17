import { useState } from 'react'
import { ChatMessages, ModelPicker, EffortPicker } from '@tangle-network/agent-app/web-react'
import { makeModels, makeMessages } from '../fixtures'

/**
 * The chat shell: ChatMessages (user msg, assistant msg with reasoning + tool
 * cards including a proposal-awaiting-approval and an errored tool call), plus a
 * top-level stream error row with Retry, and the ModelPicker / EffortPicker
 * popovers over a small fixture catalog.
 */
export function ChatRoute() {
  const models = makeModels()
  const messages = makeMessages()
  const [modelId, setModelId] = useState(models[0]!.id)
  const [effort, setEffort] = useState('medium')
  const selected = models.find((m) => m.id === modelId)

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex-1 overflow-y-auto py-6">
        <ChatMessages
          messages={messages}
          models={models}
          approval={{
            onApprove: async () => {},
            onReject: async () => {},
          }}
          error="The model stream dropped before the turn finished (transport closed)."
          onRetry={() => {}}
        />
      </div>
      <div className="border-t border-border bg-card/40 px-6 py-3">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <ModelPicker value={modelId} onChange={setModelId} models={models} />
          {selected?.supportsReasoning && <EffortPicker value={effort} onChange={setEffort} />}
          <div className="flex-1" />
          <input
            type="text"
            placeholder="Message the agent…"
            className="flex-1 rounded-full border border-border bg-background px-4 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>
    </div>
  )
}
