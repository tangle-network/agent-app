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
import type { GenerationType, MediaModelCatalogResponse, MediaModelOption } from '../studio'
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

/** The two endpoints the composer talks to. Returns the bodies POSTed to
 *  `/api/generate`, so a test can assert the exact wire payload. */
function mountWith(response: MediaModelCatalogResponse, props: Record<string, unknown> = {}) {
  const posted: Array<Record<string, unknown>> = []
  const fetchMock = vi.fn(async (input: unknown, init?: { body?: string }) => {
    const url = String(input)
    if (url.startsWith('/api/media-models')) {
      return { ok: true, json: async () => response } as unknown as Response
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
  render(<StudioComposer workspaceId="ws-1" onGenerated={onGenerated} {...props} />)
  return { posted, onGenerated }
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

const SEEDANCE = 'bytedance/seedance-2.0/text-to-video'
const SEEDANCE_I2V = 'bytedance/seedance-2.0/image-to-video'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('StudioComposer — the pills are the model’s own parameters', () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Reference image' }))
    fireEvent.change(await screen.findByLabelText('Reference image URL'), {
      target: { value: 'https://example.com/ref.png' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))

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
})
