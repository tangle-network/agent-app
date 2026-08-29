/**
 * Realistic fixtures for each surface — populated enough that the canvas, layers
 * panel, toolbar, rulers, timeline tracks, and chat thread all render with real
 * content rather than an empty shell.
 */

import type { SceneDocument } from '@tangle-network/agent-app/design-canvas'
import type { Generation } from '@tangle-network/agent-app/studio'
import type {
  SequenceTimeline,
  SequenceTrack,
  SequenceClip,
} from '@tangle-network/agent-app/sequences'
import type { VideoFrameProvider } from '@tangle-network/agent-app/sequences-react'
import type {
  CatalogModel,
  ChatUiMessage,
  RecordGridColumn,
  RecordGridRow,
} from '@tangle-network/agent-app/web-react'
import type { SessionSummary } from '@tangle-network/agent-app/session-shell'

// ── /canvas — multi-element SceneDocument ─────────────────────────────────────

export function makeSceneDocument(): SceneDocument {
  return {
    schemaVersion: 1,
    title: 'Launch poster',
    pages: [
      {
        id: 'page-1',
        name: 'Square',
        width: 1080,
        height: 1080,
        background: '#0f172a',
        bleed: null,
        guides: { vertical: [540], horizontal: [540] },
        elements: [
          {
            id: 'el-bg',
            kind: 'rect',
            name: 'Panel',
            x: 80,
            y: 80,
            rotation: 0,
            opacity: 1,
            locked: false,
            visible: true,
            width: 920,
            height: 920,
            fill: '#1e293b',
            cornerRadius: 32,
          },
          {
            id: 'el-accent',
            kind: 'rect',
            name: 'Accent bar',
            x: 140,
            y: 160,
            rotation: 0,
            opacity: 1,
            locked: false,
            visible: true,
            width: 220,
            height: 24,
            fill: '#3b82f6',
            cornerRadius: 12,
          },
          {
            id: 'el-ellipse',
            kind: 'ellipse',
            name: 'Glow',
            x: 640,
            y: 220,
            rotation: 0,
            opacity: 0.85,
            locked: false,
            visible: true,
            width: 280,
            height: 280,
            fill: '#f59e0b',
          },
          {
            id: 'el-title',
            kind: 'text',
            name: 'Headline',
            x: 140,
            y: 240,
            rotation: 0,
            opacity: 1,
            locked: false,
            visible: true,
            text: 'Ship the agent.',
            width: 760,
            fontFamily: 'Inter',
            fontSize: 96,
            fontStyle: 'bold',
            fill: '#f8fafc',
            align: 'left',
            lineHeight: 1.1,
            letterSpacing: 0,
          },
          {
            id: 'el-sub',
            kind: 'text',
            name: 'Subhead',
            x: 140,
            y: 420,
            rotation: 0,
            opacity: 1,
            locked: false,
            visible: true,
            text: 'A visual audit playground for agent-app surfaces.',
            width: 700,
            fontFamily: 'Inter',
            fontSize: 36,
            fontStyle: 'normal',
            fill: '#94a3b8',
            align: 'left',
            lineHeight: 1.3,
            letterSpacing: 0,
          },
          {
            id: 'el-line',
            kind: 'line',
            name: 'Underline',
            x: 140,
            y: 560,
            rotation: 0,
            opacity: 1,
            locked: false,
            visible: true,
            points: [0, 0, 640, 0],
            stroke: '#3b82f6',
            strokeWidth: 6,
          },
          {
            id: 'el-chip',
            kind: 'rect',
            name: 'CTA chip',
            x: 140,
            y: 700,
            rotation: 0,
            opacity: 1,
            locked: false,
            visible: true,
            width: 300,
            height: 96,
            fill: '#3b82f6',
            cornerRadius: 48,
          },
          {
            id: 'el-rotated',
            kind: 'rect',
            name: 'Badge',
            x: 760,
            y: 720,
            rotation: 18,
            opacity: 1,
            locked: false,
            visible: true,
            width: 160,
            height: 160,
            fill: '#22c55e',
            cornerRadius: 24,
          },
        ],
      },
    ],
    settings: { dpi: 96 },
    metadata: {},
  }
}

