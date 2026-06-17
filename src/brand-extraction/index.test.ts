import { describe, expect, it } from 'vitest'
import {
  decideBrandKit,
  extractBrandKit,
  normalizeColor,
  normalizeSiteUrl,
  parseBrandKit,
} from './index'
import type { FetchLike } from './types'

/** A representative marketing homepage: og/meta tags, favicon + apple-touch +
 *  an in-page logo <img>, :root CSS color tokens, a Google Fonts link, inline
 *  font-family declarations on headings and body, a hero image. Exercises every
 *  extraction path in one fixture. */
const FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head>
  <title>Acme Robotics — Autonomous warehouse fleets</title>
  <meta name="description" content="Acme builds autonomous warehouse robots." />
  <meta property="og:site_name" content="Acme Robotics" />
  <meta property="og:image" content="/static/og-card.png" />
  <meta name="twitter:image" content="https://cdn.acme.com/tw.png" />
  <link rel="icon" href="/favicon.ico" sizes="32x32" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&display=swap" />
  <style>
    :root {
      --brand-accent: #ff4d2e;
      --color-bg: #ffffff;
      --color-surface: #f4f4f5;
      --text-primary: rgb(17, 17, 17);
      --text-secondary: #6b7280;
    }
    h1, h2 { font-family: "Space Grotesk", system-ui, sans-serif; }
    body, p { font-family: 'Inter', Arial, sans-serif; color: #111111; }
    .cta { background: #ff4d2e; }
  </style>
</head>
<body>
  <header>
    <img class="site-logo" src="/img/acme-logo.svg" alt="Acme Robotics logo" width="140" height="32" />
  </header>
  <img class="hero-banner" src="/img/hero.jpg" alt="A robot in a warehouse" width="1200" height="600" />
  <img src="/img/team.jpg" alt="The team" />
</body>
</html>`

const BASE_URL = 'https://acme.com'

function htmlFetch(html: string, status = 200): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => html,
    headers: { get: () => null },
  })
}

describe('normalizeSiteUrl', () => {
  it('adds https when scheme-less and rejects non-http', () => {
    expect(normalizeSiteUrl('acme.com')).toBe('https://acme.com/')
    expect(normalizeSiteUrl('  https://x.io/path ')).toBe('https://x.io/path')
    expect(normalizeSiteUrl('ftp://x.io')).toBeNull()
    expect(normalizeSiteUrl('')).toBeNull()
  })
})

describe('normalizeColor', () => {
  it('normalizes hex shorthands, rgb, and rgba to lowercase hex', () => {
    expect(normalizeColor('#FFF')).toBe('#ffffff')
    expect(normalizeColor('#ff4d2e')).toBe('#ff4d2e')
    expect(normalizeColor('rgb(17, 17, 17)')).toBe('#111111')
    expect(normalizeColor('rgba(255,77,46,0.5)')).toBe('#ff4d2e80')
    expect(normalizeColor('papayawhip')).toBeNull()
  })
})

describe('parseBrandKit — fixture HTML → BrandKit', () => {
  const kit = parseBrandKit(FIXTURE_HTML, BASE_URL)

  it('extracts the brand name from og:site_name (not the full title)', () => {
    expect(kit.name).toBe('Acme Robotics')
    expect(kit.description).toBe('Acme builds autonomous warehouse robots.')
  })

  it('ranks the in-page logo <img> above icons and resolves it absolute', () => {
    const top = kit.logos[0]!
    expect(top.source).toBe('img-logo')
    expect(top.url).toBe('https://acme.com/img/acme-logo.svg')
    expect(top.confidence).toBeGreaterThan(0.8)
    const sources = kit.logos.map((l) => l.source)
    expect(sources).toContain('favicon')
    expect(sources).toContain('apple-touch-icon')
  })

  it('captures the apple-touch-icon declared size', () => {
    const apple = kit.logos.find((l) => l.source === 'apple-touch-icon')
    expect(apple).toMatchObject({ width: 180, height: 180 })
  })

  it('extracts colors with :root tokens ranked first and named', () => {
    const accent = kit.palette.find((c) => c.hex === '#ff4d2e')
    expect(accent).toBeDefined()
    expect(accent?.fromToken).toBe(true)
    expect(accent?.tokenName).toBe('--brand-accent')
    // the accent appears in the token AND the .cta rule → counted twice
    expect(accent!.occurrences).toBeGreaterThanOrEqual(2)
    // token colors lead the ranking
    expect(kit.palette[0]!.fromToken).toBe(true)
    // rgb() token was normalized to hex
    expect(kit.palette.some((c) => c.hex === '#111111')).toBe(true)
  })

  it('extracts fonts with role inference and drops generic families', () => {
    const families = kit.fonts.map((f) => f.family)
    expect(families).toContain('Space Grotesk')
    expect(families).toContain('Inter')
    expect(families).not.toContain('sans-serif')
    expect(families).not.toContain('system-ui')
    const display = kit.fonts.find((f) => f.family === 'Space Grotesk')
    expect(display?.role).toBe('display')
    const body = kit.fonts.find((f) => f.family === 'Inter')
    expect(body?.role).toBe('body')
  })

  it('extracts images, prefers og/twitter, and excludes the logo img', () => {
    const urls = kit.images.map((i) => i.url)
    expect(urls).toContain('https://acme.com/static/og-card.png')
    expect(urls).toContain('https://cdn.acme.com/tw.png')
    expect(urls).toContain('https://acme.com/img/hero.jpg')
    expect(urls).not.toContain('https://acme.com/img/acme-logo.svg')
    expect(kit.images[0]!.source).toBe('og:image')
    const hero = kit.images.find((i) => i.url.endsWith('hero.jpg'))
    expect(hero?.source).toBe('img-hero')
  })

  it('records provenance', () => {
    expect(kit.extractedFrom).toEqual([BASE_URL])
    expect(kit.sourceUrl).toBe(BASE_URL)
  })
})

describe('extractBrandKit — typed outcome', () => {
  it('succeeds with supplied html and no fetch', async () => {
    const res = await extractBrandKit('acme.com', { html: FIXTURE_HTML })
    expect(res.succeeded).toBe(true)
    if (!res.succeeded) throw new Error('expected success')
    expect(res.kit.name).toBe('Acme Robotics')
    expect(res.warnings).toEqual([])
  })

  it('succeeds via an injected fetch', async () => {
    const res = await extractBrandKit('https://acme.com', { fetchImpl: htmlFetch(FIXTURE_HTML) })
    expect(res.succeeded).toBe(true)
    if (!res.succeeded) throw new Error('expected success')
    expect(res.kit.logos.length).toBeGreaterThan(0)
  })

  it('fails loud on a non-200 fetch (no empty kit)', async () => {
    const res = await extractBrandKit('https://acme.com', { fetchImpl: htmlFetch('', 503) })
    expect(res.succeeded).toBe(false)
    if (res.succeeded) throw new Error('expected failure')
    expect(res.stage).toBe('fetch')
    expect(res.error).toContain('503')
  })

  it('fails loud on a thrown fetch error', async () => {
    const boom: FetchLike = async () => {
      throw new Error('ECONNREFUSED')
    }
    const res = await extractBrandKit('https://acme.com', { fetchImpl: boom })
    expect(res.succeeded).toBe(false)
    if (res.succeeded) throw new Error('expected failure')
    expect(res.stage).toBe('fetch')
    expect(res.error).toContain('ECONNREFUSED')
  })

  it('rejects an invalid url at the input stage', async () => {
    const res = await extractBrandKit('ftp://nope', { html: '<html></html>' })
    expect(res.succeeded).toBe(false)
    if (res.succeeded) throw new Error('expected failure')
    expect(res.stage).toBe('input')
  })

  it('degrades gracefully on a bare page, emitting warnings not failure', async () => {
    const res = await extractBrandKit('https://bare.example', { html: '<html><head></head><body>hi</body></html>' })
    expect(res.succeeded).toBe(true)
    if (!res.succeeded) throw new Error('expected success')
    // a bare page still yields the /favicon.ico fallback logo
    expect(res.kit.logos.map((l) => l.source)).toContain('favicon')
    expect(res.warnings).toContain('No colors extracted — page has no inline CSS or design tokens.')
    expect(res.warnings).toContain('No custom fonts found — site likely uses system defaults.')
  })
})

describe('decideBrandKit — roles from candidates', () => {
  const kit = parseBrandKit(FIXTURE_HTML, BASE_URL)
  const decided = decideBrandKit(kit)

  it('assigns the saturated brand color as accent with a contrast text', () => {
    expect(decided.palette.accent).toBe('#ff4d2e')
    expect(decided.palette.accentText).toBe('#ffffff')
  })

  it('assigns a light background and a dark primary text', () => {
    expect(decided.palette.background).toBe('#ffffff')
    expect(decided.palette.textPrimary).toBe('#111111')
  })

  it('decides display + body fonts', () => {
    expect(decided.fonts.display?.family).toBe('Space Grotesk')
    expect(decided.fonts.body?.family).toBe('Inter')
  })

  it('surfaces the primary logo and image urls', () => {
    expect(decided.primaryLogoUrl).toBe('https://acme.com/img/acme-logo.svg')
    expect(decided.imageUrls).toContain('https://acme.com/img/hero.jpg')
  })
})
