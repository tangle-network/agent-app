import type { Meta, StoryObj } from '@storybook/react'

import { MessageAttachments } from '../../web-react'
import {
  fetchAttachmentHangs,
  fetchAttachmentMissing,
  fetchAttachmentOk,
  fileAttachmentParts,
  imageAttachmentParts,
  mixedAttachmentParts,
  resolveAttachmentUrl,
} from './fixtures'

/**
 * Transcript-side attachment rows. File chips fetch only on click (the fakes
 * here make a click download an SVG stand-in or surface the error tone); image
 * thumbnails fetch eagerly on mount, so each fetch fake is its own state story.
 */

const meta: Meta<typeof MessageAttachments> = {
  title: 'ChatControls/MessageAttachments',
  component: MessageAttachments,
  decorators: [
    (Story) => (
      <div className="w-[420px] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof MessageAttachments>

/** File chips — idle state; click one to download through the fake fetch. */
export const FileChips: Story = {
  name: 'File chips',
  args: {
    parts: fileAttachmentParts,
    resolveFileUrl: resolveAttachmentUrl,
    fetchFile: fetchAttachmentOk,
  },
}

/** Image thumbnails resolved — real bytes render as the thumbnails. */
export const ImageThumbnails: Story = {
  name: 'Image thumbnails',
  args: {
    parts: imageAttachmentParts,
    resolveFileUrl: resolveAttachmentUrl,
    fetchFile: fetchAttachmentOk,
  },
}

/** Images + a file together — thumbnails lead, chips wrap under them. */
export const Mixed: Story = {
  args: {
    parts: mixedAttachmentParts,
    resolveFileUrl: resolveAttachmentUrl,
    fetchFile: fetchAttachmentOk,
  },
}

/** Loading — the fetch never settles; thumbnails hold the pulse skeleton. */
export const Loading: Story = {
  args: {
    parts: imageAttachmentParts,
    resolveFileUrl: resolveAttachmentUrl,
    fetchFile: fetchAttachmentHangs,
  },
}

/** Load failure — thumbnails flip to the destructive error tile. */
export const LoadError: Story = {
  name: 'Load error',
  args: {
    parts: imageAttachmentParts,
    resolveFileUrl: resolveAttachmentUrl,
    fetchFile: fetchAttachmentMissing,
  },
}

/** `justify: 'start'` — an assistant turn's attachments, inline with the transcript. */
export const AssistantAlignment: Story = {
  name: 'Assistant alignment (start)',
  args: {
    parts: mixedAttachmentParts,
    resolveFileUrl: resolveAttachmentUrl,
    fetchFile: fetchAttachmentOk,
    justify: 'start',
  },
}

/** Every state stacked: thumbnails (ok / loading / error), chips, both aligns. */
export const AllStates: Story = {
  name: 'All states',
  render: () => (
    <div className="flex flex-col gap-6">
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">User bubble (end)</p>
        <MessageAttachments parts={mixedAttachmentParts} resolveFileUrl={resolveAttachmentUrl} fetchFile={fetchAttachmentOk} />
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Assistant (start)</p>
        <MessageAttachments parts={mixedAttachmentParts} resolveFileUrl={resolveAttachmentUrl} fetchFile={fetchAttachmentOk} justify="start" />
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Loading</p>
        <MessageAttachments parts={imageAttachmentParts} resolveFileUrl={resolveAttachmentUrl} fetchFile={fetchAttachmentHangs} />
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Load error</p>
        <MessageAttachments parts={imageAttachmentParts} resolveFileUrl={resolveAttachmentUrl} fetchFile={fetchAttachmentMissing} />
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">File chips</p>
        <MessageAttachments parts={fileAttachmentParts} resolveFileUrl={resolveAttachmentUrl} fetchFile={fetchAttachmentOk} />
      </div>
    </div>
  ),
}
