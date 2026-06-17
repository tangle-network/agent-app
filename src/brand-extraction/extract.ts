/**
 * Brand-kit extraction engine.
 *
 * Given a website URL (or raw HTML), parse the page and pull a typed BrandKit:
 * logo candidates, color palette, fonts, and prominent images. Parsing is
 * regex-based on purpose — this runs on Cloudflare Workers and other edge
 * runtimes where DOM libraries (jsdom/cheerio) are unavailable, and the page
 * structures we read (link tags, meta tags, CSS custom properties, font-family
 * declarations) are flat enough that a DOM buys nothing.
 *
 * Degrades gracefully: a missing favicon, no CSS tokens, or an image-only page
 * each narrow the kit rather than failing it. The ONLY hard failures are a bad
 * input (no html and no fetch) and a fetch error — both returned as a typed
 * `{ succeeded: false }` outcome so callers never mistake an empty kit for a
 * real one.
 */

import type {
  BrandColor,
  BrandExtractionResult,
  BrandFont,
  BrandImage,
  BrandKit,
  BrandLogoCandidate,
  ExtractBrandKitOptions,
  FetchLike,
} from './types'

const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_MAX_PER_LIST = 12

// ── URL helpers ──────────────────────────────────────────────────────────────

/** Normalize a user-supplied site URL: add https:// when scheme-less, validate. */
export function normalizeSiteUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // A non-http(s) scheme is an explicit reject — don't paper over it by
  // prepending https:// (that would turn "ftp://x" into host "ftp").
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return null
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

/** Resolve a possibly-relative href against the page URL. Returns null for
 *  data: URIs and unresolvable values — we want servable http(s) URLs only. */
