import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import type { SceneElement, ScenePage } from '../../design-canvas'
import { Toolbar } from '../../design-canvas-react'
import { makeLaunchPosterScene, makeMultiPageScene } from './fixtures'

/**
 * Selection-aware toolbar. With no selection it shows page props (name, size
 * preset, W×H, background, bleed); with a selection it shows per-kind
 * attribute controls; review mode strips it to safe direct edits.
 */
const meta: Meta<typeof Toolbar> = {
  title: 'Design Canvas/Toolbar',
  component: Toolbar,
  decorators: [
    (Story) => (
      <div className="w-[1024px] rounded-md border border-[var(--border-default)]">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof Toolbar>

const posterPage = makeLaunchPosterScene().pages[0]!
const showcasePage = makeMultiPageScene().pages[1]!

function posterElement(id: string): SceneElement {
  const el = posterPage.elements.find((candidate) => candidate.id === id)
  if (!el) throw new Error(`fixture element ${id} missing`)
  return el
}

function showcaseElement(id: string): SceneElement {
  const el = showcasePage.elements.find((candidate) => candidate.id === id)
  if (!el) throw new Error(`fixture element ${id} missing`)
  return el
}

interface ToolbarOverrides {
  page?: ScenePage
  selectedElements?: SceneElement[]
  canWrite?: boolean
  mode?: 'edit' | 'review'
  canUndo?: boolean
  canRedo?: boolean
  gridEnabled?: boolean
  snapEnabled?: boolean
  showRulers?: boolean
  showBleed?: boolean
}

function StaticToolbar({
  page = posterPage,
  selectedElements = [],
  canWrite = true,
  mode = 'edit',
  canUndo = true,
  canRedo = false,
  gridEnabled = true,
  snapEnabled = true,
  showRulers = true,
  showBleed = false,
}: ToolbarOverrides) {
  return (
    <Toolbar
      page={page}
      selectedElements={selectedElements}
      canWrite={canWrite}
      mode={mode}
      canUndo={canUndo}
      canRedo={canRedo}
      gridEnabled={gridEnabled}
      snapEnabled={snapEnabled}
      showRulers={showRulers}
      showBleed={showBleed}
      onUndo={() => console.log('[toolbar story] undo')}
      onRedo={() => console.log('[toolbar story] redo')}
      onToggleGrid={() => console.log('[toolbar story] toggle grid')}
      onToggleSnap={() => console.log('[toolbar story] toggle snap')}
      onToggleRulers={() => console.log('[toolbar story] toggle rulers')}
      onToggleBleed={() => console.log('[toolbar story] toggle bleed')}
      onSetAttrs={(elementId, attrs) => console.log('[toolbar story] setAttrs', elementId, attrs)}
      onSetPageProps={(props) => console.log('[toolbar story] setPageProps', props)}
      onSetPageGuides={(guides) => console.log('[toolbar story] setPageGuides', guides)}
      onReorder={(elementId, toIndex, ownerLength, direction) =>
        console.log('[toolbar story] reorder', { elementId, toIndex, ownerLength, direction })
      }
      onGroup={(elementIds) => console.log('[toolbar story] group', elementIds)}
      onUngroup={(groupId) => console.log('[toolbar story] ungroup', groupId)}
      onDelete={(elementIds) => console.log('[toolbar story] delete', elementIds)}
      onBindSlot={(elementId, slot) => console.log('[toolbar story] bindSlot', { elementId, slot })}
    />
  )
}

/** No selection: page name, size preset, custom W×H, background, bleed controls. */
export const NoSelection: Story = {
  name: 'No selection (page props)',
  render: () => <StaticToolbar />,
}

/** Single text element: font picker, size, bold/italic, align, line height, fill. */
export const TextSelected: Story = {
  name: 'Text selected',
  render: () => <StaticToolbar selectedElements={[posterElement('el-title')]} />,
}

/** Single rect: fill/stroke swatches, stroke width, corner radius. */
export const RectSelected: Story = {
  name: 'Rect selected',
  render: () => <StaticToolbar selectedElements={[posterElement('el-bg')]} />,
}

/** Single image: fit select + replace-image popover. */
export const ImageSelected: Story = {
  name: 'Image selected',
  render: () => <StaticToolbar page={showcasePage} selectedElements={[showcaseElement('el-hero')]} />,
}

/** Two elements: shared opacity/rotation + the group action appears. */
export const MultiSelected: Story = {
  name: 'Multi selected',
  render: () => <StaticToolbar selectedElements={[posterElement('el-accent'), posterElement('el-chip')]} />,
}

/** A selected group exposes the ungroup action. */
export const GroupSelected: Story = {
  name: 'Group selected',
  render: () => <StaticToolbar page={showcasePage} selectedElements={[showcaseElement('el-header-group')]} />,
}

/** Review mode: view toggles, page props, and destructive/structural controls
 *  are hidden; safe direct edits stay. */
export const ReviewMode: Story = {
  name: 'Review mode',
  render: () => <StaticToolbar mode="review" selectedElements={[posterElement('el-title')]} />,
};

/** View-only host: every control disabled. */
export const ReadOnly: Story = {
  name: 'Read only',
  render: () => <StaticToolbar canWrite={false} canUndo={false} />,
}

/** View toggles and undo/redo actually flip local state. */
export const Interactive: Story = {
  render: function InteractiveToolbar() {
    const [grid, setGrid] = useState(true)
    const [snap, setSnap] = useState(true)
    const [rulers, setRulers] = useState(true)
    const [bleed, setBleed] = useState(false)
    const [history, setHistory] = useState<string[]>(['initial'])
    const [undoDepth, setUndoDepth] = useState(0)

    return (
      <Toolbar
        page={{ ...posterPage, bleed: { top: 12, right: 12, bottom: 12, left: 12 } }}
        selectedElements={[]}
        canWrite
        canUndo={undoDepth > 0}
        canRedo={undoDepth < history.length - 1}
        gridEnabled={grid}
        snapEnabled={snap}
        showRulers={rulers}
        showBleed={bleed}
        onUndo={() => setUndoDepth((d) => Math.max(0, d - 1))}
        onRedo={() => setUndoDepth((d) => Math.min(history.length - 1, d + 1))}
        onToggleGrid={() => setGrid((v) => !v)}
        onToggleSnap={() => setSnap((v) => !v)}
        onToggleRulers={() => setRulers((v) => !v)}
        onToggleBleed={() => setBleed((v) => !v)}
        onSetAttrs={(elementId, attrs) => console.log('[toolbar story] setAttrs', elementId, attrs)}
        onSetPageProps={(props) => {
          console.log('[toolbar story] setPageProps', props)
          setHistory((h) => [...h, JSON.stringify(props)])
          setUndoDepth((d) => d + 1)
        }}
        onSetPageGuides={(guides) => console.log('[toolbar story] setPageGuides', guides)}
        onReorder={(elementId, toIndex, ownerLength, direction) =>
          console.log('[toolbar story] reorder', { elementId, toIndex, ownerLength, direction })
        }
        onGroup={(elementIds) => console.log('[toolbar story] group', elementIds)}
        onUngroup={(groupId) => console.log('[toolbar story] ungroup', groupId)}
        onDelete={(elementIds) => console.log('[toolbar story] delete', elementIds)}
        onBindSlot={(elementId, slot) => console.log('[toolbar story] bindSlot', { elementId, slot })}
      />
    )
  },
}

/** The bar's four faces stacked — wrap behavior, control density, theme tokens. */
export const AllStates: Story = {
  name: 'All states (composite)',
  decorators: [],
  render: () => (
    <div className="flex w-[1024px] flex-col gap-4">
      {[
        { label: 'No selection — page props', node: <StaticToolbar /> },
        { label: 'Text selected', node: <StaticToolbar selectedElements={[posterElement('el-title')]} /> },
        { label: 'Image selected', node: <StaticToolbar page={showcasePage} selectedElements={[showcaseElement('el-hero')]} /> },
        { label: 'Multi selected — groupable', node: <StaticToolbar selectedElements={[posterElement('el-accent'), posterElement('el-chip')]} /> },
        { label: 'Review mode', node: <StaticToolbar mode="review" selectedElements={[posterElement('el-title')]} /> },
        { label: 'Read only', node: <StaticToolbar canWrite={false} canUndo={false} /> },
      ].map((row) => (
        <div key={row.label} className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{row.label}</span>
          <div className="rounded-md border border-[var(--border-default)]">{row.node}</div>
        </div>
      ))}
    </div>
  ),
}
