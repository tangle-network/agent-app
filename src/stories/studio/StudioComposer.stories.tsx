import type { Meta, StoryObj } from '@storybook/react'
import { useEffect, useRef, type ReactNode } from 'react'
import { GenerationNoticeChip, StudioComposer } from '../../studio-react'
import type { GenerationType, MediaModelCatalogResponse, MediaModelOption } from '../../studio'

/**
 * The chat-shaped composer. Its whole subject is the pill set the SELECTED
 * MODEL publishes, so these stories serve `/api/media-models` from a fixture
 * catalog rather than mounting without a workspace: a composer with no catalog
 * can only ever show the empty state, which is one story, not six.
 *
 * `/api/generate` answers 501 — Storybook has no generation backend, and a
 * story that silently swallowed the POST would look like it worked.
 */

function model(id: string, type: GenerationType, provider: string, name = id): MediaModelOption {
  return { id, name, provider, type, status: 'available' }
}

const CATALOG: MediaModelCatalogResponse = {
  defaults: {
    image: 'gpt-image-2',
    video: 'bytedance/seedance-2.0/text-to-video',
    speech: 'tts-1',
    avatar: '',
    transcription: '',
  },
  models: {
    image: [
      model('gpt-image-2', 'image', 'openai', 'GPT Image 2'),
      // Curated out of the composer (#449 offers gpt-image-2 only) — present
      // here so the story proves the curation rather than assuming it.
      model('imagen-4', 'image', 'google', 'Imagen 4'),
    ],
    video: [
      model('bytedance/seedance-2.0/text-to-video', 'video', 'bytedance', 'Seedance 2.0'),
      // Reached by attaching a reference image, never listed in the menu.
      model('bytedance/seedance-2.0/image-to-video', 'video', 'bytedance', 'Seedance 2.0 (image)'),
      model('fal-ai/veo3.1', 'video', 'google', 'Veo 3.1'),
      model('kling/kling-v2-master', 'video', 'kling', 'Kling v2 Master'),
      // Publishes no options at all: the model pill and nothing else.
      model('ltx-video', 'video', 'fal', 'LTX Video'),
      model('sora-2', 'video', 'openai', 'Sora 2'),
    ],
    speech: [
      model('tts-1', 'speech', 'openai', 'TTS 1'),
      model('gpt-4o-mini-tts', 'speech', 'openai', 'GPT-4o mini TTS'),
      model('gemini-2.5-flash-preview-tts', 'speech', 'google', 'Gemini 2.5 Flash TTS'),
      // No publicly enumerable voice list: no Voice pill, provider default used.
      model('voxtral-mini', 'speech', 'mistral', 'Voxtral Mini'),
    ],
    avatar: [],
    transcription: [],
  },
}

const EMPTY_CATALOG: MediaModelCatalogResponse = {
  defaults: CATALOG.defaults,
  models: { image: [], video: [], speech: [], avatar: [], transcription: [] },
}

let servedCatalog = CATALOG
let stubInstalled = false

/** Installed once, and only for the two studio endpoints — every other request
 *  falls through to the real `fetch`, so no other story's network changes. */
function installFetchStub() {
  if (stubInstalled || typeof window === 'undefined') return
  stubInstalled = true
  const original = window.fetch.bind(window)
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('/api/media-models')) return Promise.resolve(json(servedCatalog))
    if (url.startsWith('/api/generate')) {
      return Promise.resolve(json({ error: 'Storybook has no generation backend.' }, 501))
    }
    return original(input, init)
  }) as typeof window.fetch
}

function withCatalog(catalog: MediaModelCatalogResponse, width = 'w-full max-w-[820px]') {
  return function CatalogDecorator(Story: () => ReactNode) {
    servedCatalog = catalog
    installFetchStub()
    return (
      <div className={`${width} max-w-full p-4`}>
        <Story />
      </div>
    )
  }
}

/**
 * A lane story starts where the reader wants to look. The composer opens on
 * Image by design (no prop chooses the lane — the segmented control does), so
 * the harness presses the segment the same way a reader would, through the
 * `aria-label` the control publishes.
 */
function OnLane({ lane, children }: { lane: 'Image' | 'Video' | 'Audio'; children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const segment = host.current?.querySelector<HTMLButtonElement>(`button[aria-label="${lane}"]`)
    if (segment?.getAttribute('aria-pressed') === 'false') segment.click()
  }, [lane])
  return <div ref={host}>{children}</div>
}

const meta: Meta<typeof StudioComposer> = {
  title: 'Studio/StudioComposer',
  component: StudioComposer,
  decorators: [withCatalog(CATALOG)],
  args: {
    workspaceId: 'ws-demo',
    onGenerated: (generation) => console.log('onGenerated', generation.id),
  },
}

export default meta
type Story = StoryObj<typeof StudioComposer>

/** Image lane — Size (with a "Custom…" row), Quality, Count. Only gpt-image-2
 *  is offered; the catalog's Imagen row is curated out. */
export const ImageLane: Story = {
  name: 'Image lane',
}

/** Video lane on Seedance 2.0 — Duration, Resolution, Aspect, the audio toggle,
 *  and the Reference pill that swaps the model to the image-to-video sibling. */
export const VideoLane: Story = {
  name: 'Video lane',
  render: (args) => (
    <OnLane lane="Video">
      <StudioComposer {...args} />
    </OnLane>
  ),
}

/** Audio lane on TTS 1 — nine published voices and a speed preset list. Switch
 *  to Voxtral to see the honest empty case: no Voice pill at all. */
export const AudioLane: Story = {
  name: 'Audio lane',
  render: (args) => (
    <OnLane lane="Audio">
      <StudioComposer {...args} />
    </OnLane>
  ),
}

/** No routable models: the model pill says so and Generate stays disabled. */
export const EmptyCatalog: Story = {
  name: 'Empty catalog',
  decorators: [withCatalog(EMPTY_CATALOG)],
}

/** 480px — the narrowest width the one-row control layout is designed for. The
 *  segmented group and the send button stay pinned; the pills scroll between
 *  them, with the edge fade showing how much is off-screen. */
export const Narrow: Story = {
  name: 'Narrow (480px)',
  decorators: [withCatalog(CATALOG, 'w-[480px]')],
  render: (args) => (
    <OnLane lane="Video">
      <StudioComposer {...args} />
    </OnLane>
  ),
}

/** The one-off notice, as the host stacks it above the card. */
export const WithNotice: Story = {
  name: 'With the notice chip',
  render: (args) => (
    <div className="flex flex-col items-center gap-3">
      <GenerationNoticeChip />
      <StudioComposer {...args} className="w-full" />
    </div>
  ),
}