// ── /timeline — video track + caption track ───────────────────────────────────

export function makeTimeline(): SequenceTimeline {
  const fps = 30
  const durationFrames = 600 // 20s
  const tracks: SequenceTrack[] = [
    { id: 'track-video', kind: 'video', name: 'Video', sortOrder: 0, locked: false, muted: false, metadata: {} },
    { id: 'track-caption', kind: 'caption', name: 'Captions', sortOrder: 1, locked: false, muted: false, metadata: {} },
  ]
  const clips: SequenceClip[] = [
    {
      id: 'clip-intro',
      trackId: 'track-video',
      label: 'intro.mp4',
      startFrame: 0,
      durationFrames: 180,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      media: { url: 'https://example.com/intro.mp4', kind: 'video', durationSeconds: 6 },
      metadata: {},
    },
    {
      id: 'clip-demo',
      trackId: 'track-video',
      label: 'demo.mp4',
      startFrame: 190,
      durationFrames: 240,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      media: { url: 'https://example.com/demo.mp4', kind: 'video', durationSeconds: 8 },
      metadata: {},
    },
    {
      id: 'clip-outro',
      trackId: 'track-video',
      label: 'outro.mp4',
      startFrame: 440,
      durationFrames: 150,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      media: { url: 'https://example.com/outro.mp4', kind: 'video', durationSeconds: 5 },
      metadata: {},
    },
    {
      id: 'cap-1',
      trackId: 'track-caption',
      label: 'Caption 1',
      startFrame: 10,
      durationFrames: 150,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      text: 'Meet the agent playground',
      language: 'en',
      metadata: {},
    },
    {
      id: 'cap-2',
      trackId: 'track-caption',
      label: 'Caption 2',
      startFrame: 200,
      durationFrames: 200,
      sourceInFrame: 0,
      sourceOutFrame: null,
      disabled: false,
      text: 'Audit every surface, light and dark',
      language: 'en',
      metadata: {},
    },
  ]
  return {
    sequence: {
      id: 'seq-1',
      title: 'Playground reel',
      fps,
      width: 1920,
      height: 1080,
      aspectRatio: '16:9',
      durationFrames,
      status: 'active',
      metadata: {},
    },
    tracks,
    clips,
  }
}

/**
 * Simplest valid `VideoFrameProvider`: paints a deterministic solid color into
 * the preview rect. No media decode — `drawFrame` never touches network or
 * <video>/<img>, so the preview monitor renders something real without any
 * media pipeline. The color cycles by second so scrubbing is visibly distinct.
 */
export function makeSolidFrameProvider(): VideoFrameProvider {
  const palette = ['#1e293b', '#3b82f6', '#f59e0b', '#22c55e', '#ef4444', '#a855f7']
  return {
    async drawFrame(mediaUrl, sourceSeconds, ctx, rect) {
      const color = palette[Math.floor(sourceSeconds) % palette.length] ?? '#1e293b'
      ctx.fillStyle = color
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
      ctx.fillStyle = 'rgba(255,255,255,0.7)'
      ctx.font = `${Math.max(12, Math.round(rect.height / 12))}px sans-serif`
      ctx.fillText(
        `${mediaUrl.split('/').pop()} @ ${sourceSeconds.toFixed(1)}s`,
        rect.x + 12,
        rect.y + rect.height / 2,
      )
    },
    prefetch() {
      /* no-op: nothing to warm for a solid-color provider */
    },
    dispose() {
      /* no-op: no pooled resources */
    },
  }
}

// ── /chat — model catalog + conversation ──────────────────────────────────────

