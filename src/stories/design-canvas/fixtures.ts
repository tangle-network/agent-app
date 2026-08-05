/**
 * Local fixtures + harness helpers for the design-canvas stories.
 *
 * `makeLaunchPosterScene` mirrors the shared `../fixtures/canvas.ts` fixture
 * (kept local so these stories are self-contained); the multi-page and empty
 * scenes are additions covering the editor's page strip, layers states, and
 * empty-state doors.
 */

import { useCallback, useEffect, useState } from 'react'
import type { SceneDocument, ScenePage } from '../../design-canvas'
import { applySceneOperations } from '../../design-canvas'
import type { SceneOperation } from '../../design-canvas'

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/** Single-page poster scene — populated enough that every editor surface
 *  (layers, toolbar, rulers, guides) renders with real content. Text elements
 *  reference Inter, loaded in `.storybook/preview-head.html`. */
export function makeLaunchPosterScene(): SceneDocument {
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

/** One blank 1080×1080 page — drives the branded empty state (three doors). */
export function makeEmptyScene(): SceneDocument {
  return {
    schemaVersion: 1,
    title: 'Untitled design',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        width: 1080,
        height: 1080,
        background: '#ffffff',
        bleed: null,
        guides: { vertical: [], horizontal: [] },
        elements: [],
      },
    ],
    settings: { dpi: 96 },
    metadata: {},
  }
}

/**
 * Three pages with distinct aspect ratios so the pages strip shows real
 * variety. Page 2 carries the layers-showcase set: a group with children,
 * a hidden element, a locked element, a slot-bound element, and one element
 * of every remaining kind (image/video included — their media never loads in
 * Storybook, which exercises the placeholder/broken treatments).
 */
export function makeMultiPageScene(): SceneDocument {
  const poster = makeLaunchPosterScene().pages[0]!
  return {
    schemaVersion: 1,
    title: 'Launch campaign',
    pages: [
      poster,
      {
        id: 'page-2',
        name: 'Story',
        width: 1080,
        height: 1920,
        background: '#111827',
        bleed: null,
        guides: { vertical: [540], horizontal: [] },
        elements: [
          {
            id: 'el-hero',
            kind: 'image',
            name: 'Hero image',
            x: 90,
            y: 120,
            rotation: 0,
            opacity: 1,
            locked: false,
            visible: true,
            width: 900,
            height: 640,
            src: '/api/assets/hero.png',
            fit: 'cover',
          },
          {
            id: 'el-header-group',
            kind: 'group',
            name: 'Header lockup',
            x: 90,
            y: 840,
            rotation: 0,
            opacity: 1,
            locked: false,
            visible: true,
            children: [
              {
                id: 'el-kicker',
                kind: 'text',
                name: 'Kicker',
                x: 0,
                y: 0,
                rotation: 0,
                opacity: 1,
                locked: false,
                visible: true,
                text: 'NEW',
                width: 300,
                fontFamily: 'Inter',
                fontSize: 28,
                fontStyle: 'bold',
                fill: '#60a5fa',
                align: 'left',
                lineHeight: 1.2,
                letterSpacing: 4,
              },
              {
                id: 'el-story-title',
                kind: 'text',
                name: 'Title',
                x: 0,
                y: 48,
                rotation: 0,
                opacity: 1,
                locked: false,
                visible: true,
                text: 'Agents that ship.',
                width: 820,
                fontFamily: 'Inter',
                fontSize: 84,
                fontStyle: 'bold',
                fill: '#f9fafb',
                align: 'left',
                lineHeight: 1.05,
                letterSpacing: 0,
                slot: 'headline',
              },
            ],
          },
          {
            id: 'el-logo-lock',
            kind: 'rect',
            name: 'Logo (locked)',
            x: 880,
            y: 1720,
            rotation: 0,
            opacity: 1,
            locked: true,
            visible: true,
            width: 110,
            height: 110,
            fill: '#3b82f6',
            cornerRadius: 24,
          },
          {
            id: 'el-draft-note',
            kind: 'text',
            name: 'Draft note (hidden)',
            x: 90,
            y: 1700,
            rotation: 0,
            opacity: 1,
            locked: false,
            visible: false,
            text: 'TODO: replace hero',
            width: 400,
            fontFamily: 'Inter',
            fontSize: 24,
            fontStyle: 'italic',
            fill: '#9ca3af',
            align: 'left',
            lineHeight: 1.3,
            letterSpacing: 0,
          },
          {
            id: 'el-promo-video',
            kind: 'video',
            name: 'Promo clip',
            x: 90,
            y: 1180,
            rotation: 0,
            opacity: 1,
            locked: false,
            visible: true,
            width: 900,
            height: 506,
            src: '/api/assets/promo.mp4',
          },
        ],
      },
      {
        id: 'page-3',
        name: 'Banner',
        width: 1920,
        height: 640,
        background: '#f8fafc',
        bleed: { top: 12, right: 12, bottom: 12, left: 12 },
        guides: { vertical: [], horizontal: [320] },
        elements: [
          {
            id: 'el-banner-band',
            kind: 'rect',
            name: 'Band',
            x: 0,
            y: 480,
            rotation: 0,
            opacity: 1,
            locked: false,
            visible: true,
            width: 1920,
            height: 160,
            fill: '#1d4ed8',
          },
          {
            id: 'el-banner-copy',
            kind: 'text',
            name: 'Banner copy',
            x: 120,
            y: 120,
            rotation: 0,
            opacity: 1,
            locked: false,
            visible: true,
            text: 'The agent platform for teams that ship.',
            width: 1300,
            fontFamily: 'Inter',
            fontSize: 72,
            fontStyle: 'bold',
            fill: '#0f172a',
            align: 'left',
            lineHeight: 1.15,
            letterSpacing: 0,
          },
          {
            id: 'el-banner-dot',
            kind: 'ellipse',
            name: 'Status dot',
            x: 1720,
            y: 120,
            rotation: 0,
            opacity: 1,
            locked: false,
            visible: true,
            width: 80,
            height: 80,
            fill: '#22c55e',
          },
        ],
      },
    ],
    settings: { dpi: 96 },
    metadata: {},
  }
}

