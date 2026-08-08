import { useState } from 'react'
import {
  AgentSessionControls,
  ChatComposer,
  ModelPicker,
  type ComposerFile,
} from '@tangle-network/agent-app/web-react'
import type { Harness } from '@tangle-network/agent-app/harness'
import { makeModels } from '../fixtures'

/**
 * Visual audit for ChatComposer: the shared message input across its states —
 * model pill on the input's own action row, empty vs typed, streaming (Stop),
 * the attach + pending-file surface, and the opt-out `above` placement. Token-only styling, so
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

/**
 * The composer control rail a real host docks these controls into, reproduced
 * verbatim.
 *
 * The class string is copied from the shipped `@tangle-network/sandbox-ui`
 * bundle (its `ChatComposer` action row). `overflow-x-auto` makes the rail a
 * SCROLL CONTAINER, and a scroll container clips every positioned descendant
 * whose containing block sits inside it — which used to erase the picker
 * popovers entirely: correct DOM, correct `getBoundingClientRect()`, zero
 * pixels painted, no click able to land. The pickers must survive being
 * mounted here, so the popover hit-test audit drives exactly this markup.
 */
function HostScrollRail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div data-popover-audit={label} className="rounded-2xl border border-border bg-card p-3">
      <div className="flex items-end gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto overscroll-x-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>
        </div>
      </div>
    </div>
  )
}

export function ComposerRoute() {
  const models = makeModels()
  const [model, setModel] = useState(models[0]!.id)
  const [railModel, setRailModel] = useState(models[0]!.id)
  const [railHarness, setRailHarness] = useState<Harness>('claude-code')
  const [railEffort, setRailEffort] = useState('medium')
  const [compactModel, setCompactModel] = useState(models[0]!.id)
  const [compactHarness, setCompactHarness] = useState<Harness>('claude-code')
  const [compactEffort, setCompactEffort] = useState('medium')
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
        <Demo title="Default — model pill on the action row, empty">
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

        <Demo title="Above placement — model pill outside the card (no focus hint)">
          <ChatComposer
            onSend={() => {}}
            placeholder="Message the assistant…"
            controls={pill}
            controlsPlacement="above"
            focusShortcut={false}
          />
        </Demo>

        {/* The assistant dock is the narrowest consumer of this composer: a
            448px drawer, so the card renders at 424 and the controls slot at
            ~309 — narrower than the model popover itself. Open the picker here,
            not just in the roomy demos above: this is the width where a control
            and the popover it owns compete for the row. */}
        <Demo title="Dock width (448px drawer) — open the picker">
          <div className="w-[424px]">
            <ChatComposer
              onSend={() => {}}
              placeholder="Message the assistant…"
              controls={pill}
            />
          </div>
        </Demo>

        <Demo title="Host scroll rail (inline) — model, backend, thinking">
          <HostScrollRail label="rail-inline">
            <AgentSessionControls
              models={models}
              model={railModel}
              onModelChange={setRailModel}
              harness={railHarness}
              onHarnessChange={setRailHarness}
              effort={railEffort}
              onEffortChange={setRailEffort}
            />
          </HostScrollRail>
        </Demo>

        <Demo title="Host scroll rail (compact) — model + settings gear">
          <HostScrollRail label="rail-compact">
            <AgentSessionControls
              layout="compact"
              models={models}
              model={compactModel}
              onModelChange={setCompactModel}
              harness={compactHarness}
              onHarnessChange={setCompactHarness}
              effort={compactEffort}
              onEffortChange={setCompactEffort}
            />
          </HostScrollRail>
        </Demo>
      </div>
    </div>
  )
}
