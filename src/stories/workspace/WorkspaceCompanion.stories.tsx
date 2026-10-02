import type { Meta, StoryObj } from '@storybook/react'
import { Files, SquareTerminal, Monitor } from 'lucide-react'
import { useMemo, useState } from 'react'
import { RichFileTree } from '@tangle-network/ui/files'
import { AgentWorkspaceCompanion, type AgentWorkspaceCompanionTab } from '../../workspace-react'

const documents: Record<string, string> = {
  'campaigns/developer-invitation.md': 'A single API for your next inference experiment.\n\nConnect your first provider, run a real request, and compare a second provider with the same call shape.',
  'research/customer-questions.md': 'Which providers do you use today?\nWhat is difficult to compare?\nWhat would make your first session worthwhile?',
}
function FilesPane() {
  const [selected, setSelected] = useState<string>()
  return selected ? (
    <div className="flex h-full flex-col">
      <button className="border-b border-border p-3 text-left text-sm" onClick={() => setSelected(undefined)}>Files</button>
      <article className="overflow-auto p-4 text-sm leading-7"><h2 className="mb-4 font-medium">{selected.split('/').at(-1)}</h2><p className="whitespace-pre-wrap">{documents[selected]}</p></article>
    </div>
  ) : <RichFileTree style={{ colorScheme: 'inherit' }} paths={Object.keys(documents)} selectedPath={selected} onSelect={setSelected} />
}
function TerminalPane() {
  const [text, setText] = useState('')
  return <textarea aria-label="Terminal fixture" placeholder="Story fixture — no shell connected" className="h-full w-full resize-none bg-background p-4 font-mono text-sm" value={text} onChange={(event) => setText(event.target.value)} />
}
function CompanionStory({ defaultOpen = false, noTools = false }: { defaultOpen?: boolean; noTools?: boolean }) {
  const [active, setActive] = useState('files')
  const tabs = useMemo<AgentWorkspaceCompanionTab[]>(() => noTools ? [] : [
    { id: 'files', label: 'Files', icon: <Files size={16} />, renderContent: () => <FilesPane /> },
    { id: 'terminal', label: 'Terminal', icon: <SquareTerminal size={16} />, keepMounted: true, renderContent: () => <TerminalPane /> },
    { id: 'preview', label: 'Preview', icon: <Monitor size={16} />, renderContent: () => <article className="p-5 text-sm leading-7"><h2 className="font-semibold">Developer invitation</h2><p className="mt-3">Try a real inference request with your preferred provider.</p></article> },
  ], [noTools])
  return <div className="h-screen bg-background text-foreground"><AgentWorkspaceCompanion tabs={tabs} defaultOpen={defaultOpen} activeTabId={active} onActiveTabChange={setActive} persistenceKey="storybook-companion"><main className="flex h-full flex-col"><div className="mx-auto w-full max-w-3xl flex-1 overflow-auto px-6 py-16"><p className="mb-6 text-sm text-muted-foreground">Help me write a developer invitation.</p><p className="text-base leading-7">Start with one practical outcome: run a real request, then compare a second provider. I saved the invitation and customer questions in your files.</p></div><div className="mx-auto mb-6 w-full max-w-3xl px-6"><textarea aria-label="Message" placeholder="Message your agent" className="h-24 w-full resize-none rounded-2xl border border-border bg-card p-4 text-base" /></div></main></AgentWorkspaceCompanion></div>
}
const meta: Meta<typeof CompanionStory> = { title: 'Workspace/Companion', component: CompanionStory, parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj<typeof CompanionStory>
export const Collapsed: Story = {}
export const Expanded: Story = { args: { defaultOpen: true } }
export const ConversationOnly: Story = { args: { noTools: true } }
