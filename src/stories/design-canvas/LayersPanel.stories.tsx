import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import type { SceneElement, ScenePage } from '../../design-canvas'
import { LayersPanel } from '../../design-canvas-react'
import { makeEmptyScene, makeLayersShowcasePage } from './fixtures'

/**
 * Reverse-z layer list for the active page. The showcase page carries one of
 * every interesting row state: a group with children, a hidden element, a
 * locked element, a slot-bound element, and image/video kinds whose media
 * never loads in Storybook.
 */
const meta: Meta<typeof LayersPanel> = {
  title: 'Design Canvas/LayersPanel',
  component: LayersPanel,
  decorators: [
    (Story) => (
      <div className="h-[460px] w-[280px] border border-[var(--border-default)] bg-[var(--bg-input)]">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof LayersPanel>

const noopPage = makeLayersShowcasePage()
const emptyPage = makeEmptyScene().pages[0]!

function baseProps(page: ScenePage) {
  return {
    page,
    selectedElementIds: [] as string[],
    canWrite: true,
    onSetAttrs: (elementId: string, attrs: Partial<Pick<SceneElement, 'name' | 'visible' | 'locked'>>) =>
      console.log('[layers story] setAttrs', elementId, attrs),
    onReorder: (elementId: string, toIndex: number) => console.log('[layers story] reorder', elementId, toIndex),
    onSelect: (elementId: string, additive: boolean) => console.log('[layers story] select', elementId, { additive }),
  }
}

/** Group (expanded children), hidden + locked rows, slot badge, all kind glyphs. */
export const Populated: Story = {
  render: () => <LayersPanel {...baseProps(noopPage)} selectedElementIds={['el-story-title']} />,
}

/** Nothing on the page — the panel renders its header over an empty list. */
export const Empty: Story = {
  render: () => <LayersPanel {...baseProps(emptyPage)} />,
}

/** View-only host: rows render but rename/visibility/lock/drag are inert. */
export const ReadOnly: Story = {
  name: 'Read only',
  render: () => <LayersPanel {...baseProps(noopPage)} canWrite={false} />,
}

/** Fully wired: click selects (meta-click adds), eye/lock toggles mutate local state. */
export const Interactive: Story = {
  render: function InteractiveLayers() {
    const [page, setPage] = useState(() => makeLayersShowcasePage())
    const [selected, setSelected] = useState<string[]>(['el-hero'])

    function patch(elementId: string, attrs: Partial<Pick<SceneElement, 'name' | 'visible' | 'locked'>>) {
      setPage((current) => ({
        ...current,
        elements: current.elements.map((el) => {
          if (el.id === elementId) return { ...el, ...attrs }
          if (el.kind === 'group') {
            return { ...el, children: el.children.map((child) => (child.id === elementId ? { ...child, ...attrs } : child)) }
          }
          return el
        }),
      }))
    }

    return (
      <LayersPanel
        {...baseProps(page)}
        selectedElementIds={selected}
        onSetAttrs={patch}
        onSelect={(elementId, additive) =>
          setSelected((prev) => (additive ? [...new Set([...prev, elementId])] : [elementId]))
        }
      />
    )
  },
}

/** Populated / empty / read-only side by side — the spacing + state polish check. */
export const AllStates: Story = {
  name: 'All states (composite)',
  // Side-by-side panel row — left-anchored so it can never clip.
  parameters: { layout: 'padded' },
  decorators: [],
  render: () => (
    <div className="flex items-start gap-4">
      {[
        { label: 'Populated', node: <LayersPanel {...baseProps(noopPage)} selectedElementIds={['el-story-title']} /> },
        { label: 'Empty', node: <LayersPanel {...baseProps(emptyPage)} /> },
        { label: 'Read only', node: <LayersPanel {...baseProps(noopPage)} canWrite={false} /> },
      ].map((cell) => (
        <div key={cell.label} className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{cell.label}</span>
          <div className="h-[460px] w-[280px] border border-[var(--border-default)] bg-[var(--bg-input)]">{cell.node}</div>
        </div>
      ))}
    </div>
  ),
}