export function makeModels(): CatalogModel[] {
  return [
    {
      id: 'anthropic/claude-opus-4',
      name: 'Claude Opus 4',
      provider: 'anthropic',
      description: 'Most capable Anthropic model',
      contextLength: 1_000_000,
      pricing: { prompt: '0.000015', completion: '0.000075' },
      supportsTools: true,
      supportsReasoning: true,
      featured: true,
    },
    {
      id: 'openai/gpt-5',
      name: 'GPT-5',
      provider: 'openai',
      description: 'OpenAI flagship',
      contextLength: 400_000,
      pricing: { prompt: '0.00001', completion: '0.00003' },
      supportsTools: true,
      supportsReasoning: true,
      featured: true,
    },
    {
      id: 'anthropic/claude-haiku-4',
      name: 'Claude Haiku 4',
      provider: 'anthropic',
      contextLength: 200_000,
      pricing: { prompt: '0.000001', completion: '0.000005' },
      supportsTools: true,
      supportsReasoning: false,
      featured: false,
    },
    {
      id: 'google/gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      provider: 'google',
      contextLength: 2_000_000,
      pricing: { prompt: '0.0000025', completion: '0.00001' },
      supportsTools: true,
      supportsReasoning: true,
      featured: false,
    },
    {
      id: 'deepseek/deepseek-chat',
      name: 'DeepSeek Chat',
      provider: 'deepseek',
      contextLength: 128_000,
      pricing: { prompt: '0.00000027', completion: '0.0000011' },
      supportsTools: false,
      supportsReasoning: false,
      featured: false,
    },
  ]
}

// ── /records — session history rows + a provenance-cited record grid ──────────

export function makeSessions(): SessionSummary[] {
  return [
    { id: 's1', title: 'Q3 model routing plan', updatedAt: '2026-08-05T14:00:00.000Z' },
    { id: 's2', title: 'Vendor contract review', updatedAt: '2026-08-04T09:30:00.000Z', unread: true },
    { id: 's3', title: 'Cap table cleanup', updatedAt: '2026-08-01T18:15:00.000Z' },
    { id: 's4', title: 'Onboarding checklist', updatedAt: '2026-07-29T11:05:00.000Z' },
  ]
}

export const RECORD_GRID_COLUMNS: RecordGridColumn[] = [
  { id: 'holder', kind: 'text', header: 'Holder', required: true },
  { id: 'shares', kind: 'number', header: 'Shares', integer: true, min: 1 },
  { id: 'class', kind: 'text', header: 'Class' },
]

export function makeRecordGridRows(): RecordGridRow[] {
  return [
    {
      id: 'r1',
      values: { holder: 'Jane Doe', shares: 100000, class: 'Common' },
      sources: {
        shares: {
          quote: 'Jane Doe — 100,000 shares of Common Stock',
          label: 'stock-purchase-agreement.pdf',
          locator: 'p.3',
          href: 'https://vault/spa.pdf',
          basis: 'extracted',
        },
      },
    },
    {
      id: 'r2',
      values: { holder: 'Acme Ventures', shares: 250000, class: 'Preferred' },
      sources: {
        shares: {
          quote: 'Acme Ventures — 250,000 shares of Series A Preferred',
          label: 'series-a-purchase-agreement.pdf',
          locator: 'p.7',
          href: 'https://vault/series-a.pdf',
          basis: 'extracted',
        },
      },
    },
  ]
}

export function makeMessages(): ChatUiMessage[] {
  return [
    {
      id: 'm1',
      role: 'user',
      content: 'Render the launch poster and queue it for review.',
    },
    {
      id: 'm2',
      role: 'assistant',
      content:
        'On it. I rendered the poster from the current scene and submitted it for approval. Here is what I ran:',
      reasoning:
        'The user wants a render + an approval gate. I will call the canvas export tool, then submit_proposal so a human signs off before anything publishes.',
      modelUsed: 'anthropic/claude-opus-4',
      promptTokens: 1820,
      completionTokens: 340,
      durationMs: 4200,
      toolCalls: [
        {
          id: 'tc-shell',
          name: 'sandbox_run_command',
          status: 'done',
          args: { command: 'render --page page-1 --format png' },
          result: { ok: true, result: { stdout: 'Rendered page-1 → out/poster.png (1080x1080)', exitCode: 0 } },
        },
        {
          id: 'tc-proposal',
          name: 'submit_proposal',
          status: 'done',
          args: { type: 'asset_publish', title: 'Launch poster' },
          result: { ok: true, result: { status: 'queued_for_approval', proposalId: 'prop-42' } },
        },
      ],
    },
    {
      id: 'm3',
      role: 'user',
      content: 'Also schedule a follow-up to post it on Monday.',
    },
    {
      id: 'm4',
      role: 'assistant',
      content: 'I tried to schedule the follow-up but the scheduler rejected the request.',
      modelUsed: 'anthropic/claude-opus-4',
      promptTokens: 2100,
      completionTokens: 90,
      durationMs: 1800,
      toolCalls: [
        {
          id: 'tc-followup',
          name: 'schedule_followup',
          status: 'error',
          args: { title: 'Post launch poster', when: '2026-06-22T09:00:00Z' },
          result: { ok: false, message: 'scheduler unavailable: upstream 503' },
        },
      ],
    },
  ]
}

