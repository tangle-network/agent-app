import type { ReactNode } from 'react'

import type { Generation, MediaModelCatalogResponse, MediaModelOption } from '../../studio'
import type { StudioMediaActions } from '../../studio/ports'
import { StudioPlaybackProvider } from '../../studio-react/studio-playback'
import { StudioToastProvider } from '../../studio-react/studio-toasts'
import { demoVaultHref } from './fixtures'

export function StudioProviders({ children }: { children: ReactNode }) {
  return (
    <StudioToastProvider>
      <StudioPlaybackProvider>{children}</StudioPlaybackProvider>
    </StudioToastProvider>
  )
}

export const storyMediaActions: StudioMediaActions = {
  download: (generations) => console.log('download', generations.map(({ id }) => id)),
  save: async ({ generations, path }) => generations.map(({ id }) => ({
    generationId: id,
    vaultPath: `${path}/${id}`,
  })),
  remove: async (ids) => console.log('remove', ids),
  vaultHref: demoVaultHref,
  onOpenVault: (generation) => console.log('open vault', generation.id),
}

const imageModel: MediaModelOption = {
  id: 'gpt-image-2',
  name: 'GPT Image 2',
  provider: 'openai',
  type: 'image',
  status: 'available',
}

const catalog: MediaModelCatalogResponse = {
  defaults: {
    image: imageModel.id,
    video: '',
    speech: '',
    avatar: '',
    transcription: '',
  },
  models: {
    image: [imageModel],
    video: [],
    speech: [],
    avatar: [],
    transcription: [],
  },
}

let fetchStubInstalled = false

/** Composer screens need their model catalog without pretending generation works. */
export function installStudioComposerFetchStub(): void {
  if (fetchStubInstalled || typeof window === 'undefined') return
  fetchStubInstalled = true
  const original = window.fetch.bind(window)
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('/api/media-models')) return Promise.resolve(json(catalog))
    if (url.startsWith('/api/generate')) {
      return Promise.resolve(json({ error: 'Storybook has no generation backend.' }, 501))
    }
    return original(input, init)
  }) as typeof window.fetch
}

export const noOpGenerated = (generation: Generation) => console.log('generated', generation.id)

