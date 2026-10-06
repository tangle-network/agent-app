import type { Meta, StoryObj } from '@storybook/react'
import { useMemo, useState } from 'react'
import { WorkspaceFilesPane } from '@tangle-network/sandbox-ui/workspace'
import { AgentWorkspaceCompanion, type AgentWorkspaceCompanionTools } from '../../workspace-react'

const documents: Record<string, string> = {
  'campaigns/developer-invitation.md': 'A single API for your next inference experiment.\n\nConnect your first provider, run a real request, and compare a second provider with the same call shape.',
  'research/customer-questions.md': 'Which providers do you use today?\nWhat is difficult to compare?\nWhat would make your first session worthwhile?',
}
function FilesPane() {
  const [selected, setSelected] = useState<string>()
  return (
    <WorkspaceFilesPane
      paths={Object.keys(documents)}
      selectedPath={selected}
      onSelect={(path) => {
        if (Object.hasOwn(documents, path)) setSelected(path)
      }}
      onBack={() => setSelected(undefined)}
      preview={selected ? {
        path: selected,
        content: <article className="p-4 text-sm leading-7"><p className="whitespace-pre-wrap">{documents[selected]}</p></article>,
      } : undefined}
    />
  )
}
function TerminalPane() {
  const [text, setText] = useState('')
  return <textarea aria-label="Terminal fixture" placeholder="Story fixture — no shell connected" className="h-full w-full resize-none bg-background p-4 font-mono text-sm" value={text} onChange={(event) => setText(event.target.value)} />
}
function CompanionStory({ defaultOpen = false, noTools = false }: { defaultOpen?: boolean; noTools?: boolean }) {
  const [active, setActive] = useState('files')
  const tools = useMemo<AgentWorkspaceCompanionTools>(() => noTools ? {} : {
    files: () => <FilesPane />,
    terminal: () => <TerminalPane />,
    preview: () => <article className="p-5 text-sm leading-7"><h2 className="font-semibold">Developer invitation</h2><p className="mt-3">Try a real inference request with your preferred provider.</p></article>,
  }, [noTools])
  return <div className="h-screen bg-background text-foreground"><AgentWorkspaceCompanion tools={tools} defaultOpen={defaultOpen} activeTabId={active} onActiveTabChange={setActive} persistenceKey="storybook-companion"><main className="flex h-full flex-col"><div className="mx-auto w-full max-w-3xl flex-1 overflow-auto px-6 py-16"><p className="mb-6 text-sm text-muted-foreground">Help me write a developer invitation.</p><p className="text-base leading-7">Start with one practical outcome: run a real request, then compare a second provider. I saved the invitation and customer questions in your files.</p></div><div className="mx-auto mb-6 w-full max-w-3xl px-6"><textarea aria-label="Message" placeholder="Message your agent" className="h-24 w-full resize-none rounded-2xl border border-border bg-card p-4 text-base" /></div></main></AgentWorkspaceCompanion></div>
}
const meta: Meta<typeof CompanionStory> = { title: 'Workspace/Companion', component: CompanionStory, parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj<typeof CompanionStory>
export const Collapsed: Story = {}
export const Expanded: Story = { args: { defaultOpen: true } }
export const ConversationOnly: Story = { args: { noTools: true } }

/** A conversation written the way product threads are: a `flex-1` section whose
 *  message list scrolls on its own above a shrink-0 composer. Many turns and a
 *  narrow phone must keep the composer on screen. */
function LongConversationStory() {
  const turns = Array.from({ length: 24 }, (_, i) => i)
  return (
    <div className="h-screen bg-background text-foreground">
      <AgentWorkspaceCompanion tools={{ files: () => <FilesPane /> }} persistenceKey="storybook-companion-long">
        <section className="flex flex-1 flex-col min-w-0">
          <div data-testid="message-list" className="flex-1 overflow-y-auto px-4 py-6">
            {turns.map((i) => (
              <p key={i} className="mb-4 text-sm leading-6">Turn {i + 1}: compare the filing deadline for Northwind Industries Holdings International LLC against the Delaware annual report window.</p>
            ))}
          </div>
          <div className="shrink-0 border-t border-border bg-background p-4">
            <textarea aria-label="Message" placeholder="Message your agent" className="h-40 w-full resize-none rounded-2xl border border-border bg-card p-4 text-base" />
          </div>
        </section>
      </AgentWorkspaceCompanion>
    </div>
  )
}
export const LongConversation: StoryObj<typeof LongConversationStory> = { render: () => <LongConversationStory /> }
