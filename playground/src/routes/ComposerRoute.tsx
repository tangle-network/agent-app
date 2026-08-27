import { useState } from 'react'
import {
  ChatComposer,
  ModelPicker,
  type ComposerFile,
} from '@tangle-network/agent-app/web-react'
import { makeModels } from '../fixtures'

/**
 * Visual audit for ChatComposer: the shared message input across its states —
 * model pill above the box, empty vs typed, streaming (Stop), the attach +
 * pending-file surface, and the footer-placement variant. Token-only styling, so
 * this is also the proof it themes from the shared tokens (light + dark) without
 * any private --chat-* variables.
 */
function Demo({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {title}
      </h3>
      <div className="rounded-2xl border border-border bg-card/40 p-4">{children}</div>
    </section>
  )
}

export function ComposerRoute() {
  const models = makeModels()
  const [model, setModel] = useState(models[0]!.id)
  const pill = (
    <ModelPicker value={model} onChange={setModel} models={models} />
  )

  const pendingFiles: ComposerFile[] = [
    { id: 'f1', name: 'q3-metrics.csv', kind: 'file', status: 'ready' },
    { id: 'f2', name: 'design-assets', kind: 'folder', fileCount: 12, status: 'uploading' },
  ]

  return (
    <div className="h-full w-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-xl space-y-7 px-6 py-10">
        <Demo title="Default — model pill above, empty">
          <ChatComposer
            onSend={() => {}}
            placeholder="Message the assistant…"
            controls={pill}
          />
        </Demo>

        <Demo title="Typed — Send enabled">
          <ChatComposer
            onSend={() => {}}
            placeholder="Message the assistant…"
            controls={pill}
            initialValue="Create a workflow that reviews opened PRs with a cheap but good model and posts the review as a comment."
          />
        </Demo>

        <Demo title="Streaming — Send becomes Stop">
          <ChatComposer
            onSend={() => {}}
            onCancel={() => {}}
            isStreaming
            placeholder="Message the assistant…"
            controls={pill}
          />
        </Demo>

        <Demo title="Attachments — attach button, drag-drop, pending chips">
          <ChatComposer
            onSend={() => {}}
            placeholder="Ask the agent to inspect files…"
            controls={pill}
            onAttach={() => {}}
            onAttachFolder={() => {}}
            onRemoveFile={() => {}}
            pendingFiles={pendingFiles}
          />
        </Demo>

        <Demo title="Footer placement — model pill inline (no focus hint)">
          <ChatComposer
            onSend={() => {}}
            placeholder="Message the assistant…"
            controls={pill}
            controlsPlacement="footer"
            focusShortcut={false}
          />
        </Demo>
      </div>
    </div>
  )
}
