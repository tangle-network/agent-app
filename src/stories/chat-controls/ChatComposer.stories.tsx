import type { Meta, StoryObj } from '@storybook/react'
import { useState, type ReactNode } from 'react'

import { ChatComposer, ModelPicker, type MentionItem } from '../../web-react'
import {
  catalogModels,
  DEFAULT_MODEL_ID,
  pendingComposerFiles,
  pendingComposerFilesWithError,
  pendingComposerImageFiles,
  withPopoverHeadroom,
} from './fixtures'

/**
 * Mirrors the playground's ComposerRoute state wiring: the model pill sits on
 * the composer's own action row (`controlsPlacement: 'inline'`, the default),
 * with the `above` opt-out as the fifth state. Each state story is interactive
 * (type, attach chips, Stop), so hover/focus polish is judgeable live.
 *
 * Every story docks a `ModelPicker`, whose popover opens UPWARD — so the whole
 * file wraps in `withPopoverHeadroom` (anchors the composer at the bottom of
 * a 520px block) and clicking the pill can never clip into unscrollable
 * negative-Y space, whatever the canvas height.
 */

function useModelPill() {
  const [model, setModel] = useState(DEFAULT_MODEL_ID)
  return <ModelPicker value={model} onChange={setModel} models={catalogModels} />
}

function Demo({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {title}
      </h3>
      <div className="rounded-2xl border border-card-edge bg-card p-4">{children}</div>
    </section>
  )
}

