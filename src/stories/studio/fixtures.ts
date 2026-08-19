import type { Generation } from '../../studio'

/**
 * Studio fixtures. Generations are plain loader rows — `metadata.generationStatus`
 * drives the status badges (without it the components infer from `result`), and
 * `metadata.vaultPath` gates the "Open in Vault" affordance. Media `result`s are
 * inline SVG data URIs so stories never hit the network; video/audio point at
 * non-existent paths on purpose (the tile chrome still renders, nothing loads).
 */

/** Small gradient tile as a data URI — stands in for a generated image. */
function svgTile(from: string, to: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><text x="32" y="330" font-family="monospace" font-size="22" fill="rgba(255,255,255,0.85)">${label}</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const POSTER_TILE = svgTile('#7c3aed', '#1d4ed8', 'launch-poster.png')
const STORYBOARD_TILE = svgTile('#0ea5e9', '#111827', 'storyboard-frame.png')
const TEASER_TILE_A = svgTile('#f59e0b', '#92400e', 'teaser-a.png')
const TEASER_TILE_B = svgTile('#10b981', '#064e3b', 'teaser-b.png')
const TEASER_TILE_C = svgTile('#ec4899', '#831843', 'teaser-c.png')
const TEASER_TILE_D = svgTile('#8b5cf6', '#312e81', 'teaser-d.png')

/** Base row: a succeeded image that persisted to the vault. Mirrors the
 *  `makeGeneration` factory in studio-react/generation-detail.test.tsx. */
function makeGeneration(overrides: Partial<Generation> = {}): Generation {
  return {
    id: 'gen-poster',
    type: 'image',
    prompt: 'A vertical hero frame for a product launch teaser — dark cinematic lighting, sleek studio aesthetic.',
    result: POSTER_TILE,
    model: 'tangle-image-large',
    cost: 0.012,
    createdAt: new Date('2026-07-30T14:12:00Z'),
    metadata: { generationStatus: 'succeeded', vaultPath: 'generated/images/launch-poster.png' },
    ...overrides,
  }
}

// The two newest images share a clientRequestId so `latestBatchOf` groups them
// into a 2-up batch on the result canvas / full workspace.
export const teaserA = makeGeneration({
  id: 'gen-teaser-a',
  prompt: 'A 6-second vertical launch teaser: animated product reveal, dynamic camera move, frame A.',
  result: TEASER_TILE_A,
  createdAt: new Date('2026-08-03T09:40:00Z'),
  metadata: {
    generationStatus: 'succeeded',
    vaultPath: 'generated/images/teaser-a.png',
    clientRequestId: 'req-launch-teaser',
    outputIndex: 0,
    outputCount: 2,
  },
})

const teaserB = makeGeneration({
  id: 'gen-teaser-b',
  prompt: 'A 6-second vertical launch teaser: animated product reveal, dynamic camera move, frame B.',
  result: TEASER_TILE_B,
  createdAt: new Date('2026-08-03T09:40:00Z'),
  metadata: {
    generationStatus: 'succeeded',
    vaultPath: 'generated/images/teaser-b.png',
    clientRequestId: 'req-launch-teaser',
    outputIndex: 1,
    outputCount: 2,
  },
})

export const storyboardGeneration = makeGeneration({
  id: 'gen-storyboard',
  prompt: 'A vertical storyboard frame for a product launch teaser, 9:16 composition, ink-and-marker style.',
  result: STORYBOARD_TILE,
  model: 'tangle-image-standard',
  cost: 0.008,
  createdAt: new Date('2026-08-01T16:02:00Z'),
  metadata: { generationStatus: 'succeeded', vaultPath: 'generated/images/storyboard-frame.png' },
})

export const videoGeneration = makeGeneration({
  id: 'gen-video',
  type: 'video',
  prompt: 'A 6-second vertical launch teaser: animated product reveal, dynamic camera move, hero music swell.',
  result: '/fixtures/launch-teaser.mp4',
  model: 'tangle-video-hd',
  cost: 0.42,
  createdAt: new Date('2026-08-02T11:24:00Z'),
  metadata: { generationStatus: 'succeeded', vaultPath: 'generated/videos/launch-teaser.mp4' },
})

// Avatar generations genuinely carry an empty prompt — the composer hides the
// prompt field for the avatar type and never surfaces the source audio URL.
export const avatarGeneration = makeGeneration({
  id: 'gen-avatar',
  type: 'avatar',
  prompt: '',
  result: '/fixtures/talking-avatar.mp4',
  model: 'tangle-avatar-v2',
  cost: 0.31,
  createdAt: new Date('2026-08-02T15:48:00Z'),
  metadata: { generationStatus: 'succeeded', vaultPath: 'generated/avatars/talking-avatar.mp4' },
})

export const speechGeneration = makeGeneration({
  id: 'gen-speech',
  type: 'speech',
  prompt: 'A confident 12-second scratch voiceover for a product launch teaser: warm tone, conversational pace.',
  result: '/fixtures/scratch-voiceover.mp3',
  model: 'tangle-tts-1',
  cost: 0.004,
  createdAt: new Date('2026-08-01T10:15:00Z'),
  metadata: { generationStatus: 'succeeded', vaultPath: 'generated/audio/scratch-voiceover.mp3' },
})

const TRANSCRIPT_TEXT = [
  '[00:00:00] Drew: Welcome to the launch rehearsal. Quick run-through of the teaser beats.',
  '[00:00:07] Priya: Beat one is the product reveal — slow push-in, then the logo bloom.',
  '[00:00:15] Drew: Note for edit: the hero music swell lands a half-second late.',
  '[00:00:23] Priya: Agreed. Beat three needs the caption card to hold for two full seconds.',
  '[00:00:31] Drew: That’s a wrap on dailies — cut list goes to the vault tonight.',
].join('\n')

export const transcriptionGeneration = makeGeneration({
  id: 'gen-transcription',
  type: 'transcription',
  prompt: 'Dailies recording with timestamps and speaker labels.',
  result: TRANSCRIPT_TEXT,
  model: 'tangle-whisper-large',
  cost: 0.006,
  createdAt: new Date('2026-07-31T18:30:00Z'),
  metadata: { generationStatus: 'succeeded', vaultPath: 'generated/transcripts/dailies.txt' },
})

export const queuedGeneration = makeGeneration({
  id: 'local-req-wait-0',
  type: 'image',
  prompt: 'A minimal icon set for the approvals queue, line style, four variations.',
  result: null,
  model: 'tangle-image-large',
  cost: null,
  createdAt: new Date('2026-08-04T17:58:00Z'),
  metadata: { generationStatus: 'pending', provider: 'image', clientRequestId: 'req-wait' },
})

export const runningGeneration = makeGeneration({
  id: 'gen-running',
  type: 'video',
  prompt: 'Slow orbit around the product on a mirrored plinth, studio softbox lighting.',
  result: null,
  model: 'tangle-video-hd',
  cost: null,
  createdAt: new Date('2026-08-04T17:55:00Z'),
  metadata: { generationStatus: 'running', provider: 'video', clientRequestId: 'req-orbit' },
})

export const failedGeneration = makeGeneration({
  id: 'gen-failed',
  type: 'image',
  prompt: 'An isometric cutaway of the relay architecture, annotated, technical illustration.',
  result: null,
  model: 'tangle-image-large',
  cost: null,
  createdAt: new Date('2026-08-03T13:05:00Z'),
  metadata: {
    generationStatus: 'failed',
    providerError: 'Provider rate limit exceeded — retry in a few minutes.',
  },
})

// Media generated fine but never landed in the vault: `generationVaultPath` is
// null, so the detail view must NOT render an "Open in Vault" button.
export const storageFailedGeneration = makeGeneration({
  id: 'gen-storage-failed',
  metadata: {
    generationStatus: 'succeeded',
    storageStatus: 'failed',
    storageError: 'Generated image was created, but could not be saved to Vault.',
  },
})

/** The four-image batch a single "Images: 4" run produces. */
export const teaserBatch: Generation[] = [
  makeGeneration({
    id: 'gen-batch-a',
    prompt: 'Launch teaser keyframe, variant A.',
    result: TEASER_TILE_A,
    metadata: { generationStatus: 'succeeded', clientRequestId: 'req-batch', outputIndex: 0, outputCount: 4 },
  }),
  makeGeneration({
    id: 'gen-batch-b',
    prompt: 'Launch teaser keyframe, variant B.',
    result: TEASER_TILE_B,
    metadata: { generationStatus: 'succeeded', clientRequestId: 'req-batch', outputIndex: 1, outputCount: 4 },
  }),
  makeGeneration({
    id: 'gen-batch-c',
    prompt: 'Launch teaser keyframe, variant C.',
    result: TEASER_TILE_C,
    metadata: { generationStatus: 'succeeded', clientRequestId: 'req-batch', outputIndex: 2, outputCount: 4 },
  }),
  makeGeneration({
    id: 'gen-batch-d',
    prompt: 'Launch teaser keyframe, variant D.',
    result: TEASER_TILE_D,
    metadata: { generationStatus: 'succeeded', clientRequestId: 'req-batch', outputIndex: 3, outputCount: 4 },
  }),
]

/** Populated library: the newest batch first, every type and status represented. */
export const libraryGenerations: Generation[] = [
  teaserA,
  teaserB,
  videoGeneration,
  runningGeneration,
  avatarGeneration,
  speechGeneration,
  storyboardGeneration,
  transcriptionGeneration,
  failedGeneration,
]

export const libraryTotalCost = 1.87

/** Mirrors StudioWorkspace's default vaultHref (see generation-detail.test.tsx). */
export const demoVaultHref = (filePath?: string | null) =>
  filePath ? `/app/ws-demo/vault?file=${encodeURIComponent(filePath)}` : '/app/ws-demo/vault'