function absolutize(href: string, base: string): string | null {
  const v = href.trim()
  if (!v || v.startsWith('data:') || v.startsWith('javascript:')) return null
  try {
    const u = new URL(v, base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

// ── Attribute parsing ────────────────────────────────────────────────────────

/** Pull all `<tag ...>` open-tags from html (case-insensitive). */
function matchTags(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>`, 'gi')
  return html.match(re) ?? []
}

/** Read an attribute value from a single tag string. Handles quoted and
 *  unquoted values. Returns undefined when absent. */
function attr(tag: string, name: string): string | undefined {
  const quoted = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)
  if (quoted) return decodeEntities(quoted[1] ?? '')
  const bare = new RegExp(`\\b${name}\\s*=\\s*([^\\s"'>]+)`, 'i').exec(tag)
  return bare ? decodeEntities(bare[1] ?? '') : undefined
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/gi, '/')
}

// ── Name / description ───────────────────────────────────────────────────────

function extractName(html: string): string | undefined {
  for (const tag of matchTags(html, 'meta')) {
    const prop = (attr(tag, 'property') ?? attr(tag, 'name'))?.toLowerCase()
    if (prop === 'og:site_name') {
      const c = attr(tag, 'content')?.trim()
      if (c) return c
    }
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  if (title) {
    // "Acme — the best widget" → "Acme". Split on common separators, take head.
    const head = (decodeEntities(title).split(/\s+[|–—\-:·]\s+/)[0] ?? '').trim()
    if (head) return head
  }
  return undefined
}

function extractDescription(html: string): string | undefined {
  for (const tag of matchTags(html, 'meta')) {
    const prop = (attr(tag, 'property') ?? attr(tag, 'name'))?.toLowerCase()
    if (prop === 'description' || prop === 'og:description') {
      const c = attr(tag, 'content')?.trim()
      if (c) return c
    }
  }
  return undefined
}

// ── Logos ────────────────────────────────────────────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
}

function mimeFromUrl(url: string): string | undefined {
  const ext = new URL(url).pathname.split('.').pop()?.toLowerCase()
  return ext ? MIME_BY_EXT[ext] : undefined
}

function parseSizes(sizes: string | undefined): { width?: number; height?: number } {
  if (!sizes) return {}
  const m = /(\d+)\s*[x×]\s*(\d+)/i.exec(sizes)
  if (!m) return {}
  return { width: Number(m[1]), height: Number(m[2]) }
}

function extractLogos(html: string, base: string): BrandLogoCandidate[] {
  const out: BrandLogoCandidate[] = []
  const seen = new Set<string>()
  const push = (c: BrandLogoCandidate) => {
    if (seen.has(c.url)) return
    seen.add(c.url)
    out.push(c)
  }

  // link rel icons / apple-touch-icon
  for (const tag of matchTags(html, 'link')) {
    const rel = attr(tag, 'rel')?.toLowerCase() ?? ''
    const href = attr(tag, 'href')
    if (!href) continue
    const url = absolutize(href, base)
    if (!url) continue
    const { width, height } = parseSizes(attr(tag, 'sizes'))
    if (rel.includes('apple-touch-icon')) {
      push({ url, source: 'apple-touch-icon', confidence: 0.7, width, height, mimeType: mimeFromUrl(url) })
    } else if (rel.split(/\s+/).includes('icon') || rel.includes('shortcut icon')) {
      push({ url, source: 'favicon', confidence: 0.5, width, height, mimeType: mimeFromUrl(url) })
    }
  }

  // og:image (often shows the logo in context — moderate confidence)
  for (const tag of matchTags(html, 'meta')) {
    const prop = (attr(tag, 'property') ?? attr(tag, 'name'))?.toLowerCase()
    if (prop === 'og:image' || prop === 'og:image:url') {
      const href = attr(tag, 'content')
      const url = href ? absolutize(href, base) : null
      if (url) push({ url, source: 'og:image', confidence: 0.55, mimeType: mimeFromUrl(url) })
    }
  }

  // <img> whose src/class/alt/id mentions "logo" — the strongest in-page signal
  for (const tag of matchTags(html, 'img')) {
    const src = attr(tag, 'src') ?? attr(tag, 'data-src')
    if (!src) continue
    const alt = attr(tag, 'alt')
    const cls = attr(tag, 'class') ?? ''
    const id = attr(tag, 'id') ?? ''
    const looksLikeLogo = /logo|brand|wordmark/i.test(`${src} ${alt ?? ''} ${cls} ${id}`)
    if (!looksLikeLogo) continue
    const url = absolutize(src, base)
    if (!url) continue
    const w = attr(tag, 'width')
    const h = attr(tag, 'height')
    push({
      url,
      source: 'img-logo',
      confidence: 0.85,
      alt,
      width: w ? Number(w) || undefined : undefined,
      height: h ? Number(h) || undefined : undefined,
      mimeType: mimeFromUrl(url),
    })
  }

  // No favicon link tag at all? Fall back to the conventional /favicon.ico —
  // it almost always exists. Lowest confidence.
  if (!out.some((l) => l.source === 'favicon' || l.source === 'apple-touch-icon')) {
    const fav = absolutize('/favicon.ico', base)
    if (fav) push({ url: fav, source: 'favicon', confidence: 0.3, mimeType: 'image/x-icon' })
  }

  return out.sort((a, b) => b.confidence - a.confidence)
}

// ── Colors ───────────────────────────────────────────────────────────────────

/** Normalize any CSS color literal to #rrggbb / #rrggbbaa hex, or null. */
export function normalizeColor(raw: string): string | null {
  const v = raw.trim().toLowerCase()
  // #rgb / #rgba / #rrggbb / #rrggbbaa
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v)
  if (hex) {
    const h = hex[1] ?? ''
    // Expand 3/4-digit shorthand by doubling each nibble.
    if (h.length === 3 || h.length === 4) {
      return `#${h.split('').map((c) => c + c).join('')}`
    }
    return `#${h}`
  }
  // rgb()/rgba()
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/.exec(v)
  if (rgb) {
    const to255 = (n: string | undefined) => Math.max(0, Math.min(255, Math.round(Number(n))))
    const r = to255(rgb[1]).toString(16).padStart(2, '0')
    const g = to255(rgb[2]).toString(16).padStart(2, '0')
    const b = to255(rgb[3]).toString(16).padStart(2, '0')
    let a = ''
    if (rgb[4] !== undefined) {
      const av = rgb[4].endsWith('%') ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4])
      const ai = Math.max(0, Math.min(255, Math.round(av * 255)))
      if (ai < 255) a = ai.toString(16).padStart(2, '0')
    }
    return `#${r}${g}${b}${a}`
  }
  return null
}

const COLOR_LITERAL_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g
const ROOT_VAR_RE = /(--[a-z0-9-]*(?:color|colour|bg|background|accent|brand|primary|secondary|surface|text|fg|ink)[a-z0-9-]*)\s*:\s*([^;}{]+)/gi

function extractPalette(html: string): BrandColor[] {
  const byHex = new Map<string, BrandColor>()
  const bump = (hex: string, fromToken: boolean, tokenName?: string) => {
    const existing = byHex.get(hex)
    if (existing) {
      existing.occurrences += 1
      if (fromToken && !existing.fromToken) {
        existing.fromToken = true
        existing.tokenName = tokenName
      }
    } else {
      byHex.set(hex, { hex, occurrences: 1, fromToken, ...(tokenName ? { tokenName } : {}) })
    }
  }

  // CSS custom properties — highest-fidelity design tokens.
  for (const m of html.matchAll(ROOT_VAR_RE)) {
    const tokenName = m[1]
    const value = m[2]
    if (!value) continue
    const lit = value.match(COLOR_LITERAL_RE)?.[0]
    if (!lit) continue
    const hex = normalizeColor(lit)
    if (hex) bump(hex, true, tokenName)
  }

  // All other color literals across the document (inline styles, <style>).
  for (const m of html.matchAll(COLOR_LITERAL_RE)) {
    const hex = normalizeColor(m[0])
    if (hex) bump(hex, false)
  }

  // Rank: token-sourced first, then by popularity. Drop pure white/black noise
  // to the back so a real brand color leads.
  const isNeutral = (h: string) => /^#(0{6}|f{6})(ff)?$/i.test(h)
  return [...byHex.values()].sort((a, b) => {
    if (a.fromToken !== b.fromToken) return a.fromToken ? -1 : 1
    const an = isNeutral(a.hex) ? 1 : 0
    const bn = isNeutral(b.hex) ? 1 : 0
    if (an !== bn) return an - bn
    return b.occurrences - a.occurrences
  })
}

// ── Fonts ────────────────────────────────────────────────────────────────────

const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'inherit', 'initial', 'unset',
])

