/**
 * sRGB / HSL / OKLCH conversions for the token-contract test.
 *
 * tokens.css ships each neutral ramp stop twice — once as the oklch SOURCE and
 * once as an HSL channel-triple mirror a pinned consumer's `hsl(var(--x))` can
 * still consume. CSS cannot derive the second from the first, so the only thing
 * standing between the two forms and silent drift is a test that converts one
 * into the other. This is that conversion.
 *
 * Matrices are Björn Ottosson's published OKLab constants (public domain,
 * bottosson.github.io/posts/oklab). Round-tripping an sRGB colour through them
 * returns within ~1e-6, so the tolerance a caller applies is measuring token
 * drift, not conversion error.
 *
 * Test-only: this is not a shipped capability and has no subpath.
 */

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const linearToSrgb = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

/** An sRGB colour with channels in 0…1. */
export type Rgb = readonly [number, number, number]
/** Lightness 0…1, chroma, hue in degrees. */
export type Oklch = readonly [number, number, number]

/** `h` in degrees, `s`/`l` as percentages (the shadcn channel-triple form). */
function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = ((h % 360) + 360) % 360
  const sat = s / 100
  const lum = l / 100
  const c = (1 - Math.abs(2 * lum - 1)) * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = lum - c / 2
  const [r, g, b] =
    hue < 60 ? [c, x, 0]
    : hue < 120 ? [x, c, 0]
    : hue < 180 ? [0, c, x]
    : hue < 240 ? [0, x, c]
    : hue < 300 ? [x, 0, c]
    : [c, 0, x]
  return [r + m, g + m, b + m]
}

function rgbToOklch([r, g, b]: Rgb): Oklch {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const hue = (Math.atan2(bb, a) * 180) / Math.PI
  return [lightness, Math.hypot(a, bb), hue < 0 ? hue + 360 : hue]
}

export function oklchToRgb([lightness, chroma, hue]: Oklch): Rgb {
  const h = (hue * Math.PI) / 180
  const a = chroma * Math.cos(h)
  const b = chroma * Math.sin(h)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

export const hslTripleToOklch = (triple: string): Oklch => {
  const [h, s, l] = triple.trim().split(/\s+/).map((part) => Number.parseFloat(part))
  if (h === undefined || s === undefined || l === undefined || [h, s, l].some(Number.isNaN)) {
    throw new Error(`not an "H S% L%" channel triple: ${triple}`)
  }
  return rgbToOklch(hslToRgb(h, s, l))
}

/** WCAG 2.x relative luminance. */
const luminance = ([r, g, b]: Rgb): number =>
  0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)

/** WCAG 2.x contrast ratio between two opaque colours. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Alpha-composite `fg` at `alpha` (0…1) over an opaque `bg` — what a 1px hairline paints. */
export const compositeOver = (fg: Rgb, alpha: number, bg: Rgb): Rgb =>
  [0, 1, 2].map((i) => fg[i]! * alpha + bg[i]! * (1 - alpha)) as unknown as Rgb
