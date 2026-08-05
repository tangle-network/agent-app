import type { Meta, StoryObj } from '@storybook/react'
import { CanvasInsertPanel } from '../../design-canvas-react'
import type { CanvasInsertPanelProps, InsertGeneration } from '../../design-canvas-react'
import { makeLaunchPosterScene } from './fixtures'

/**
 * The human "add element" left rail: uploads (drag/drop or file picker),
 * starter templates, and previously-generated images. All I/O is callback-
 * driven; inserts flow through the same `onApplyOperations` pipeline as every
 * other edit.
 */
const meta: Meta<typeof CanvasInsertPanel> = {
  title: 'Design Canvas/CanvasInsertPanel',
  component: CanvasInsertPanel,
  decorators: [
    (Story) => (
      <div className="h-[520px] w-[300px] border border-[var(--border-default)]">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof CanvasInsertPanel>

const posterPage = makeLaunchPosterScene().pages[0]!
const page = {
  pageId: posterPage.id,
  width: posterPage.width,
  height: posterPage.height,
  background: posterPage.background,
}

const onInsert: CanvasInsertPanelProps['onInsert'] = async (operations) => {
  console.log('[insert story] insert operations', operations)
}

/** Fake host upload: resolves a rooted `/api/` path (the scene media boundary). */
const onUploadImage: NonNullable<CanvasInsertPanelProps['onUploadImage']> = async (file) => {
  console.log('[insert story] upload', file.name, file.type, file.size)
  return `/api/uploads/${encodeURIComponent(file.name)}`
}

const generations: InsertGeneration[] = [
  { id: 'gen-1', url: 'https://picsum.photos/seed/agent-hero/480/480', label: 'Hero concept — blue gradient' },
  { id: 'gen-2', url: 'https://picsum.photos/seed/agent-texture/480/480', label: 'Background texture' },
  { id: 'gen-3', url: 'https://picsum.photos/seed/agent-icon/480/480', label: 'Icon study' },
]

const loadGenerations: NonNullable<CanvasInsertPanelProps['loadGenerations']> = async () => {
  // Small delay so the loading spinner is visible on first open.
  await new Promise((resolve) => setTimeout(resolve, 400))
  return generations
}

/** Default: the built-in starter template grid (heading, body, rect, ellipse). */
export const Templates: Story = {
  render: () => <CanvasInsertPanel canWrite page={page} onInsert={onInsert} />,
}

/** Uploads tab (templates removed so it opens first): dropzone + file picker. */
export const Uploads: Story = {
  render: () => (
    <CanvasInsertPanel canWrite page={page} onInsert={onInsert} onUploadImage={onUploadImage} templates={[]} />
  ),
}

/** All three tabs; the Generations tab loads tiles from the host provider. */
export const AllTabs: Story = {
  name: 'All tabs (uploads + templates + generations)',
  render: () => (
    <CanvasInsertPanel
      canWrite
      page={page}
      onInsert={onInsert}
      onUploadImage={onUploadImage}
      loadGenerations={loadGenerations}
    />
  ),
}

/** Upload failure surfaces as an inline error (click the dropzone after picking
 *  a file — the fake host rejects every upload). */
export const UploadFailure: Story = {
  name: 'Upload failure (inline error)',
  render: () => (
    <CanvasInsertPanel
      canWrite
      page={page}
      onInsert={onInsert}
      templates={[]}
      onUploadImage={async (file) => {
        throw new Error(`Upload failed for ${file.name}: 503 from the asset service`)
      }}
    />
  ),
}

/** View-only host: tabs collapse to the access notice. */
export const ViewOnly: Story = {
  name: 'View only',
  render: () => (
    <CanvasInsertPanel
      canWrite={false}
      page={page}
      onInsert={onInsert}
      onUploadImage={onUploadImage}
      loadGenerations={loadGenerations}
    />
  ),
}

/** The rail's faces side by side. */
export const AllStates: Story = {
  name: 'All states (composite)',
  decorators: [],
  render: () => (
    <div className="flex items-start gap-4">
      {[
        { label: 'Templates', node: <CanvasInsertPanel canWrite page={page} onInsert={onInsert} /> },
        {
          label: 'Uploads',
          node: <CanvasInsertPanel canWrite page={page} onInsert={onInsert} onUploadImage={onUploadImage} templates={[]} />,
        },
        {
          label: 'All tabs',
          node: (
            <CanvasInsertPanel
              canWrite
              page={page}
              onInsert={onInsert}
              onUploadImage={onUploadImage}
              loadGenerations={loadGenerations}
            />
          ),
        },
        { label: 'View only', node: <CanvasInsertPanel canWrite={false} page={page} onInsert={onInsert} /> },
      ].map((cell) => (
        <div key={cell.label} className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{cell.label}</span>
          <div className="h-[520px] w-[300px] border border-[var(--border-default)]">{cell.node}</div>
        </div>
      ))}
    </div>
  ),
}
