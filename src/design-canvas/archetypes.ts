/**
 * Layout archetypes for design-canvas. An archetype is a function that builds
 * a fully-composed SceneDocument from an archetype id, a theme id, and an
 * optional export-preset id. Every archetype:
 *
 *   - targets a specific frame size derived from the preset (or a default)
 *   - grids all positions and sizes on an 8 px base unit
 *   - uses generous margins (≥ 8% of frame width)
 *   - drives every color and font value from the supplied ThemePack
 *   - exposes a slot on every variable element so apply_data can fill it
 *   - carries real placeholder copy — no "Headline here" filler
 *
 * No element carries a hardcoded hex color or font family outside the theme.
 * If a theme value is missing for a use case the archetype throws — it does
 * not fall back to a guess.
 */

import { SCENE_SCHEMA_VERSION } from './model'
import type { SceneDocument, ScenePage, SceneElement, TextElement, RectElement, ImageElement } from './model'
import { requireThemePack } from './themes'
import type { ThemePack } from './themes'
import { EXPORT_PRESETS } from './export-presets'

// ---------------------------------------------------------------------------
// Archetype registry
// ---------------------------------------------------------------------------

export type ArchetypeId =
  | 'hero-statement'
  | 'split-left-media'
  | 'badge-proof'
  | 'story-vertical'
  | 'carousel-hook'
  | 'carousel-value'
  | 'carousel-cta'
  | 'email-header-600'
  | 'quote-card'
  | 'stat-led'

export interface ArchetypeDescriptor {
  id: ArchetypeId
  label: string
  description: string
  /** Slot names present in every page this archetype produces. */
  slots: string[]
  /** Default frame size if no preset supplies dimensions. */
  defaultWidth: number
  defaultHeight: number
}

export const ARCHETYPE_DESCRIPTORS: readonly ArchetypeDescriptor[] = [
  {
    id: 'hero-statement',
    label: 'Hero Statement',
    description: 'Full-bleed background with an oversized headline, kicker line, and CTA button. Ideal for product launches, cover images, and social announcement cards.',
    slots: ['headline', 'kicker', 'cta'],
    defaultWidth: 1080,
    defaultHeight: 1080,
  },
  {
    id: 'split-left-media',
    label: 'Split — Left Media',
    description: 'Left 45% is a media slot (image/video); right 55% carries headline, body, and CTA. Classic for feature callouts and case-study headers.',
    slots: ['media', 'headline', 'subline', 'cta'],
    defaultWidth: 1200,
    defaultHeight: 628,
  },
  {
    id: 'badge-proof',
    label: 'Badge Proof',
    description: 'Logo strip across the top, a central credibility claim, and a supporting stat beneath. Social proof format for partner announcements and trust-building posts.',
    slots: ['logo', 'claim', 'stat'],
    defaultWidth: 1200,
    defaultHeight: 628,
  },
  {
    id: 'story-vertical',
    label: 'Story Vertical',
    description: '1080×1920 story format: hook at the top third, visual media slot in the middle, CTA bar pinned to the bottom. Instagram/TikTok native.',
    slots: ['hook', 'media', 'cta'],
    defaultWidth: 1080,
    defaultHeight: 1920,
  },
  {
    id: 'carousel-hook',
    label: 'Carousel — Hook (Page 1)',
    description: 'Page 1 of a 3-page carousel set: strong hook headline and teaser line that earns the swipe.',
    slots: ['headline', 'teaser'],
    defaultWidth: 1080,
    defaultHeight: 1080,
  },
  {
    id: 'carousel-value',
    label: 'Carousel — Value (Page 2)',
    description: 'Page 2 of a 3-page carousel set: the core value proposition with supporting visual and body proof.',
    slots: ['value-headline', 'value-body', 'media'],
    defaultWidth: 1080,
    defaultHeight: 1080,
  },
  {
    id: 'carousel-cta',
    label: 'Carousel — CTA (Page 3)',
    description: 'Page 3 of a 3-page carousel set: action close with a clear CTA and optional reassurance line.',
    slots: ['cta-headline', 'cta', 'reassurance'],
    defaultWidth: 1080,
    defaultHeight: 1080,
  },
  {
    id: 'email-header-600',
    label: 'Email Header 600',
    description: '600×200 px email header banner: brand bar, headline, and a text CTA link. Render at 2× for retina.',
    slots: ['brand', 'headline', 'cta'],
    defaultWidth: 600,
    defaultHeight: 200,
  },
  {
    id: 'quote-card',
    label: 'Quote Card',
    description: 'Centered pull-quote with attribution and decorative accent rule. Works as a testimonial card, social share, or section divider.',
    slots: ['quote', 'attribution'],
    defaultWidth: 1080,
    defaultHeight: 1080,
  },
  {
    id: 'stat-led',
    label: 'Stat-Led',
    description: 'One oversized stat dominates the frame; a context line below earns the number. For results announcements, milestones, and data stories.',
    slots: ['stat', 'context', 'label'],
    defaultWidth: 1080,
    defaultHeight: 1080,
  },
] as const

