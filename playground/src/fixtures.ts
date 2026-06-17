/**
 * Realistic fixtures for each surface — populated enough that the canvas, layers
 * panel, toolbar, rulers, timeline tracks, and chat thread all render with real
 * content rather than an empty shell.
 */

import type { SceneDocument } from '@tangle-network/agent-app/design-canvas'
import type {
  SequenceTimeline,
  SequenceTrack,
  SequenceClip,
} from '@tangle-network/agent-app/sequences'
import type { VideoFrameProvider } from '@tangle-network/agent-app/sequences-react'
import type {
  CatalogModel,
  ChatUiMessage,
} from '@tangle-network/agent-app/web-react'

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