const meta: Meta<typeof ChatComposer> = {
  title: 'ChatControls/ChatComposer',
  component: ChatComposer,
  decorators: [
    withPopoverHeadroom,
    (Story) => (
      <div className="w-[576px] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof ChatComposer>

/** Default — model pill on the action row, empty input, Send disabled. */
export const Empty: Story = {
  render: () => (
    <ChatComposer
      onSend={(message) => console.log('send', message)}
      placeholder="Message the agent…"
      controls={useModelPill()}
    />
  ),
}

/** Typed — Send enabled. */
export const Typed: Story = {
  render: () => (
    <ChatComposer
      onSend={(message) => console.log('send', message)}
      placeholder="Message the agent…"
      controls={useModelPill()}
      initialValue="Create a workflow that reviews opened PRs with a cheap but good model and posts the review as a comment."
    />
  ),
}

/** Streaming — Send becomes Stop; the textarea stays editable for the next turn. */
export const Streaming: Story = {
  render: () => (
    <ChatComposer
      onSend={(message) => console.log('send', message)}
      onCancel={() => console.log('cancel')}
      isStreaming
      placeholder="Message the agent…"
      controls={useModelPill()}
    />
  ),
}

/** Attachments — attach + attach-folder buttons, drag-drop, pending chips. */
export const WithAttachments: Story = {
  name: 'With attachments',
  render: () => (
    <ChatComposer
      onSend={(message) => console.log('send', message)}
      placeholder="Ask the agent to inspect files…"
      controls={useModelPill()}
      onAttach={(files) => console.log('attach', files.length)}
      onAttachFolder={(files) => console.log('attach folder', files.length)}
      onRemoveFile={(id) => console.log('remove', id)}
      pendingFiles={pendingComposerFiles}
    />
  ),
}

/** Attachment chip in the error tone, alongside ready + uploading. The chip
 *  names the reason and offers Retry, so a failed upload is recoverable
 *  without re-picking the file. */
export const WithAttachmentError: Story = {
  name: 'With attachment error',
  render: () => (
    <ChatComposer
      onSend={(message) => console.log('send', message)}
      placeholder="Ask the agent to inspect files…"
      controls={useModelPill()}
      onAttach={(files) => console.log('attach', files.length)}
      onRemoveFile={(id) => console.log('remove', id)}
      onRetryFile={(id) => console.log('retry', id)}
      pendingFiles={pendingComposerFilesWithError}
    />
  ),
}

/** Image thumbnails + a context row — the full staging surface. Paste a
 *  screenshot into the input to watch a `pasted-image-<n>.png` file arrive. */
export const WithImageAttachments: Story = {
  name: 'With image attachments',
  render: () => (
    <ChatComposer
      onSend={(message) => console.log('send', message)}
      placeholder="Paste a screenshot…"
      controls={useModelPill()}
      contextItems={[
        { id: 'c1', label: 'src/web-react/chat-composer.tsx' },
        { id: 'c2', label: 'Design review thread', onRemove: () => console.log('remove context') },
      ]}
      onAttach={(files) => console.log('attach', files.length)}
      onRejectFiles={(rejections) => console.log('rejected', rejections.map((r) => r.reason))}
      onRemoveFile={(id) => console.log('remove', id)}
      accept="image/*"
      canSubmitAttachmentsOnly
      pendingFiles={pendingComposerImageFiles}
      trailing={<span className="text-xs text-muted-foreground">4.2k</span>}
    />
  ),
}

const MENTION_FILES: MentionItem[] = [
  { id: 'src/web-react/chat-composer.tsx', label: 'chat-composer.tsx', detail: 'src/web-react/chat-composer.tsx', kind: 'file' },
  { id: 'src/web-react/mention-editor.tsx', label: 'mention-editor.tsx', detail: 'src/web-react/mention-editor.tsx', kind: 'file' },
  { id: 'docs/api/web-react.md', label: 'web-react.md', detail: 'docs/api/web-react.md', kind: 'file' },
  { id: 'README.md', label: 'README.md', detail: 'README.md', kind: 'file' },
]

/** Mention mode — type `@` to open the file popover (the TipTap editor loads
 *  lazily on this story's first render). Picking a row inserts an atomic pill
 *  that serializes to `@<path>`; the suggestion panel portals through
 *  PopoverSurface, so no host box can clip it. */
export const WithMentions: Story = {
  name: 'With mentions',
  render: () => (
    <ChatComposer
      onSend={(message) => console.log('send', message)}
      placeholder="Type @ to mention a workspace file…"
      controls={useModelPill()}
      mention={{
        fetchItems: async (query) => {
          const q = query.toLowerCase()
          return MENTION_FILES.filter(
            (file) => file.label.toLowerCase().includes(q) || file.id.toLowerCase().includes(q),
          )
        },
        onMentionsChange: (mentions) => console.log('mentions', mentions.map((m) => m.id)),
      }}
    />
  ),
}

/** Above placement — the pill floats outside the card; no focus hint. */
export const AbovePlacement: Story = {
  name: 'Above placement',
  render: () => (
    <ChatComposer
      onSend={(message) => console.log('send', message)}
      placeholder="Message the agent…"
      controls={useModelPill()}
      controlsPlacement="above"
      focusShortcut={false}
    />
  ),
}

/** Disabled — input + send blocked (e.g. while restoring a session). */
export const Disabled: Story = {
  render: () => (
    <ChatComposer
      onSend={(message) => console.log('send', message)}
      placeholder="Restoring the session…"
      controls={useModelPill()}
      initialValue="This draft is preserved but not editable yet."
      disabled
    />
  ),
}

/** Floating — the opt-in two-layer soft shadow; radius, ring, and controls
 *  layout are unchanged (elevation only). Compare against Default. */
export const Floating: Story = {
  render: () => (
    <ChatComposer
      onSend={(message) => console.log('send', message)}
      placeholder="Message the agent…"
      controls={useModelPill()}
      floating
    />
  ),
}

/** Flat vs floating side by side — the elevation-only diff, judged against
 *  both themes via the toolbar. */
export const FlatVsFloating: Story = {
  name: 'Flat vs floating',
  decorators: [
    (Story) => (
      <div className="w-[640px] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
  render: () => {
    const pill = useModelPill()
    return (
      <div className="space-y-7">
        <Demo title="current: flat">
          <ChatComposer onSend={() => {}} placeholder="Message the agent…" controls={pill} />
        </Demo>
        <Demo title="new: floating">
          <ChatComposer onSend={() => {}} placeholder="Message the agent…" controls={pill} floating />
        </Demo>
      </div>
    )
  },
}

/** The canon send shape: 34px circular inverted arrow (stop: circular outlined
 *  square), the grammar the legacy sandbox-ui AgentComposer shipped. */
export const IconSend: Story = {
  name: 'Icon send (canon)',
  render: () => (
    <ChatComposer
      onSend={(message) => console.log('send', message)}
      placeholder="Message the agent…"
      controls={useModelPill()}
      sendVariant="icon"
      floating
    />
  ),
}

/** Pill vs both icon tones — the canon shape and the opt-in brand surface. */
export const PillVsIconSend: Story = {
  name: 'Pill vs icon send tones',
  decorators: [
    (Story) => (
      <div className="w-[640px] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
  render: () => {
    const pill = useModelPill()
    return (
      <div className="space-y-7">
        <Demo title="pill send (current default)">
          <ChatComposer onSend={() => {}} placeholder="Message the agent…" controls={pill} />
        </Demo>
        <Demo title="icon send — contrast (default)">
          <ChatComposer onSend={() => {}} placeholder="Message the agent…" controls={pill} sendVariant="icon" />
        </Demo>
        <Demo title="icon send — primary">
          <ChatComposer onSend={() => {}} placeholder="Message the agent…" controls={pill} sendVariant="icon" sendTone="primary" />
        </Demo>
        <Demo title="icon send — primary, typed + floating">
          <ChatComposer onSend={() => {}} initialValue="Ship the weekly report every Monday." controls={pill} sendVariant="icon" sendTone="primary" floating />
        </Demo>
      </div>
    )
  },
}

/** Every ComposerRoute state side by side — the spacing/polish audit. */
export const AllStates: Story = {
  name: 'All states',
  decorators: [
    (Story) => (
      <div className="w-[640px] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
  render: () => {
    const pill = useModelPill()
    return (
      <div className="space-y-7">
        <Demo title="Default — model pill on the action row, empty">
          <ChatComposer onSend={() => {}} placeholder="Message the agent…" controls={pill} />
        </Demo>
        <Demo title="Typed — Send enabled">
          <ChatComposer
            onSend={() => {}}
            placeholder="Message the agent…"
            controls={pill}
            initialValue="Create a workflow that reviews opened PRs with a cheap but good model and posts the review as a comment."
          />
        </Demo>
        <Demo title="Streaming — Send becomes Stop">
          <ChatComposer onSend={() => {}} onCancel={() => {}} isStreaming placeholder="Message the agent…" controls={pill} />
        </Demo>
        <Demo title="Attachments — attach button, drag-drop, pending chips">
          <ChatComposer
            onSend={() => {}}
            placeholder="Ask the agent to inspect files…"
            controls={pill}
            onAttach={() => {}}
            onAttachFolder={() => {}}
            onRemoveFile={() => {}}
            pendingFiles={pendingComposerFiles}
          />
        </Demo>
        <Demo title="Attachment error tone">
          <ChatComposer
            onSend={() => {}}
            placeholder="Ask the agent to inspect files…"
            controls={pill}
            onAttach={() => {}}
            onRemoveFile={() => {}}
            pendingFiles={pendingComposerFilesWithError}
          />
        </Demo>
        <Demo title="Above placement — pill outside the card (no focus hint)">
          <ChatComposer
            onSend={() => {}}
            placeholder="Message the agent…"
            controls={pill}
            controlsPlacement="above"
            focusShortcut={false}
          />
        </Demo>
        <Demo title="Disabled — restoring">
          <ChatComposer onSend={() => {}} placeholder="Restoring the session…" controls={pill} disabled />
        </Demo>
      </div>
    )
  },
}