/** font-family declarations, with the selector chunk preceding them for role
 *  inference. Captures the selector text in group 1, the stack in group 2. */
const FONT_DECL_RE = /([^{}]*)\{[^{}]*font-family\s*:\s*([^;}{]+)[;}]/gi

function parseFontStack(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

function roleFromSelector(selector: string): 'display' | 'body' | 'unknown' {
  const s = selector.toLowerCase()
  if (/\b(h[1-3]|\.h[1-3]|heading|title|display|hero)\b/.test(s)) return 'display'
  if (/\b(body|p|html|\.text|\.content|root|:root|\*)\b/.test(s)) return 'body'
  return 'unknown'
}

function extractFonts(html: string): BrandFont[] {
  // Restrict to <style> blocks + the whole doc; inline style="" attributes are
  // included because the regex matches any `{...font-family...}` chunk, but we
  // also scan style attributes explicitly below.
  const byFamily = new Map<string, BrandFont>()
  const consider = (family: string, stack: string[], role: BrandFont['role']) => {
    const key = family.toLowerCase()
    if (!family || GENERIC_FAMILIES.has(key)) return
    const existing = byFamily.get(key)
    if (existing) {
      existing.occurrences += 1
      if (existing.role === 'unknown' && role !== 'unknown') existing.role = role
    } else {
      byFamily.set(key, { family, stack, role, occurrences: 1 })
    }
  }

  for (const m of html.matchAll(FONT_DECL_RE)) {
    const selector = m[1] ?? ''
    const stack = parseFontStack(m[2])
    const primary = stack[0]
    if (!primary) continue
    consider(primary, stack, roleFromSelector(selector))
  }

  // Bare `font-family:` declarations inside inline style attributes and tokens.
  const BARE_RE = /font-family\s*:\s*([^;"'}{]+)/gi
  for (const m of html.matchAll(BARE_RE)) {
    const stack = parseFontStack(m[1])
    const primary = stack[0]
    if (!primary) continue
    consider(primary, stack, 'unknown')
  }

  // Google Fonts <link href="...family=Inter:wght@400..."> — strong signal.
  for (const tag of matchTags(html, 'link')) {
    const href = attr(tag, 'href') ?? ''
    if (!/fonts\.googleapis\.com/i.test(href)) continue
    for (const fam of href.matchAll(/family=([^:&]+)/gi)) {
      const captured = fam[1]
      if (!captured) continue
      const family = decodeURIComponent(captured.replace(/\+/g, ' ')).trim()
      consider(family, [family], 'display')
    }
  }

  return [...byFamily.values()].sort((a, b) => {
    const rank = (r: BrandFont['role']) => (r === 'display' ? 0 : r === 'body' ? 1 : 2)
    const rr = rank(a.role) - rank(b.role)
    if (rr !== 0) return rr
    return b.occurrences - a.occurrences
  })
}

// ── Images ───────────────────────────────────────────────────────────────────

function extractImages(html: string, base: string): BrandImage[] {
  const out: BrandImage[] = []
  const seen = new Set<string>()
  const push = (img: BrandImage) => {
    if (seen.has(img.url)) return
    seen.add(img.url)
    out.push(img)
  }

  for (const tag of matchTags(html, 'meta')) {
    const prop = (attr(tag, 'property') ?? attr(tag, 'name'))?.toLowerCase()
    const href = attr(tag, 'content')
    const url = href ? absolutize(href, base) : null
    if (!url) continue
    if (prop === 'og:image' || prop === 'og:image:url') push({ url, source: 'og:image' })
    else if (prop === 'twitter:image' || prop === 'twitter:image:src') push({ url, source: 'twitter:image' })
  }

  for (const tag of matchTags(html, 'img')) {
    const src = attr(tag, 'src') ?? attr(tag, 'data-src')
    if (!src) continue
    const url = absolutize(src, base)
    if (!url) continue
    const cls = `${attr(tag, 'class') ?? ''} ${attr(tag, 'id') ?? ''}`
    // Skip obvious logos/icons — those go in the logos list, not images.
    if (/logo|icon|favicon|wordmark/i.test(`${url} ${cls}`)) continue
    const isHero = /hero|banner|cover|feature|splash/i.test(cls)
    const w = attr(tag, 'width')
    const h = attr(tag, 'height')
    push({
      url,
      source: isHero ? 'img-hero' : 'img-content',
      alt: attr(tag, 'alt'),
      width: w ? Number(w) || undefined : undefined,
      height: h ? Number(h) || undefined : undefined,
    })
  }

  const rank = (s: BrandImage['source']) =>
    s === 'og:image' ? 0 : s === 'twitter:image' ? 1 : s === 'img-hero' ? 2 : 3
  return out.sort((a, b) => rank(a.source) - rank(b.source))
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Parse already-fetched HTML into a BrandKit. Pure — no network. Exposed so
 *  callers that hold the HTML (or want to combine multiple pages) can reuse the
 *  parsing without re-fetching. */
export function parseBrandKit(html: string, sourceUrl: string, maxPerList = DEFAULT_MAX_PER_LIST): BrandKit {
  const logos = extractLogos(html, sourceUrl).slice(0, maxPerList)
  const palette = extractPalette(html).slice(0, maxPerList)
  const fonts = extractFonts(html).slice(0, maxPerList)
  const images = extractImages(html, sourceUrl).slice(0, maxPerList)
  const name = extractName(html)
  const description = extractDescription(html)

  return {
    sourceUrl,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    logos,
    palette,
    fonts,
    images,
    extractedFrom: [sourceUrl],
  }
}

/**
 * Fetch a website (or use supplied HTML) and extract its BrandKit.
 *
 * Returns a typed outcome — callers MUST check `succeeded`. A fetch failure or
 * empty input is a real, surfaced error, never an empty kit masquerading as a
 * result. Parsing itself never throws: a malformed page yields a sparse kit
 * with warnings, which is information, not failure.
 */
export async function extractBrandKit(
  url: string,
  options: ExtractBrandKitOptions = {},
): Promise<BrandExtractionResult> {
  const { html: providedHtml, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, maxPerList = DEFAULT_MAX_PER_LIST } = options
  const warnings: string[] = []

  const sourceUrl = normalizeSiteUrl(url)
  if (!sourceUrl) {
    return { succeeded: false, error: `Not a valid http(s) URL: ${JSON.stringify(url)}`, stage: 'input' }
  }

  let html = providedHtml
  if (html === undefined) {
    const doFetch: FetchLike | undefined =
      fetchImpl ?? (typeof globalThis.fetch === 'function'
        ? (u, init) => globalThis.fetch(u, init as RequestInit)
        : undefined)
    if (!doFetch) {
      return { succeeded: false, error: 'No html provided and no fetch implementation available', stage: 'input' }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await doFetch(sourceUrl, {
        signal: controller.signal,
        headers: { 'user-agent': 'TangleBrandExtractor/1.0 (+https://tangle.tools)' },
      })
      if (!res.ok) {
        return { succeeded: false, error: `Fetch failed: HTTP ${res.status} for ${sourceUrl}`, stage: 'fetch' }
      }
      html = await res.text()
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { succeeded: false, error: `Fetch error for ${sourceUrl}: ${reason}`, stage: 'fetch' }
    } finally {
      clearTimeout(timer)
    }
  }

  if (!html.trim()) {
    return { succeeded: false, error: `Empty document for ${sourceUrl}`, stage: 'parse' }
  }

  const kit = parseBrandKit(html, sourceUrl, maxPerList)

  if (kit.logos.length === 0) warnings.push('No logo candidates found.')
  if (kit.palette.length === 0) warnings.push('No colors extracted — page has no inline CSS or design tokens.')
  if (kit.fonts.length === 0) warnings.push('No custom fonts found — site likely uses system defaults.')
  if (kit.images.length === 0) warnings.push('No prominent images found.')

  return { succeeded: true, kit, warnings }
}