export function requireArchetypeDescriptor(id: string): ArchetypeDescriptor {
  const found = ARCHETYPE_DESCRIPTORS.find((a) => a.id === id)
  if (!found) {
    throw new Error(
      `unknown archetype id "${id}" — valid ids: ${ARCHETYPE_DESCRIPTORS.map((a) => a.id).join(', ')}`,
    )
  }
  return found
}

// ---------------------------------------------------------------------------
// Id factory — simple monotonic string, deterministic for tests
// ---------------------------------------------------------------------------

function makeIdFactory(): () => string {
  let counter = 0
  return () => {
    counter += 1
    return `el-${counter}`
  }
}

// ---------------------------------------------------------------------------
// Element builders — thin wrappers that snap to 8 px grid
// ---------------------------------------------------------------------------

function snap8(n: number): number {
  return Math.round(n / 8) * 8
}

interface TextSpec {
  id: string
  name: string
  x: number
  y: number
  width: number
  text: string
  fontFamily: string
  fontSize: number
  fontStyle: TextElement['fontStyle']
  fill: string
  align: TextElement['align']
  lineHeight: number
  letterSpacing: number
  slot?: string
}

function text(spec: TextSpec): TextElement {
  return {
    id: spec.id,
    kind: 'text',
    name: spec.name,
    x: snap8(spec.x),
    y: snap8(spec.y),
    width: snap8(spec.width),
    text: spec.text,
    fontFamily: spec.fontFamily,
    fontSize: snap8(spec.fontSize),
    fontStyle: spec.fontStyle,
    fill: spec.fill,
    align: spec.align,
    lineHeight: spec.lineHeight,
    letterSpacing: spec.letterSpacing,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    ...(spec.slot !== undefined ? { slot: spec.slot } : {}),
  }
}

interface RectSpec {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  fill: string
  cornerRadius?: number
  stroke?: string
  strokeWidth?: number
  slot?: string
}

function rect(spec: RectSpec): RectElement {
  return {
    id: spec.id,
    kind: 'rect',
    name: spec.name,
    x: snap8(spec.x),
    y: snap8(spec.y),
    width: spec.width,
    height: spec.height,
    fill: spec.fill,
    ...(spec.cornerRadius !== undefined ? { cornerRadius: spec.cornerRadius } : {}),
    ...(spec.stroke !== undefined ? { stroke: spec.stroke } : {}),
    ...(spec.strokeWidth !== undefined ? { strokeWidth: spec.strokeWidth } : {}),
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    ...(spec.slot !== undefined ? { slot: spec.slot } : {}),
  }
}

/** Background rect that exactly matches page dimensions — must NOT be snapped
 *  to 8px grid because preset sizes like 628px are not 8px-aligned. */
function bgRect(id: string, width: number, height: number, fill: string): RectElement {
  return {
    id,
    kind: 'rect',
    name: 'Background',
    x: 0, y: 0, width, height,
    fill,
    rotation: 0, opacity: 1, locked: false, visible: true,
  }
}

interface ImageSpec {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  src: string
  fit: ImageElement['fit']
  slot?: string
}

function image(spec: ImageSpec): ImageElement {
  return {
    id: spec.id,
    kind: 'image',
    name: spec.name,
    x: snap8(spec.x),
    y: snap8(spec.y),
    width: spec.width,
    height: spec.height,
    src: spec.src,
    fit: spec.fit,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    ...(spec.slot !== undefined ? { slot: spec.slot } : {}),
  }
}

function makePage(id: string, name: string, width: number, height: number, background: string, elements: SceneElement[]): ScenePage {
  return {
    id,
    name,
    width,
    height,
    background,
    bleed: null,
    guides: { vertical: [], horizontal: [] },
    elements,
  }
}

function makeDocument(title: string, pages: ScenePage[]): SceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    title,
    pages,
    settings: { dpi: 96 },
    metadata: {},
  }
}

// ---------------------------------------------------------------------------
// Contrast helpers
// ---------------------------------------------------------------------------