// ── /studio — a mixed media library (tiles, viewer, vault state) ──────────────

/**
 * Media has to be REAL bytes here, not a remote URL: the audits run against a
 * local dev server with no network, and a tile whose `<img>` never decodes
 * renders as the empty `bg-accent` box — which is also what a broken tile looks
 * like, so a visual pass could not tell the two apart.
 */
function gradientImage(hue: number, ratio: number): string {
  const width = 800
  const height = Math.round(width / ratio)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    `<stop offset="0%" stop-color="hsl(${hue} 74% 62%)"/>` +
    `<stop offset="100%" stop-color="hsl(${(hue + 58) % 360} 66% 34%)"/>` +
    '</linearGradient></defs>' +
    `<rect width="${width}" height="${height}" fill="url(#g)"/>` +
    `<circle cx="${width * 0.68}" cy="${height * 0.34}" r="${height * 0.22}" fill="#fff" opacity="0.16"/>` +
    `<circle cx="${width * 0.28}" cy="${height * 0.72}" r="${height * 0.3}" fill="#000" opacity="0.14"/>` +
    '</svg>'
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/**
 * A decoding audio source, so the viewer's transport is exercised for real —
 * duration, elapsed clock, seek, and the waveform's played layer all read from
 * a live `HTMLAudioElement`, and a fixture that never loads would leave every
 * one of them at `--:--` while still looking deliberate.
 *
 * 8-bit mono PCM at 8 kHz: a decaying 220 Hz tone under a slow swell, which is
 * enough shape that a scrub audibly changes what you hear.
 */
function toneWav(seconds: number): string {
  const rate = 8000
  const sampleCount = Math.floor(rate * seconds)
  const bytes = new Uint8Array(44 + sampleCount)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + sampleCount, true)
  ascii(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate, true)
  view.setUint16(32, 1, true)
  view.setUint16(34, 8, true)
  ascii(36, 'data')
  view.setUint32(40, sampleCount, true)
  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / rate
    const swell = Math.sin((Math.PI * i) / sampleCount)
    bytes[44 + i] = 128 + Math.round(96 * swell * Math.exp(-t * 0.35) * Math.sin(2 * Math.PI * 220 * t))
  }
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:audio/wav;base64,${btoa(binary)}`
}

const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000)

/**
 * A dozen rows covering every state a tile has to render: images at three
 * aspect ratios, videos, one speech row with its own waveform and transport,
 * one still running (`result: null` → the shimmer skeleton), and four already
 * saved into the vault — the pair that matters most here, because an in-vault
 * row shows the "In vault" chip and a link OUT to it while a Studio-only row
 * shows the save-to-vault popover instead.
 *
 * The `<video>` rows carry a source that will not decode offline; their frame
 * stays empty on purpose and the tile chrome (play badge, scrim, hover
 * actions) is what they are here to exercise.
 */
export function makeStudioGenerations(): Generation[] {
  return [
    {
      id: 'gen-01',
      type: 'image',
      prompt: 'Product hero on a matte concrete plinth, soft rim light',
      result: gradientImage(258, 1),
      model: 'black-forest-labs/flux-1.1-pro',
      cost: 0.04,
      createdAt: minutesAgo(6),
      metadata: { size: '1024x1024' },
    },
    {
      id: 'gen-02',
      type: 'image',
      prompt: 'Same hero, top-down on brushed steel',
      result: gradientImage(198, 1),
      model: 'black-forest-labs/flux-1.1-pro',
      cost: 0.04,
      createdAt: minutesAgo(6),
      metadata: { size: '1024x1024', vaultPath: 'generated/images' },
    },
    {
      id: 'gen-03',
      type: 'video',
      prompt: 'Slow orbit around the packaging, shallow depth of field',
      result: '/fixtures/orbit.mp4',
      model: 'luma/ray-2',
      cost: 0.62,
      createdAt: minutesAgo(24),
      metadata: { resolution: '1080p', aspectRatio: '16:9', duration: '5s' },
    },
    {
      id: 'gen-04',
      type: 'speech',
      prompt: 'Launch voice-over: "Built for the work you already do."',
      result: toneWav(9),
      model: 'elevenlabs/eleven-v3',
      cost: 0.01,
      createdAt: minutesAgo(31),
      metadata: { voice: 'Aria', durationSeconds: 9 },
    },
    {
      id: 'gen-05',
      type: 'image',
      prompt: 'Wide banner: the team at the workshop bench, late afternoon',
      result: gradientImage(28, 16 / 9),
      model: 'openai/gpt-image-1',
      cost: 0.07,
      createdAt: minutesAgo(48),
      metadata: { size: '1792x1024', vaultPath: 'generated/images/banners' },
    },
    {
      id: 'gen-06',
      type: 'image',
      prompt: 'Portrait crop of the founder for the about page',
      result: gradientImage(342, 3 / 4),
      model: 'openai/gpt-image-1',
      cost: 0.07,
      createdAt: minutesAgo(52),
      metadata: { size: '768x1024' },
    },
    {
      id: 'gen-07',
      type: 'video',
      prompt: 'Six-second loop of the dashboard filling with live data',
      result: '/fixtures/dashboard-loop.mp4',
      model: 'runway/gen-4',
      cost: 0.88,
      createdAt: minutesAgo(90),
      metadata: { resolution: '720p', aspectRatio: '16:9', duration: '6s', vaultPath: 'generated/videos' },
    },
    {
      id: 'gen-08',
      type: 'image',
      prompt: 'Icon set exploration, single weight, no fills',
      result: null,
      model: 'black-forest-labs/flux-1.1-pro',
      cost: null,
      createdAt: minutesAgo(1),
      metadata: { size: '1024x1024', generationStatus: 'running' },
    },
    {
      id: 'gen-09',
      type: 'image',
      prompt: 'Abstract cover art for the changelog post',
      result: gradientImage(88, 1),
      model: 'black-forest-labs/flux-1.1-pro',
      cost: 0.04,
      createdAt: minutesAgo(140),
      metadata: { size: '1024x1024' },
    },
    {
      id: 'gen-10',
      type: 'video',
      prompt: 'Handheld pan across the studio wall of prints',
      result: '/fixtures/studio-pan.mp4',
      model: 'luma/ray-2',
      cost: 0.62,
      createdAt: minutesAgo(200),
      metadata: { resolution: '1080p', aspectRatio: '9:16', duration: '5s' },
    },
    {
      id: 'gen-11',
      type: 'image',
      prompt: 'Social card, headline safe area left, artwork right',
      result: gradientImage(160, 16 / 9),
      model: 'openai/gpt-image-1',
      cost: 0.07,
      createdAt: minutesAgo(1_450),
      metadata: { size: '1792x1024', vaultPath: 'generated/images/social' },
    },
    {
      id: 'gen-12',
      type: 'image',
      prompt: 'Textured paper background for the print flyer',
      result: gradientImage(46, 1),
      model: 'black-forest-labs/flux-1.1-pro',
      cost: 0.04,
      createdAt: minutesAgo(2_900),
      metadata: { size: '1024x1024' },
    },
  ]
}