/** The layers-showcase page on its own (panel stories). */
export function makeLayersShowcasePage(): ScenePage {
  return makeMultiPageScene().pages[1]!
}

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/**
 * Read the live theme from the document element so the Konva canvas (which
 * cannot resolve CSS vars) paints with the active palette. Tracks the global
 * Storybook theme toolbar, which mutates `data-theme` / `.dark` on
 * `document.documentElement`. Stories never set the theme themselves.
 */
export function useIsDark(): boolean {
  const read = () => {
    if (typeof document === 'undefined') return false
    const root = document.documentElement
    return root.getAttribute('data-theme') === 'dark' || root.classList.contains('dark')
  }
  const [isDark, setIsDark] = useState(read)
  useEffect(() => {
    const root = document.documentElement
    const obs = new MutationObserver(() => setIsDark(read()))
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    setIsDark(read())
    return () => obs.disconnect()
  }, [])
  return isDark
}

/**
 * Host-side persistence for editor stories, mirroring the playground canvas
 * route: ops are reduced into local document state with the engine's real
 * `applySceneOperations`, so the editor rebases onto a coherent post-apply
 * document on every save (and a rejected op would surface, not echo stale).
 */
export function useLocalSceneDocument(initial: SceneDocument) {
  const [doc, setDoc] = useState(initial)
  const [rev, setRev] = useState(1)

  const onApplyOperations = useCallback(
    async (operations: SceneOperation[]) => {
      const nextRev = rev + 1
      const next = applySceneOperations(doc, operations)
      setDoc(next)
      setRev(nextRev)
      console.log('[design-canvas story] applied operations', operations)
      return { rev: nextRev, document: next }
    },
    [doc, rev],
  )

  return { document: doc, rev, onApplyOperations }
}

/**
 * Deterministic offline thumbnail for PagesStrip stories: an SVG data URL
 * painting the page background plus simplified element fills. The real
 * Konva-based renderer is exercised through the full editor stories.
 */
export function renderFakeThumbnail(page: ScenePage): Promise<string | null> {
  const shapes = page.elements
    .filter((el) => el.visible)
    .map((el) => {
      const fill = 'fill' in el ? el.fill : '#64748b'
      if (el.kind === 'ellipse') {
        return `<ellipse cx="${el.x + el.width / 2}" cy="${el.y + el.height / 2}" rx="${el.width / 2}" ry="${el.height / 2}" fill="${fill}"/>`
      }
      if (el.kind === 'line') {
        return `<line x1="${el.x}" y1="${el.y}" x2="${el.x + (el.points[2] ?? 0)}" y2="${el.y + (el.points[3] ?? 0)}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}"/>`
      }
      const w = 'width' in el ? el.width : 120
      const h = 'height' in el ? el.height : 40
      return `<rect x="${el.x}" y="${el.y}" width="${w}" height="${h}" rx="8" fill="${fill}"/>`
    })
    .join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.width} ${page.height}"><rect width="${page.width}" height="${page.height}" fill="${page.background}"/>${shapes}</svg>`
  return Promise.resolve(`data:image/svg+xml,${encodeURIComponent(svg)}`)
}

/** Never resolves — drives the PagesStrip placeholder (loading) treatment. */
export function renderPendingThumbnail(): Promise<string | null> {
  return new Promise(() => {})
}