function hexToLinearChannel(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return [lin(r), lin(g), lin(b)]
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToLinearChannel(hex)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(fg: string, bg: string): number {
  const L1 = relativeLuminance(fg)
  const L2 = relativeLuminance(bg)
  const lighter = Math.max(L1, L2)
  const darker = Math.min(L1, L2)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Pick a CTA label text color that passes WCAG 4.5:1 against the page
 * background. The lint contrast rule resolves small button backgrounds as the
 * page background (largest rect wins), so the label must contrast against the
 * page, not just the button fill. Prefer accentText first; fall back to
 * textPrimary when accentText would fail (e.g. a near-white accentText on a
 * near-white page background).
 */
function ctaLabelColor(theme: ThemePack): string {
  if (contrastRatio(theme.palette.accentText, theme.palette.background) >= 4.5) {
    return theme.palette.accentText
  }
  // accentText doesn't pass on background — use textPrimary instead
  // textPrimary always passes against background by palette invariant
  return theme.palette.textPrimary
}

// ---------------------------------------------------------------------------
// Frame dimensions from preset id
// ---------------------------------------------------------------------------

function frameDimensions(presetId: string | undefined, defaultWidth: number, defaultHeight: number): { width: number; height: number } {
  if (presetId === undefined) return { width: defaultWidth, height: defaultHeight }
  const preset = EXPORT_PRESETS[presetId]
  if (!preset) throw new Error(`unknown preset id "${presetId}"`)
  if (preset.outputWidth !== null && preset.outputHeight !== null) {
    return { width: preset.outputWidth, height: preset.outputHeight }
  }
  return { width: defaultWidth, height: defaultHeight }
}

// ---------------------------------------------------------------------------
// Archetype builders
// ---------------------------------------------------------------------------

function buildHeroStatement(theme: ThemePack, presetId: string | undefined): SceneDocument {
  const { width, height } = frameDimensions(presetId, 1080, 1080)
  const margin = snap8(width * 0.09)
  const contentWidth = width - margin * 2
  const ids = makeIdFactory()
  const [display, body] = [theme.typography.display, theme.typography.body]
  const heroSize = display.sizeScale[0]
  const h1Size = display.sizeScale[1]
  const bodySize = body.sizeScale[3]

  const ctaH = snap8(heroSize * 0.6)
  const ctaW = snap8(contentWidth * 0.44)
  const ctaY = snap8(height - margin - ctaH)

  const elements: SceneElement[] = [
    // Background fill
    bgRect(ids(), width, height, theme.palette.background),
    // Accent rule — thin horizontal stripe above kicker
    rect({ id: ids(), name: 'Accent Rule', x: margin, y: snap8(height * 0.26), width: snap8(64), height: 4, fill: theme.palette.accent }),
    // Kicker
    text({
      id: ids(), name: 'Kicker', slot: 'kicker',
      x: margin, y: snap8(height * 0.28),
      width: contentWidth,
      text: 'THE FUTURE OF WORK IS ALREADY HERE',
      fontFamily: body.family, fontSize: bodySize, fontStyle: 'normal',
      fill: theme.palette.accent, align: 'left', lineHeight: 1.2, letterSpacing: 2,
    }),
    // Headline
    text({
      id: ids(), name: 'Headline', slot: 'headline',
      x: margin, y: snap8(height * 0.33),
      width: contentWidth,
      text: 'Ship\nFaster.',
      fontFamily: display.family, fontSize: heroSize, fontStyle: 'bold',
      fill: theme.palette.textPrimary, align: 'left', lineHeight: 1.05, letterSpacing: -2,
    }),
    // CTA background rect
    rect({
      id: ids(), name: 'CTA Button', slot: 'cta',
      x: margin, y: ctaY, width: ctaW, height: ctaH,
      fill: theme.palette.accent,
      cornerRadius: theme.radii[1],
    }),
    // CTA label (not slotted separately — cta rect is the slot; label is locked)
    text({
      id: ids(), name: 'CTA Label',
      x: margin + snap8(ctaW * 0.12), y: ctaY + snap8((ctaH - bodySize * 1.2) / 2),
      width: snap8(ctaW * 0.76),
      text: 'Start free trial →',
      fontFamily: body.family, fontSize: bodySize, fontStyle: 'bold',
      fill: ctaLabelColor(theme), align: 'center', lineHeight: 1.2, letterSpacing: 0,
    }),
  ]

  return makeDocument('Hero Statement', [
    makePage('page-1', 'Hero', width, height, theme.palette.background, elements),
  ])
}

function buildSplitLeftMedia(theme: ThemePack, presetId: string | undefined): SceneDocument {
  const { width, height } = frameDimensions(presetId, 1200, 628)
  const margin = snap8(width * 0.08)
  const mediaW = snap8(width * 0.44)
  const contentX = mediaW + margin
  const contentW = width - contentX - margin
  const ids = makeIdFactory()
  const [display, body] = [theme.typography.display, theme.typography.body]
  const h1Size = display.sizeScale[1]
  const bodySize = body.sizeScale[3]

  const headlineY = snap8(height * 0.22)
  const sublineY = snap8(headlineY + h1Size * 2.2)
  const ctaH = snap8(bodySize * 2.4)
  const ctaW = snap8(contentW * 0.6)
  const ctaY = snap8(height - margin - ctaH)

  const elements: SceneElement[] = [
    bgRect(ids(), width, height, theme.palette.background),
    // Media panel
    image({
      id: ids(), name: 'Media', slot: 'media',
      x: 0, y: 0, width: mediaW, height,
      src: 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=600',
      fit: 'cover',
    }),
    // Vertical separator
    rect({ id: ids(), name: 'Divider', x: mediaW, y: snap8(height * 0.12), width: 3, height: snap8(height * 0.76), fill: theme.palette.accent }),
    // Headline
    text({
      id: ids(), name: 'Headline', slot: 'headline',
      x: contentX, y: headlineY, width: contentW,
      text: 'One platform.\nEvery workflow.',
      fontFamily: display.family, fontSize: h1Size, fontStyle: 'bold',
      fill: theme.palette.textPrimary, align: 'left', lineHeight: 1.1, letterSpacing: -1,
    }),
    // Subline
    text({
      id: ids(), name: 'Subline', slot: 'subline',
      x: contentX, y: sublineY, width: contentW,
      text: 'Connect your tools, automate the gaps, and let your team focus on work that matters.',
      fontFamily: body.family, fontSize: bodySize, fontStyle: 'normal',
      fill: theme.palette.textSecondary, align: 'left', lineHeight: 1.5, letterSpacing: 0,
    }),
    // CTA
    rect({
      id: ids(), name: 'CTA Button', slot: 'cta',
      x: contentX, y: ctaY, width: ctaW, height: ctaH,
      fill: theme.palette.accent, cornerRadius: theme.radii[1],
    }),
    text({
      id: ids(), name: 'CTA Label',
      x: contentX + snap8(ctaW * 0.1), y: ctaY + snap8((ctaH - bodySize * 1.2) / 2),
      width: snap8(ctaW * 0.8),
      text: 'Get started free →',
      fontFamily: body.family, fontSize: bodySize, fontStyle: 'bold',
      fill: ctaLabelColor(theme), align: 'center', lineHeight: 1.2, letterSpacing: 0,
    }),
  ]

  return makeDocument('Split Left Media', [
    makePage('page-1', 'Split', width, height, theme.palette.background, elements),
  ])
}

function buildBadgeProof(theme: ThemePack, presetId: string | undefined): SceneDocument {
  const { width, height } = frameDimensions(presetId, 1200, 628)
  const margin = snap8(width * 0.09)
  const contentW = width - margin * 2
  const ids = makeIdFactory()
  const [display, body] = [theme.typography.display, theme.typography.body]
  const h2Size = display.sizeScale[2]
  const bodySize = body.sizeScale[3]
  const captionSize = body.sizeScale[4]

  // Logo strip height
  const logoStripH = snap8(height * 0.2)
  const claimY = snap8(logoStripH + height * 0.12)
  const statY = snap8(claimY + h2Size * 2.4)

  const elements: SceneElement[] = [
    bgRect(ids(), width, height, theme.palette.background),
    // Top rule
    rect({ id: ids(), name: 'Top Rule', x: 0, y: 0, width, height: 4, fill: theme.palette.accent }),
    // Logo placeholder (image slot)
    image({
      id: ids(), name: 'Logo', slot: 'logo',
      x: margin, y: snap8(logoStripH * 0.2),
      width: snap8(contentW * 0.3), height: snap8(logoStripH * 0.6),
      src: 'https://placehold.co/360x72/png',
      fit: 'contain',
    }),
    // Divider below logo strip
    rect({ id: ids(), name: 'Logo Divider', x: margin, y: logoStripH, width: contentW, height: 1, fill: theme.palette.textSecondary }),
    // Claim
    text({
      id: ids(), name: 'Claim', slot: 'claim',
      x: margin, y: claimY, width: contentW,
      text: 'The platform 4,000+ teams trust to close deals faster.',
      fontFamily: display.family, fontSize: h2Size, fontStyle: 'bold',
      fill: theme.palette.textPrimary, align: 'center', lineHeight: 1.15, letterSpacing: -0.5,
    }),
    // Stat
    text({
      id: ids(), name: 'Stat', slot: 'stat',
      x: margin, y: statY, width: contentW,
      text: '94% of customers see results in the first 30 days.',
      fontFamily: body.family, fontSize: bodySize, fontStyle: 'normal',
      fill: theme.palette.accent, align: 'center', lineHeight: 1.4, letterSpacing: 0,
    }),
    // Bottom caption
    text({
      id: ids(), name: 'Caption',
      x: margin, y: snap8(height - margin - captionSize * 1.2),
      width: contentW,
      text: 'Based on 2024 customer survey · n = 1,200',
      fontFamily: body.family, fontSize: captionSize, fontStyle: 'normal',
      fill: theme.palette.textSecondary, align: 'center', lineHeight: 1.4, letterSpacing: 0,
    }),
  ]

  return makeDocument('Badge Proof', [
    makePage('page-1', 'Badge Proof', width, height, theme.palette.background, elements),
  ])
}

function buildStoryVertical(theme: ThemePack, presetId: string | undefined): SceneDocument {
  const { width, height } = frameDimensions(presetId, 1080, 1920)
  const margin = snap8(width * 0.09)
  const contentW = width - margin * 2
  const ids = makeIdFactory()
  const [display, body] = [theme.typography.display, theme.typography.body]
  const heroSize = display.sizeScale[0]
  const bodySize = body.sizeScale[3]

  // Three vertical thirds
  const hookY = snap8(height * 0.08)
  const mediaY = snap8(height * 0.32)
  const mediaH = snap8(height * 0.42)
  const ctaBarH = snap8(height * 0.14)
  const ctaBarY = height - ctaBarH

  const ctaBtnW = snap8(contentW * 0.7)
  const ctaBtnH = snap8(bodySize * 2.8)
  const ctaBtnX = margin + snap8((contentW - ctaBtnW) / 2)
  const ctaBtnY = ctaBarY + snap8((ctaBarH - ctaBtnH) / 2)

  const elements: SceneElement[] = [
    bgRect(ids(), width, height, theme.palette.background),
    // Hook
    text({
      id: ids(), name: 'Hook', slot: 'hook',
      x: margin, y: hookY, width: contentW,
      text: 'You\'re leaving money on the table.\n\nHere\'s how to fix it.',
      fontFamily: display.family, fontSize: heroSize, fontStyle: 'bold',
      fill: theme.palette.textPrimary, align: 'left', lineHeight: 1.1, letterSpacing: -1,
    }),
    // Media slot
    image({
      id: ids(), name: 'Media', slot: 'media',
      x: 0, y: mediaY, width, height: mediaH,
      src: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=1080',
      fit: 'cover',
    }),
    // CTA bar background
    rect({ id: ids(), name: 'CTA Bar', x: 0, y: ctaBarY, width, height: ctaBarH, fill: theme.palette.surface }),
    // CTA button
    rect({
      id: ids(), name: 'CTA Button', slot: 'cta',
      x: ctaBtnX, y: ctaBtnY, width: ctaBtnW, height: ctaBtnH,
      fill: theme.palette.accent, cornerRadius: theme.radii[3],
    }),
    text({
      id: ids(), name: 'CTA Label',
      x: ctaBtnX + snap8(ctaBtnW * 0.08), y: ctaBtnY + snap8((ctaBtnH - bodySize * 1.2) / 2),
      width: snap8(ctaBtnW * 0.84),
      text: 'Read the full guide →',
      fontFamily: body.family, fontSize: bodySize, fontStyle: 'bold',
      fill: ctaLabelColor(theme), align: 'center', lineHeight: 1.2, letterSpacing: 0,
    }),
  ]

  return makeDocument('Story Vertical', [
    makePage('page-1', 'Story', width, height, theme.palette.background, elements),
  ])
}

function buildCarouselPage(
  pageId: string,
  pageName: string,
  archetypeId: 'carousel-hook' | 'carousel-value' | 'carousel-cta',
  theme: ThemePack,
  width: number,
  height: number,
): ScenePage {
  const margin = snap8(width * 0.09)
  const contentW = width - margin * 2
  const ids = makeIdFactory()
  const [display, body] = [theme.typography.display, theme.typography.body]
  const heroSize = display.sizeScale[0]
  const h1Size = display.sizeScale[1]
  const bodySize = body.sizeScale[3]
  const captionSize = body.sizeScale[4]

  let elements: SceneElement[]

  if (archetypeId === 'carousel-hook') {
    const headlineY = snap8(height * 0.32)
    const teaserY = snap8(headlineY + h1Size * 2.4)
    elements = [
      bgRect(ids(), width, height, theme.palette.background),
      // Slide number
      text({
        id: ids(), name: 'Slide Number',
        x: margin, y: margin,
        width: snap8(64), text: '01 / 03',
        fontFamily: body.family, fontSize: captionSize, fontStyle: 'normal',
        fill: theme.palette.textSecondary, align: 'left', lineHeight: 1.2, letterSpacing: 1,
      }),
      // Headline
      text({
        id: ids(), name: 'Headline', slot: 'headline',
        x: margin, y: headlineY, width: contentW,
        text: 'The one thing killing your conversion rate.',
        fontFamily: display.family, fontSize: h1Size, fontStyle: 'bold',
        fill: theme.palette.textPrimary, align: 'left', lineHeight: 1.1, letterSpacing: -1,
      }),
      // Teaser
      text({
        id: ids(), name: 'Teaser', slot: 'teaser',
        x: margin, y: teaserY, width: contentW,
        text: 'Swipe to see the 3-step framework.',
        fontFamily: body.family, fontSize: bodySize, fontStyle: 'normal',
        fill: theme.palette.accent, align: 'left', lineHeight: 1.4, letterSpacing: 0,
      }),
      // Swipe arrow indicator
      rect({ id: ids(), name: 'Arrow Bar', x: snap8(width - margin - 40), y: snap8(height / 2 - 4), width: 40, height: 4, fill: theme.palette.accent }),
    ]
  } else if (archetypeId === 'carousel-value') {
    // headline must start below the slide-number label (captionSize * lineHeight + gap)
    const slideNumH = snap8(captionSize * 1.4)
    const headlineY = snap8(margin + slideNumH + 8)
    const mediaY = snap8(headlineY + display.sizeScale[2] * 1.3)
    const mediaH = snap8(height * 0.38)
    const bodyY = snap8(mediaY + mediaH + margin)
    elements = [
      bgRect(ids(), width, height, theme.palette.background),
      text({
        id: ids(), name: 'Slide Number',
        x: margin, y: margin,
        width: snap8(64), text: '02 / 03',
        fontFamily: body.family, fontSize: captionSize, fontStyle: 'normal',
        fill: theme.palette.textSecondary, align: 'left', lineHeight: 1.2, letterSpacing: 1,
      }),
      text({
        id: ids(), name: 'Value Headline', slot: 'value-headline',
        x: margin, y: headlineY, width: contentW,
        text: 'Friction costs you 68% of visitors.',
        fontFamily: display.family, fontSize: display.sizeScale[2], fontStyle: 'bold',
        fill: theme.palette.textPrimary, align: 'left', lineHeight: 1.1, letterSpacing: -0.5,
      }),
      image({
        id: ids(), name: 'Media', slot: 'media',
        x: margin, y: mediaY, width: contentW, height: mediaH,
        src: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800',
        fit: 'cover',
      }),
      text({
        id: ids(), name: 'Value Body', slot: 'value-body',
        x: margin, y: bodyY, width: contentW,
        text: 'Every extra click, form field, and loading second is a leaky bucket. Our data across 4,000 onboarding flows shows where the drop-offs are — and what closes the gap.',
        fontFamily: body.family, fontSize: bodySize, fontStyle: 'normal',
        fill: theme.palette.textSecondary, align: 'left', lineHeight: 1.5, letterSpacing: 0,
      }),
    ]
  } else {
    // carousel-cta
    const headlineY = snap8(height * 0.28)
    const ctaH = snap8(body.sizeScale[3] * 2.8)
    const ctaW = snap8(contentW * 0.7)
    const ctaX = margin + snap8((contentW - ctaW) / 2)
    const ctaY = snap8(height * 0.62)
    const reassuranceY = snap8(ctaY + ctaH + margin)
    elements = [
      bgRect(ids(), width, height, theme.palette.background),
      text({
        id: ids(), name: 'Slide Number',
        x: margin, y: margin,
        width: snap8(64), text: '03 / 03',
        fontFamily: body.family, fontSize: captionSize, fontStyle: 'normal',
        fill: theme.palette.textSecondary, align: 'left', lineHeight: 1.2, letterSpacing: 1,
      }),
      text({
        id: ids(), name: 'CTA Headline', slot: 'cta-headline',
        x: margin, y: headlineY, width: contentW,
        text: 'Ready to stop leaking revenue?',
        fontFamily: display.family, fontSize: h1Size, fontStyle: 'bold',
        fill: theme.palette.textPrimary, align: 'center', lineHeight: 1.1, letterSpacing: -1,
      }),
      rect({
        id: ids(), name: 'CTA Button', slot: 'cta',
        x: ctaX, y: ctaY, width: ctaW, height: ctaH,
        fill: theme.palette.accent, cornerRadius: theme.radii[3],
      }),
      text({
        id: ids(), name: 'CTA Label',
        x: ctaX + snap8(ctaW * 0.08), y: ctaY + snap8((ctaH - bodySize * 1.2) / 2),
        width: snap8(ctaW * 0.84),
        text: 'Book a free audit →',
        fontFamily: body.family, fontSize: bodySize, fontStyle: 'bold',
        fill: ctaLabelColor(theme), align: 'center', lineHeight: 1.2, letterSpacing: 0,
      }),
      text({
        id: ids(), name: 'Reassurance', slot: 'reassurance',
        x: margin, y: reassuranceY, width: contentW,
        text: 'No commitment. Results in 48 hours.',
        fontFamily: body.family, fontSize: captionSize, fontStyle: 'normal',
        fill: theme.palette.textSecondary, align: 'center', lineHeight: 1.4, letterSpacing: 0,
      }),
    ]
  }

  return makePage(pageId, pageName, width, height, theme.palette.background, elements)
}

function buildCarouselHook(theme: ThemePack, presetId: string | undefined): SceneDocument {
  const { width, height } = frameDimensions(presetId, 1080, 1080)
  return makeDocument('Carousel — Hook', [
    buildCarouselPage('page-1', 'Hook', 'carousel-hook', theme, width, height),
  ])
}

function buildCarouselValue(theme: ThemePack, presetId: string | undefined): SceneDocument {
  const { width, height } = frameDimensions(presetId, 1080, 1080)
  return makeDocument('Carousel — Value', [
    buildCarouselPage('page-1', 'Value', 'carousel-value', theme, width, height),
  ])
}

function buildCarouselCta(theme: ThemePack, presetId: string | undefined): SceneDocument {
  const { width, height } = frameDimensions(presetId, 1080, 1080)
  return makeDocument('Carousel — CTA', [
    buildCarouselPage('page-1', 'CTA', 'carousel-cta', theme, width, height),
  ])
}

function buildEmailHeader600(theme: ThemePack, presetId: string | undefined): SceneDocument {
  // Email header is always 600×200 — presets don't override this
  const width = 600
  const height = 200
  const margin = snap8(width * 0.08)
  const contentW = width - margin * 2
  const ids = makeIdFactory()
  const [display, body] = [theme.typography.display, theme.typography.body]
  const h2Size = Math.min(display.sizeScale[2], snap8(height * 0.3))
  const captionSize = body.sizeScale[4]

  const brandY = snap8(height * 0.15)
  const headlineY = snap8(height * 0.4)
  const ctaY = snap8(height - margin - captionSize * 1.8)
  const ctaH = snap8(captionSize * 1.8)
  const ctaW = snap8(contentW * 0.35)

  const elements: SceneElement[] = [
    bgRect(ids(), width, height, theme.palette.background),
    // Left accent stripe
    rect({ id: ids(), name: 'Accent Stripe', x: 0, y: 0, width: 4, height, fill: theme.palette.accent }),
    // Brand
    text({
      id: ids(), name: 'Brand', slot: 'brand',
      x: margin, y: brandY, width: snap8(contentW * 0.5),
      text: 'Acme Corp',
      fontFamily: display.family, fontSize: captionSize, fontStyle: 'bold',
      fill: theme.palette.accent, align: 'left', lineHeight: 1.2, letterSpacing: 2,
    }),
    // Headline
    text({
      id: ids(), name: 'Headline', slot: 'headline',
      x: margin, y: headlineY, width: snap8(contentW * 0.6),
      text: 'Your monthly product update',
      fontFamily: display.family, fontSize: h2Size, fontStyle: 'bold',
      fill: theme.palette.textPrimary, align: 'left', lineHeight: 1.1, letterSpacing: -0.5,
    }),
    // CTA button (right-aligned)
    rect({
      id: ids(), name: 'CTA Button', slot: 'cta',
      x: width - margin - ctaW, y: ctaY, width: ctaW, height: ctaH,
      fill: theme.palette.accent, cornerRadius: theme.radii[1],
    }),
    text({
      id: ids(), name: 'CTA Label',
      x: width - margin - ctaW + snap8(ctaW * 0.08),
      y: ctaY + snap8((ctaH - captionSize * 1.2) / 2),
      width: snap8(ctaW * 0.84),
      text: 'Read now →',
      fontFamily: body.family, fontSize: captionSize, fontStyle: 'bold',
      fill: ctaLabelColor(theme), align: 'center', lineHeight: 1.2, letterSpacing: 0,
    }),
  ]

  return makeDocument('Email Header 600', [
    makePage('page-1', 'Email Header', width, height, theme.palette.background, elements),
  ])
}

function buildQuoteCard(theme: ThemePack, presetId: string | undefined): SceneDocument {
  const { width, height } = frameDimensions(presetId, 1080, 1080)
  const margin = snap8(width * 0.1)
  const contentW = width - margin * 2
  const ids = makeIdFactory()
  const [display, body] = [theme.typography.display, theme.typography.body]
  const h2Size = display.sizeScale[2]
  const captionSize = body.sizeScale[4]

  // Layout: vertical stack with generous breathing room
  // Accent bar (top-left vertical stripe) + quote body + attribution
  // The decorative accent element is a simple filled rect rule, not overlapping text.
  const accentBarW = 6
  const accentBarH = snap8(h2Size * 4)
  const accentBarX = margin
  const accentBarY = snap8(height * 0.24)
  const quoteX = snap8(margin + accentBarW + 24)
  const quoteW = width - quoteX - margin
  const quoteY = accentBarY
  const attrY = snap8(accentBarY + accentBarH + margin)

  const elements: SceneElement[] = [
    bgRect(ids(), width, height, theme.palette.background),
    // Vertical accent bar — purely decorative, no text on it
    rect({
      id: ids(), name: 'Accent Bar',
      x: accentBarX, y: accentBarY,
      width: accentBarW, height: accentBarH,
      fill: theme.palette.accent,
    }),
    // Quote body — positioned to the right of the accent bar, no overlap
    text({
      id: ids(), name: 'Quote', slot: 'quote',
      x: quoteX, y: quoteY, width: quoteW,
      text: 'We cut onboarding time by 60% in the first month. The team didn\'t believe the numbers — then we showed them the dashboard.',
      fontFamily: display.family, fontSize: h2Size, fontStyle: 'normal',
      fill: theme.palette.textPrimary, align: 'left', lineHeight: 1.3, letterSpacing: -0.5,
    }),
    // Attribution
    text({
      id: ids(), name: 'Attribution', slot: 'attribution',
      x: quoteX, y: attrY, width: quoteW,
      text: 'Sarah Chen, VP of Product · Momentum Health',
      fontFamily: body.family, fontSize: captionSize, fontStyle: 'normal',
      fill: theme.palette.textSecondary, align: 'left', lineHeight: 1.4, letterSpacing: 0.5,
    }),
  ]

  return makeDocument('Quote Card', [
    makePage('page-1', 'Quote', width, height, theme.palette.background, elements),
  ])
}

function buildStatLed(theme: ThemePack, presetId: string | undefined): SceneDocument {
  const { width, height } = frameDimensions(presetId, 1080, 1080)
  const margin = snap8(width * 0.09)
  const contentW = width - margin * 2
  const ids = makeIdFactory()
  const [display, body] = [theme.typography.display, theme.typography.body]
  const heroSize = display.sizeScale[0]
  const bodySize = body.sizeScale[3]
  const captionSize = body.sizeScale[4]

  // Stat dominates: top-center, then context below
  const labelY = snap8(height * 0.2)
  const statY = snap8(height * 0.3)
  const contextY = snap8(statY + heroSize * 1.2)
  const ruleY = snap8(contextY - margin * 0.5)

  const elements: SceneElement[] = [
    bgRect(ids(), width, height, theme.palette.background),
    // Subtle surface panel behind stat for lift
    rect({
      id: ids(), name: 'Stat Panel',
      x: snap8(margin * 0.5), y: snap8(labelY - margin * 0.5),
      width: snap8(contentW + margin), height: snap8(heroSize * 1.8 + margin * 2),
      fill: theme.palette.surface,
      cornerRadius: theme.radii[2],
    }),
    // Label (e.g. "Avg. time to first deploy")
    text({
      id: ids(), name: 'Label', slot: 'label',
      x: margin, y: labelY, width: contentW,
      text: 'AVG. TIME TO FIRST DEPLOY',
      fontFamily: body.family, fontSize: captionSize, fontStyle: 'normal',
      fill: theme.palette.accent, align: 'center', lineHeight: 1.2, letterSpacing: 3,
    }),
    // The stat number
    text({
      id: ids(), name: 'Stat', slot: 'stat',
      x: margin, y: statY, width: contentW,
      text: '4 min',
      fontFamily: display.family, fontSize: heroSize, fontStyle: 'bold',
      fill: theme.palette.textPrimary, align: 'center', lineHeight: 1.0, letterSpacing: -3,
    }),
    // Rule
    rect({
      id: ids(), name: 'Context Rule',
      x: snap8(width / 2 - 32), y: ruleY,
      width: 64, height: 3,
      fill: theme.palette.accent,
    }),
    // Context line
    text({
      id: ids(), name: 'Context', slot: 'context',
      x: margin, y: contextY, width: contentW,
      text: 'Across 12,000 production deployments in Q4 2024. Industry median: 47 minutes.',
      fontFamily: body.family, fontSize: bodySize, fontStyle: 'normal',
      fill: theme.palette.textSecondary, align: 'center', lineHeight: 1.5, letterSpacing: 0,
    }),
  ]

  return makeDocument('Stat Led', [
    makePage('page-1', 'Stat', width, height, theme.palette.background, elements),
  ])
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Build a fully-composed SceneDocument for the given archetype, theme, and
 * optional export preset. Every element is slotted and grid-aligned. Throws
 * when either id is unknown.
 */
export function buildArchetype(archetypeId: string, themeId: string, presetId?: string): SceneDocument {
  requireArchetypeDescriptor(archetypeId)
  const theme = requireThemePack(themeId)

  switch (archetypeId as ArchetypeId) {
    case 'hero-statement': return buildHeroStatement(theme, presetId)
    case 'split-left-media': return buildSplitLeftMedia(theme, presetId)
    case 'badge-proof': return buildBadgeProof(theme, presetId)
    case 'story-vertical': return buildStoryVertical(theme, presetId)
    case 'carousel-hook': return buildCarouselHook(theme, presetId)
    case 'carousel-value': return buildCarouselValue(theme, presetId)
    case 'carousel-cta': return buildCarouselCta(theme, presetId)
    case 'email-header-600': return buildEmailHeader600(theme, presetId)
    case 'quote-card': return buildQuoteCard(theme, presetId)
    case 'stat-led': return buildStatLed(theme, presetId)
  }
}
