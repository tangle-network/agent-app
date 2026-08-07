import type { Meta, StoryObj } from '@storybook/react'
import type { SceneDocument } from '../../design-canvas'
import { darkTheme, lightTheme } from '../../theme/theme'
import { CanvasInsertPanel, DesignCanvasEditor } from '../../design-canvas-react'
import type { DesignCanvasProps } from '../../design-canvas-react'
import {
  makeEmptyScene,
  makeLaunchPosterScene,
  makeMultiPageScene,
  useIsDark,
  useLocalSceneDocument,
} from './fixtures'

/**
 * The full editor shell — toolbar, rulers, layers panel, pages strip, zoom
 * controls, Konva canvas — sharing one command stack, mounted the way the
 * playground's canvas route mounts it: operations reduce locally through the
 * real `applySceneOperations` engine, so every story is fully interactive
 * (drag, transform, undo/redo, insert, pages, export).
 */
const meta: Meta<typeof DesignCanvasEditor> = {
  title: 'Design Canvas/DesignCanvasEditor',
  component: DesignCanvasEditor,
  parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof DesignCanvasEditor>

interface HarnessProps {
  initial: SceneDocument
  editorProps?: Partial<DesignCanvasProps>
  /** Wrapper sizing — `h-screen` for standalone stories, `h-full` in grids. */
  className?: string
  /**
   * Mount the mock side/agent host panels. Default true. The composite story
   * passes false: its cells are ~650px wide and the chrome's fixed w-64/w-80
   * panel slots would squeeze the canvas to a sliver.
   */
  withPanels?: boolean
}

/** Local-persistence host: holds document+rev, threads the insert panel into
 *  the chrome's side slot, and feeds the active theme's Konva palette. */
function EditorHarness({ initial, editorProps, className = 'h-screen w-full', withPanels = true }: HarnessProps) {
  const { document: doc, rev, onApplyOperations } = useLocalSceneDocument(initial)
  const isDark = useIsDark()

  return (
    <div className={className}>
      <DesignCanvasEditor
        document={doc}
        rev={rev}
        canWrite
        onApplyOperations={onApplyOperations}
        onSelectionChange={(elements) => console.log('[design-canvas story] selection', elements.map((el) => el.id))}
        renderSidePanel={
          withPanels
            ? ({ activePage }) => (
                <CanvasInsertPanel
                  canWrite={editorProps?.canWrite ?? true}
                  page={{
                    pageId: activePage.id,
                    width: activePage.width,
                    height: activePage.height,
                    background: activePage.background,
                  }}
                  onInsert={onApplyOperations}
                />
              )
            : undefined
        }
        renderAgentPanel={
          withPanels
            ? ({ selectedElements }) => (
                <div className="flex h-full flex-col gap-2 bg-[var(--bg-input)] p-4 text-sm text-[var(--text-secondary)]">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-muted)]">
                    Agent panel (host slot)
                  </span>
                  <p className="text-xs leading-5 text-[var(--text-muted)]">
                    {selectedElements.length > 0
                      ? `${selectedElements.length} element${selectedElements.length === 1 ? '' : 's'} selected — the host's agent chat would target these.`
                      : 'Nothing selected — the host renders its agent chat in this slot.'}
                  </p>
                </div>
              )
            : undefined
        }
        onExport={async (result) => {
          console.log('[design-canvas story] export', {
            pageId: result.pageId,
            format: result.format,
            pixelRatio: result.pixelRatio,
            dataUrlBytes: result.dataUrl.length,
          })
        }}
        onAskAgent={() => console.log('[design-canvas story] ask agent')}
        render={isDark ? darkTheme.canvasRender : lightTheme.canvasRender}
        {...editorProps}
      />
    </div>
  )
}

/** Blank page: the branded empty state offers template / add-element / agent doors. */
export const EditorDefault: Story = {
  name: 'Default (empty scene)',
  render: () => <EditorHarness initial={makeEmptyScene()} />,
}

/** The launch-poster scene: guides, eight elements, every layer kind the poster uses. */
export const EditorWithDocument: Story = {
  name: 'With document',
  render: () => <EditorHarness initial={makeLaunchPosterScene()} />,
}

/**
 * Three pages (square / story / banner) with distinct aspect ratios and a
 * bleed-enabled print page — exercises the pages strip, per-page fit, and the
 * bleed overlay toggle.
 */
export const EditorMultiPage: Story = {
  name: 'Multi-page',
  render: () => <EditorHarness initial={makeMultiPageScene()} />,
}

/** Review mode: the lean reviewer surface — authoring controls hidden, safe
 *  direct edits (drag, text edit, opacity/rotation, undo/redo) kept. */
export const EditorReviewMode: Story = {
  name: 'Review mode',
  render: () => <EditorHarness initial={makeLaunchPosterScene()} editorProps={{ mode: 'review' }} />,
}

/** Read-only host: `canWrite: false` disables editing, insert, and page management. */
export const EditorReadOnly: Story = {
  name: 'Read only',
  render: () => <EditorHarness initial={makeLaunchPosterScene()} editorProps={{ canWrite: false }} />,
}

/**
 * Every editor state side by side at thumbnail scale — the at-a-glance polish
 * check for chrome spacing, panel proportions, and theme quality. Host panels
 * are omitted in these cells: the chrome's fixed w-64/w-80 panel slots would
 * squeeze each mini editor's canvas to a sliver.
 */
export const EditorStates: Story = {
  name: 'All states (composite)',
  render: () => {
    const cells: Array<{ label: string; initial: SceneDocument; editorProps?: Partial<DesignCanvasProps> }> = [
      { label: 'Empty — three-door state', initial: makeEmptyScene() },
      { label: 'Populated poster', initial: makeLaunchPosterScene() },
      { label: 'Multi-page + bleed', initial: makeMultiPageScene() },
      { label: 'Read only', initial: makeLaunchPosterScene(), editorProps: { canWrite: false } },
    ]
    return (
      <div className="grid grid-cols-2 gap-4 bg-[var(--canvas-backdrop)] p-4">
        {cells.map((cell) => (
          <div key={cell.label} className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-muted)]">
              {cell.label}
            </span>
            <div className="h-[520px] overflow-hidden rounded-md border border-[var(--border-default)]">
              <EditorHarness
                initial={cell.initial}
                editorProps={cell.editorProps}
                className="h-full w-full"
                withPanels={false}
              />
            </div>
          </div>
        ))}
      </div>
    )
  },
}
