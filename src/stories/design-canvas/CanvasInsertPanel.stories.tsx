import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
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

/**
 * Mount-effect drivers, mirroring the `AutoClick` pattern in
 * chat-controls/fixtures.tsx: the panel owns its file input and active tab as
 * internal state with no prop seam, so reaching post-interaction states in a
 * static story means acting like a user after mount.
 */

/** Feeds a synthetic file through the hidden file input (a real `change`
 *  event, so the panel's own upload handler runs) — upload outcomes render
 *  without a manual file pick. No-op where `DataTransfer` is unavailable
 *  (jsdom smoke mounts). */
function AutoPickFile({ children, fileName }: { children: ReactNode; fileName: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const input = hostRef.current?.querySelector<HTMLInputElement>('input[type="file"]')
    if (!input || typeof DataTransfer === 'undefined') return
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], fileName, { type: 'image/png' }))
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, [fileName])
  return (
    <div ref={hostRef} className="h-full min-h-0">
      {children}
    </div>
  )
}

/** Clicks the tab with the given label after mount — the active tab is
 *  internal state, so a story cannot open the panel on another tab directly. */
function AutoOpenTab({ children, label }: { children: ReactNode; label: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const tab = Array.from(host.querySelectorAll('button')).find((button) => button.textContent?.trim() === label)
    tab?.click()
  }, [label])
  return (
    <div ref={hostRef} className="h-full min-h-0">
      {children}
    </div>
  )
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

/** Upload failure surfaces as an inline error: a mount effect picks a file
 *  through the real input and the fake host rejects the upload. */
export const UploadFailure: Story = {
  name: 'Upload failure (inline error)',
  render: () => (
    <AutoPickFile fileName="hero-concept.png">
      <CanvasInsertPanel
        canWrite
        page={page}
        onInsert={onInsert}
        templates={[]}
        onUploadImage={async (file) => {
          throw new Error(`Upload failed for ${file.name}: 503 from the asset service`)
        }}
      />
    </AutoPickFile>
  ),
}

/** Mid-upload busy state: the dropzone swaps to a spinner + "Uploading…"
 *  while the host's store call is in flight (here it never resolves). */
export const UploadInProgress: Story = {
  name: 'Upload in progress (busy)',
  render: () => (
    <AutoPickFile fileName="background-texture.png">
      <CanvasInsertPanel
        canWrite
        page={page}
        onInsert={onInsert}
        templates={[]}
        onUploadImage={() => new Promise<string>(() => {})}
      />
    </AutoPickFile>
  ),
}

/** Generations tab, auto-opened after mount: loaded tiles from the host
 *  provider with their prompt labels as titles. */
export const Generations: Story = {
  name: 'Generations tab (populated)',
  render: () => (
    <AutoOpenTab label="Generations">
      <CanvasInsertPanel
        canWrite
        page={page}
        onInsert={onInsert}
        onUploadImage={onUploadImage}
        loadGenerations={loadGenerations}
      />
    </AutoOpenTab>
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
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-muted)]">{cell.label}</span>
          <div className="h-[520px] w-[300px] border border-[var(--border-default)]">{cell.node}</div>
        </div>
      ))}
    </div>
  ),
}
