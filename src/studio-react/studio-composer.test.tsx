// @vitest-environment jsdom
/**
 * The composer's contract is that the CONTROLS ARE THE MODEL'S OWN: a pill
 * exists only when the selected model publishes that parameter, and the value
 * reaches the wire exactly as published. Both halves are asserted here against
 * real catalog rows, because both have a silent failure mode — an invented
 * control looks like a feature, and a coerced `'5'` looks like a working
 * request until the provider rejects it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import type {
  GenerationType,
  MediaModelCatalogResponse,
  MediaModelOption,
  ModelOptionsMetadata,
} from '../studio'
import { StudioComposer } from './studio-composer'

function model(id: string, type: GenerationType, extra: Partial<MediaModelOption> = {}): MediaModelOption {
  return { id, name: id, type, status: 'available', ...extra }
}

const EMPTY_LANES: Record<GenerationType, MediaModelOption[]> = {
  image: [], video: [], speech: [], avatar: [], transcription: [],
}

function catalog(
  models: Partial<Record<GenerationType, MediaModelOption[]>>,
  defaults: Partial<Record<GenerationType, string>> = {},
): MediaModelCatalogResponse {
  return {
    defaults: { image: '', video: '', speech: '', avatar: '', transcription: '', ...defaults },
    models: { ...EMPTY_LANES, ...models },
  }
}

/** Publish the declared options plus a sentinel for any future PILL_ORDER key.
 *  That makes the wire-coverage test below render a newly added pill even before
 *  this fixture knows its name, so a missing request-body mapping fails loudly. */
function allPillOptions(options: ModelOptionsMetadata): ModelOptionsMetadata {
  return new Proxy(options, {
    get(target, property, receiver) {
      if (property === 'audio') return Reflect.get(target, property, receiver)
      if (typeof property === 'string' && !(property in target)) {
        return { values: ['wire-sentinel'], default: 'wire-sentinel' }
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

/** The two endpoints the composer talks to. Returns the bodies POSTed to
 *  `/api/generate`, so a test can assert the exact wire payload. */
function mountWith(
  response: MediaModelCatalogResponse | ((workspaceId: string) => MediaModelCatalogResponse),
  props: Record<string, unknown> = {},
) {
  const posted: Array<Record<string, unknown>> = []
  const fetchMock = vi.fn(async (input: unknown, init?: { body?: string }) => {
    const url = String(input)
    if (url.startsWith('/api/media-models')) {
      const workspaceId = new URL(url, 'https://studio.test').searchParams.get('workspaceId') ?? ''
      const body = typeof response === 'function' ? response(workspaceId) : response
      return { ok: true, json: async () => body } as unknown as Response
    }
    if (url === '/api/generate') {
      posted.push(JSON.parse(init?.body ?? '{}'))
      return {
        ok: true,
        json: async () => ({ generations: [{ id: 'gen-1', type: 'image', prompt: 'p', result: null, model: null, cost: null, createdAt: null, metadata: null }] }),
      } as unknown as Response
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const onGenerated = vi.fn()
  const view = render(<StudioComposer workspaceId="ws-1" onGenerated={onGenerated} {...props} />)
  return { posted, onGenerated, ...view }
}

const modelPill = () => screen.getByRole('button', { name: /^Model:/ })
const pill = (label: string) => screen.queryByRole('button', { name: new RegExp(`^${label}:`) })
const openPill = async (label: string) => {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}:`) }))
  return screen.findByRole('menu')
}

async function chooseModel(name: string) {
  fireEvent.click(modelPill())
  const menu = await screen.findByRole('menu')
  fireEvent.click(within(menu).getByRole('menuitemradio', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }))
}

async function submit(prompt: string) {
  const textarea = screen.getByLabelText('Prompt')
  fireEvent.change(textarea, { target: { value: prompt } })
  fireEvent.keyDown(textarea, { key: 'Enter' })
}

async function attachReference(url = 'https://example.com/ref.png') {
  fireEvent.click(screen.getByRole('button', { name: 'Reference image' }))
  fireEvent.change(await screen.findByLabelText('Reference image URL'), { target: { value: url } })
  fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
}

const SEEDANCE = 'bytedance/seedance-2.0/text-to-video'
const SEEDANCE_I2V = 'bytedance/seedance-2.0/image-to-video'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

describe('StudioComposer — persisted selections', () => {
  const imageDefault = 'gpt-image-2'
  const imageAlternate = 'openai/gpt-image-2'
  const persistenceCatalog = catalog({
    image: [model(imageDefault, 'image'), model(imageAlternate, 'image')],
    video: [model(SEEDANCE, 'video')],
  }, { image: imageDefault, video: SEEDANCE })

  it('restores the lane, model, size, and count after a same-workspace remount', async () => {
    const first = mountWith(persistenceCatalog)
    await screen.findByRole('button', { name: `Model: ${imageDefault}` })
    await chooseModel(imageAlternate)

    fireEvent.click(await screen.findByRole('button', { name: 'Size: Auto' }))
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitemradio', { name: '1536×1024' }))
    fireEvent.click(screen.getByRole('button', { name: 'Count: ×1' }))
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitemradio', { name: '×4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Video' }))

    expect(JSON.parse(window.localStorage.getItem('studio-composer:ws-1') ?? '{}')).toMatchObject({
      type: 'video',
      selectedModels: { image: imageAlternate },
      optionsByModel: { [imageAlternate]: { size: '1536x1024', n: 4 } },
    })
    first.unmount()

    mountWith(persistenceCatalog)
    await screen.findByRole('button', { name: `Model: ${SEEDANCE}` })
    expect(screen.getByRole('button', { name: 'Video' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Image' }))
    await screen.findByRole('button', { name: `Model: ${imageAlternate}` })
    expect(screen.getByRole('button', { name: 'Size: 1536×1024' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Count: ×4' })).not.toBeNull()
  })

  it('isolates selections by workspace', async () => {
    window.localStorage.setItem('studio-composer:ws-1', JSON.stringify({
      v: 1,
      type: 'video',
      selectedModels: { image: imageAlternate, video: SEEDANCE },
      optionsByModel: { [imageAlternate]: { size: '1536x1024', n: 4 } },
    }))

    mountWith(persistenceCatalog, { workspaceId: 'ws-2' })
    await screen.findByRole('button', { name: `Model: ${imageDefault}` })
    expect(screen.getByRole('button', { name: 'Image' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Size: Auto' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Count: ×1' })).not.toBeNull()
  })

  it('falls back from a stale model and reconciles stale options to catalog defaults', async () => {
    const unavailable = model('unavailable-image', 'image', { status: 'unavailable' })
    const currentCatalog = catalog({
      image: [model(imageDefault, 'image', {
        options: {
          size: { values: ['1024x1024'], default: '1024x1024' },
          n: { values: [1, 2], default: 1 },
        },
      }), unavailable],
    }, { image: imageDefault })
    window.localStorage.setItem('studio-composer:ws-1', JSON.stringify({
      v: 1,
      type: 'image',
      selectedModels: { image: unavailable.id },
      optionsByModel: {
        [imageDefault]: { size: 'removed-size', n: 99, unpublished: 'drop-me' },
      },
    }))

    mountWith(currentCatalog)
    await screen.findByRole('button', { name: `Model: ${imageDefault}` })
    expect(screen.getByRole('button', { name: 'Size: 1024×1024' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Count: ×1' })).not.toBeNull()
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('studio-composer:ws-1') ?? '{}')
      expect(stored.optionsByModel[imageDefault]).toEqual({ size: '1024x1024', n: 1 })
    })
  })

  it('clears the prompt on submit and never restores it with selections', async () => {
    const first = mountWith(persistenceCatalog)
    await screen.findByRole('button', { name: `Model: ${imageDefault}` })
    await chooseModel(imageAlternate)
    await submit('do not persist this prompt')
    await waitFor(() => expect(first.posted).toHaveLength(1))
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('')
    first.unmount()

    mountWith(persistenceCatalog)
    await screen.findByRole('button', { name: `Model: ${imageAlternate}` })
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('')
  })

  it('renders defaults when the stored JSON is corrupted', async () => {
    window.localStorage.setItem('studio-composer:ws-1', '{not-json')
    mountWith(persistenceCatalog)

    await screen.findByRole('button', { name: `Model: ${imageDefault}` })
    expect(screen.getByRole('button', { name: 'Image' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Size: Auto' })).not.toBeNull()
  })
})

describe('StudioComposer — the pills are the model’s own parameters', () => {
  it('keeps a fallback trigger icon for future option parameters', () => {
    const source = readFileSync('src/studio-react/studio-composer.tsx', 'utf8')
    expect(source).toContain('icon={PARAM_ICONS[param] ?? SlidersHorizontal}')
  })

  it('optically centers option pill labels; the truncating model label keeps a normal line box', async () => {
    mountWith(catalog({
      video: [model(SEEDANCE, 'video')],
    }, { video: SEEDANCE }))
    fireEvent.click(screen.getByRole('button', { name: 'Video' }))
    await screen.findByRole('button', { name: `Model: ${SEEDANCE}` })

    const trimClass = '[text-box:trim-both_cap_alphabetic]'
    expect(within(screen.getByRole('button', { name: 'Duration: Auto' })).getByText('Auto').className).toContain(trimClass)

    // The model label is the one pill label that truncates, and text-box trim
    // ends the box at the alphabetic baseline — under truncate's
    // overflow:hidden that clips descender ink ("gpt-image-2" loses its g/p
    // tails; measured 18.75px → 9.09px, see #467/#468). So it must carry a
    // normal line box instead of PILL_LABEL.
    const modelLabel = within(modelPill()).getByText(SEEDANCE).className
    expect(modelLabel).not.toContain(trimClass)
    expect(modelLabel).toContain('truncate')
    expect(modelLabel).toContain('leading-normal')
  })

  it('renders one pill per published parameter and nothing for an unknown model', async () => {
    mountWith(catalog({
      video: [model(SEEDANCE, 'video'), model('kling/kling-v2-master', 'video'), model('ltx-video', 'video')],
    }, { video: SEEDANCE }))
    fireEvent.click(screen.getByRole('button', { name: 'Video' }))
    await screen.findByRole('button', { name: `Model: ${SEEDANCE}` })

    expect(pill('Duration')).not.toBeNull()
    expect(pill('Resolution')).not.toBeNull()
    expect(pill('Aspect')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Audio on' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Reference image' })).not.toBeNull()

    // kling v2-master publishes `resolution`, `audio` and `mode` as
    // `supported: false` — three controls that must disappear, not grey out.
    await chooseModel('kling/kling-v2-master')
    expect(pill('Duration')).not.toBeNull()
    expect(pill('Aspect')).not.toBeNull()
    expect(pill('Resolution')).toBeNull()
    expect(pill('Mode')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Audio (on|off)$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reference image' })).toBeNull()

    // ltx-video publishes nothing at all: the model pill and no other control.
    await chooseModel('ltx-video')
    expect(screen.getByRole('button', { name: 'Model: ltx-video' })).not.toBeNull()
    for (const label of ['Duration', 'Resolution', 'Aspect', 'Mode']) expect(pill(label)).toBeNull()
  })

  it('lets the catalog’s live options beat the built-in fallback table', async () => {
    // The fallback publishes a four-step `resolution` for seedance. A catalog
    // row saying the model does not support it is the router's live word and
    // must win, or the composer offers a parameter the provider rejects.
    mountWith(catalog({
      video: [model(SEEDANCE, 'video', {
        options: {
          duration: { values: ['5'], default: '5' },
          resolution: { supported: false },
          aspect_ratio: { values: ['16:9'], default: '16:9' },
        },
      })],
    }, { video: SEEDANCE }))
    fireEvent.click(screen.getByRole('button', { name: 'Video' }))
    await screen.findByRole('button', { name: `Model: ${SEEDANCE}` })

    expect(pill('Duration')).not.toBeNull()
    expect(pill('Resolution')).toBeNull()
  })

  it('reconciles selected values onto the new model’s vocabulary', async () => {
    mountWith(catalog({
      video: [model(SEEDANCE, 'video'), model('fal-ai/veo3.1', 'video')],
    }, { video: SEEDANCE }))
    fireEvent.click(screen.getByRole('button', { name: 'Video' }))
    await screen.findByRole('button', { name: 'Duration: Auto' })

    // 'auto' is not a veo duration, so it resets to veo's own default — never
    // carried over as a value the next provider would reject.
    await chooseModel('fal-ai/veo3.1')
    await screen.findByRole('button', { name: 'Duration: 8s' })
    expect(screen.getByRole('button', { name: 'Aspect: 16:9' })).not.toBeNull()
  })
})

describe('StudioComposer — the reference image swaps the model', () => {
  it('attaches through the image-to-video sibling and detaches back', async () => {
    const { posted } = mountWith(catalog({
      video: [model(SEEDANCE, 'video'), model(SEEDANCE_I2V, 'video')],
    }, { video: SEEDANCE }))
    fireEvent.click(screen.getByRole('button', { name: 'Video' }))
    await screen.findByRole('button', { name: `Model: ${SEEDANCE}` })

    // The i2v sibling is never offered in the menu — it is reached by attaching.
    fireEvent.click(modelPill())
    const menu = await screen.findByRole('menu')
    expect(within(menu).queryByRole('menuitemradio', { name: new RegExp(SEEDANCE_I2V) })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })

    await attachReference()

    await screen.findByRole('button', { name: `Model: ${SEEDANCE_I2V}` })
    await submit('a slow orbit')
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({
      model: SEEDANCE_I2V,
      referenceImageUrl: 'https://example.com/ref.png',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove reference image' }))
    await screen.findByRole('button', { name: `Model: ${SEEDANCE}` })
    await submit('a slow orbit without a reference')
    await waitFor(() => expect(posted).toHaveLength(2))
    expect(posted[1]).toMatchObject({ model: SEEDANCE })
    expect(posted[1]).not.toHaveProperty('referenceImageUrl')
  })

  it('keeps an attached reference paired when Seedance is picked from the model menu', async () => {
    const { posted } = mountWith(catalog({
      video: [model(SEEDANCE, 'video'), model(SEEDANCE_I2V, 'video')],
    }, { video: SEEDANCE }))
    fireEvent.click(screen.getByRole('button', { name: 'Video' }))
    await screen.findByRole('button', { name: `Model: ${SEEDANCE}` })
    await attachReference()
    await screen.findByRole('button', { name: `Model: ${SEEDANCE_I2V}` })

    await chooseModel(SEEDANCE)
    expect(screen.getByRole('button', { name: `Model: ${SEEDANCE_I2V}` })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Remove reference image' })).not.toBeNull()

    await submit('an attached orbit')
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({
      model: SEEDANCE_I2V,
      referenceImageUrl: 'https://example.com/ref.png',
    })
  })

  it('drops an attached reference when a model without an i2v sibling is picked', async () => {
    const kling = 'kling/kling-v2-master'
    const { posted } = mountWith(catalog({
      video: [model(SEEDANCE, 'video'), model(SEEDANCE_I2V, 'video'), model(kling, 'video')],
    }, { video: SEEDANCE }))
    fireEvent.click(screen.getByRole('button', { name: 'Video' }))
    await screen.findByRole('button', { name: `Model: ${SEEDANCE}` })
    await attachReference()

    await chooseModel(kling)
    expect(screen.queryByRole('button', { name: 'Remove reference image' })).toBeNull()
    expect(screen.queryByText('Reference')).toBeNull()
    await submit('an unattached orbit')
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ model: kling })
    expect(posted[0]).not.toHaveProperty('referenceImageUrl')

    await chooseModel(SEEDANCE)
    expect(screen.getByRole('button', { name: 'Reference image' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove reference image' })).toBeNull()
  })
})

describe('StudioComposer — retained model selection', () => {
  it('keeps an unavailable image-to-video sibling paired with its attached reference', async () => {
    const first = catalog({
      video: [model(SEEDANCE, 'video'), model(SEEDANCE_I2V, 'video')],
    }, { video: SEEDANCE })
    const second = catalog({
      video: [model(SEEDANCE, 'video'), model(SEEDANCE_I2V, 'video', { status: 'unavailable' })],
    }, { video: SEEDANCE })
    const { posted, onGenerated, rerender } = mountWith((workspaceId) => workspaceId === 'ws-2' ? second : first)
    fireEvent.click(screen.getByRole('button', { name: 'Video' }))
    await screen.findByRole('button', { name: `Model: ${SEEDANCE}` })
    await attachReference()
    await screen.findByRole('button', { name: `Model: ${SEEDANCE_I2V}` })

    rerender(<StudioComposer workspaceId="ws-2" onGenerated={onGenerated} />)
    await screen.findByRole('button', { name: `Model: ${SEEDANCE_I2V} (unavailable)` })
    expect(screen.getByRole('button', { name: 'Remove reference image' })).not.toBeNull()

    const textarea = screen.getByLabelText('Prompt')
    fireEvent.change(textarea, { target: { value: 'keep the attached request safe' } })
    expect(screen.getByRole('button', { name: 'Generate' }).hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(posted).toEqual([])
  })

  it('falls back when a workspace catalog omits the retained model', async () => {
    const alternate = 'fal-ai/veo3.1'
    const first = catalog({ video: [model(SEEDANCE, 'video'), model(alternate, 'video')] }, { video: SEEDANCE })
    const second = catalog({ video: [model(SEEDANCE, 'video')] }, { video: SEEDANCE })
    const { posted, onGenerated, rerender } = mountWith((workspaceId) => workspaceId === 'ws-2' ? second : first)
    fireEvent.click(screen.getByRole('button', { name: 'Video' }))
    await screen.findByRole('button', { name: `Model: ${SEEDANCE}` })
    await chooseModel(alternate)
    await screen.findByRole('button', { name: `Model: ${alternate}` })

    rerender(<StudioComposer workspaceId="ws-2" onGenerated={onGenerated} />)
    await screen.findByRole('button', { name: `Model: ${SEEDANCE}` })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'new workspace default' } })
    expect(screen.getByRole('button', { name: 'Generate' }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ model: SEEDANCE })
  })

  it('falls back when the retained model becomes unavailable', async () => {
    const alternate = 'fal-ai/veo3.1'
    const first = catalog({ video: [model(SEEDANCE, 'video'), model(alternate, 'video')] }, { video: SEEDANCE })
    const second = catalog({
      video: [model(SEEDANCE, 'video'), model(alternate, 'video', { status: 'unavailable' })],
    }, { video: SEEDANCE })
    const { posted, onGenerated, rerender } = mountWith((workspaceId) => workspaceId === 'ws-2' ? second : first)
    fireEvent.click(screen.getByRole('button', { name: 'Video' }))
    await screen.findByRole('button', { name: `Model: ${SEEDANCE}` })
    await chooseModel(alternate)

    rerender(<StudioComposer workspaceId="ws-2" onGenerated={onGenerated} />)
    await screen.findByRole('button', { name: `Model: ${SEEDANCE}` })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'available fallback' } })
    expect(screen.getByRole('button', { name: 'Generate' }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ model: SEEDANCE })
  })
})

describe('StudioComposer — model availability', () => {
  it('auto-selects an available sibling instead of a dead default on load and lane switch', async () => {
    const deadImage = model('gpt-image-2', 'image', { status: 'unavailable' })
    const liveImage = model('openai/gpt-image-2', 'image')
    const deadVideo = model('dead-video', 'video', { status: 'unavailable' })
    const liveVideo = model('live-video', 'video')
    mountWith(catalog(
      { image: [deadImage, liveImage], video: [deadVideo, liveVideo] },
      { image: deadImage.id, video: deadVideo.id },
    ))

    await screen.findByRole('button', { name: `Model: ${liveImage.id}` })
    fireEvent.click(screen.getByRole('button', { name: 'Video' }))
    await screen.findByRole('button', { name: `Model: ${liveVideo.id}` })
    fireEvent.click(screen.getByRole('button', { name: 'Image' }))
    await screen.findByRole('button', { name: `Model: ${liveImage.id}` })
  })

  it('keeps a deliberate unavailable pick in the pill without an availability status line', async () => {
    const reason = 'This route has no provider credentials.'
    const unavailable = model('dead-video', 'video', { status: 'unavailable', reason })
    mountWith(catalog({
      video: [model('live-video', 'video'), unavailable],
    }, { video: 'live-video' }))
    fireEvent.click(screen.getByRole('button', { name: 'Video' }))
    await screen.findByRole('button', { name: 'Model: live-video' })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a disabled request' } })

    await chooseModel(unavailable.id)

    expect(screen.getByRole('button', { name: `Model: ${unavailable.id} (unavailable)` })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Generate' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText(reason)).toBeNull()
    expect(screen.queryByText('This model is not configured.')).toBeNull()
  })

  it('clears a deliberately picked unavailable model after switching lanes', async () => {
    const unavailable = model('dead-video', 'video', { status: 'unavailable' })
    const availableImage = 'openai/gpt-image-2'
    mountWith(catalog({
      image: [model(availableImage, 'image')],
      video: [model('live-video', 'video'), unavailable],
    }, { image: availableImage, video: 'live-video' }))
    fireEvent.click(screen.getByRole('button', { name: 'Video' }))
    await screen.findByRole('button', { name: 'Model: live-video' })
    await chooseModel(unavailable.id)
    await screen.findByRole('button', { name: `Model: ${unavailable.id} (unavailable)` })

    fireEvent.click(screen.getByRole('button', { name: 'Image' }))
    await screen.findByRole('button', { name: `Model: ${availableImage}` })
    fireEvent.click(screen.getByRole('button', { name: 'Video' }))
    await screen.findByRole('button', { name: 'Model: live-video' })
  })

  it('keeps unavailable and limited menu rows selectable with distinct status treatments', async () => {
    const unavailable = model('dead-video', 'video', { status: 'unavailable' })
    const limited = model('limited-video', 'video', { status: 'limited' })
    mountWith(catalog({
      video: [model('live-video', 'video'), unavailable, limited],
    }, { video: 'live-video' }))
    fireEvent.click(screen.getByRole('button', { name: 'Video' }))
    await screen.findByRole('button', { name: 'Model: live-video' })
    fireEvent.click(modelPill())
    const menu = await screen.findByRole('menu')
    const unavailableRow = within(menu).getByRole('menuitemradio', { name: /dead-videoUnavailable/ })
    const limitedRow = within(menu).getByRole('menuitemradio', { name: /limited-videolimited/ })

    expect(unavailableRow.textContent).toContain('Unavailable')
    expect((unavailableRow as HTMLButtonElement).disabled).toBe(false)
    expect(limitedRow.textContent).toContain('limited')
    expect((limitedRow as HTMLButtonElement).disabled).toBe(false)
  })

  it('replaces an unavailable Audio lane prompt with one compact derived message and recovers', async () => {
    const first = catalog({
      image: [model('gpt-image-2', 'image')],
      speech: [model('dead-speech', 'speech', { status: 'unavailable' })],
    }, { image: 'gpt-image-2', speech: 'dead-speech' })
    const second = catalog({
      image: [model('gpt-image-2', 'image')],
      speech: [model('live-speech', 'speech')],
    }, { image: 'gpt-image-2', speech: 'live-speech' })
    const { onGenerated, rerender } = mountWith((workspaceId) => workspaceId === 'ws-2' ? second : first)
    await screen.findByRole('button', { name: 'Model: gpt-image-2' })
    fireEvent.click(screen.getByRole('button', { name: 'Audio' }))

    await screen.findByText('Audio models are temporarily unavailable')
    expect(screen.queryByLabelText('Prompt')).toBeNull()
    expect(screen.getByRole('button', { name: 'Generate' }).hasAttribute('disabled')).toBe(true)

    rerender(<StudioComposer workspaceId="ws-2" onGenerated={onGenerated} />)
    await screen.findByRole('button', { name: 'Model: live-speech' })
    expect(screen.queryByText('Audio models are temporarily unavailable')).toBeNull()
    expect(screen.getByLabelText('Prompt')).not.toBeNull()
  })

  it('describes an empty Audio lane without claiming a temporary outage', async () => {
    mountWith(catalog({
      image: [model('gpt-image-2', 'image')],
      speech: [],
    }, { image: 'gpt-image-2' }))
    await screen.findByRole('button', { name: 'Model: gpt-image-2' })
    fireEvent.click(screen.getByRole('button', { name: 'Audio' }))

    await screen.findByText('No audio models are available')
    expect(screen.queryByLabelText('Prompt')).toBeNull()
    expect(screen.getByRole('button', { name: 'Generate' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('StudioComposer — image lane', () => {
  it('offers only gpt-image-2 and validates a custom size next to the field', async () => {
    mountWith(catalog({
      image: [model('gpt-image-2', 'image'), model('imagen-4', 'image')],
    }, { image: 'gpt-image-2' }))
    await screen.findByRole('button', { name: 'Model: gpt-image-2' })

    fireEvent.click(modelPill())
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitemradio').map((row) => row.textContent)).toEqual(['gpt-image-2'])
    fireEvent.keyDown(document, { key: 'Escape' })

    await openPill('Size')
    fireEvent.click(screen.getByRole('button', { name: 'Custom…' }))
    fireEvent.change(screen.getByLabelText('Custom width'), { target: { value: '1000' } })
    fireEvent.change(screen.getByLabelText('Custom height'), { target: { value: '1000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(screen.getByText('Each side must be a multiple of 16.')).not.toBeNull()

    fireEvent.change(screen.getByLabelText('Custom width'), { target: { value: '1920' } })
    fireEvent.change(screen.getByLabelText('Custom height'), { target: { value: '1088' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await screen.findByRole('button', { name: 'Size: 1920×1088 · custom' })
  })
})

describe('StudioComposer — audio lane', () => {
  it('shows only the voices a model actually publishes', async () => {
    mountWith(catalog({
      speech: [model('tts-1', 'speech'), model('gemini-2.5-flash-preview-tts', 'speech'), model('voxtral-mini', 'speech')],
    }, { speech: 'tts-1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Audio' }))
    await screen.findByRole('button', { name: 'Model: tts-1' })

    expect(within(await openPill('Voice')).getAllByRole('menuitemradio')).toHaveLength(9)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(pill('Speed')).not.toBeNull()

    // Google's TTS takes six router-translated aliases and no speed at all.
    await chooseModel('gemini-2.5-flash-preview-tts')
    expect(within(await openPill('Voice')).getAllByRole('menuitemradio')).toHaveLength(6)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(pill('Speed')).toBeNull()

    // Mistral publishes no enumerable voice list, so nothing is offered — the
    // provider's own default applies rather than an invented one.
    await chooseModel('voxtral-mini')
    expect(pill('Voice')).toBeNull()
    expect(pill('Speed')).toBeNull()
  })
})

describe('StudioComposer — submitting', () => {
  it('gates on a prompt, sends on Enter, and keeps every value wire-exact', async () => {
    const { posted } = mountWith(catalog({
      video: [
        model('kling/kling-v1-6', 'video'),
        model('fal-ai/veo3.1', 'video'),
        model('fal-ai/kling-video/v3/pro/text-to-video', 'video'),
      ],
    }, { video: 'kling/kling-v1-6' }))
    fireEvent.click(screen.getByRole('button', { name: 'Video' }))
    await screen.findByRole('button', { name: 'Model: kling/kling-v1-6' })

    expect(screen.getByRole('button', { name: 'Generate' }).hasAttribute('disabled')).toBe(true)

    // kling publishes NUMBERS.
    await submit('a launch teaser')
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]?.duration).toBe(5)

    // veo publishes the 's' suffix as part of the value.
    await chooseModel('fal-ai/veo3.1')
    await screen.findByRole('button', { name: 'Duration: 8s' })
    await submit('a launch teaser')
    await waitFor(() => expect(posted).toHaveLength(2))
    expect(posted[1]?.duration).toBe('8s')

    // fal's kling v3 publishes the same seconds as STRINGS.
    await chooseModel('fal-ai/kling-video/v3/pro/text-to-video')
    await screen.findByRole('button', { name: 'Duration: 5s' })
    await submit('a launch teaser')
    await waitFor(() => expect(posted).toHaveLength(3))
    expect(posted[2]?.duration).toBe('5')
    expect(typeof posted[2]?.duration).toBe('string')

    // kling v1-6's `resolution` and `audio` are `supported: false` — not merely
    // hidden, but absent from the wire; `mode`, which it does publish, is there.
    expect(posted[0]).toMatchObject({ mode: 'std', aspectRatio: '16:9' })
    expect(posted[0]).not.toHaveProperty('resolution')
    expect(posted[0]).not.toHaveProperty('audio')
  })

  it('offers no negative prompt and no free-text voice field', async () => {
    mountWith(catalog({ speech: [model('tts-1', 'speech')] }, { speech: 'tts-1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Audio' }))
    await screen.findByRole('button', { name: 'Model: tts-1' })

    expect(screen.queryByLabelText(/negative/i)).toBeNull()
    // The prompt is the only free-text field on the card: a voice is picked
    // from the model's published list, never typed.
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
  })

  it('puts every PILL_ORDER parameter rendered for every lane onto the wire', async () => {
    const image = model('gpt-image-2', 'image', {
      options: allPillOptions({
        size: { values: ['1024x1024'], default: '1024x1024' },
        quality: { values: ['high'], default: 'high' },
        n: { values: [2], default: 2 },
      }),
    })
    const video = model('all-params-video', 'video', {
      options: allPillOptions({
        duration: { values: ['5'], default: '5' },
        resolution: { values: ['1080p'], default: '1080p' },
        aspect_ratio: { values: ['16:9'], default: '16:9' },
        mode: { values: ['pro'], default: 'pro' },
      }),
    })
    const speech = model('all-params-speech', 'speech', {
      options: allPillOptions({
        voice: { values: ['alloy'], default: 'alloy' },
        speed: { values: [1.25], default: 1.25 },
      }),
    })
    const { posted } = mountWith(catalog(
      { image: [image], video: [video], speech: [speech] },
      { image: image.id, video: video.id, speech: speech.id },
    ))
    const wireFieldByPill: Record<string, string> = {
      Size: 'size',
      Quality: 'quality',
      Count: 'n',
      Duration: 'duration',
      Resolution: 'resolution',
      Aspect: 'aspectRatio',
      Mode: 'mode',
      Voice: 'voice',
      Speed: 'speed',
    }

    for (const [lane, modelId] of [
      ['Image', image.id],
      ['Video', video.id],
      ['Audio', speech.id],
    ] as const) {
      if (lane !== 'Image') fireEvent.click(screen.getByRole('button', { name: lane }))
      await screen.findByRole('button', { name: `Model: ${modelId}` })

      const optionPills = Array.from(document.querySelectorAll<HTMLButtonElement>(
        '.studio-band button[title]:not([title="Model"]):not([title="Audio"])',
      ))
      for (const optionPill of optionPills) {
        const svgs = optionPill.querySelectorAll('svg')
        const label = optionPill.querySelector('span')
        expect(svgs).toHaveLength(2)
        const leadingIcon = svgs.item(0)
        if (!leadingIcon || !label) throw new Error(`${optionPill.title} trigger is missing its icon or label`)
        expect(leadingIcon.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
      }

      await submit(`all ${lane.toLowerCase()} parameters`)
      await waitFor(() => expect(posted).toHaveLength(lane === 'Image' ? 1 : lane === 'Video' ? 2 : 3))

      const body = posted.at(-1) ?? {}
      for (const optionPill of optionPills) {
        const label = optionPill.title
        const wireField = wireFieldByPill[label]
        if (!wireField) throw new Error(`${label} has no request-body mapping`)
        expect(body, `${label} did not reach ${wireField}`).toHaveProperty(wireField)
      }
    }
  })
})
