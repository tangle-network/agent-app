/**
 * The Brand roles the email layout paints with, as literal hex. Email clients
 * cannot read CSS variables, and importing `@tangle-network/brand` at runtime
 * would load React into a server-only renderer, so the values live here and
 * `tests/email/palette.test.ts` fails when they drift from Brand's `palettes`.
 */
export const EMAIL_PALETTE = {
  light: {
    canvas: '#eceef3',
    card: '#ffffff',
    well: '#f6f7fa',
    hairline: '#c7c6d6',
    ink: '#2d2d2d',
    inkSecondary: '#3f3f3f',
    inkMuted: '#4c4c4c',
    accent: '#4c3fc5',
    onAccent: '#ffffff',
    accentText: '#3c32e9',
  },
  dark: {
    canvas: '#0a0a14',
    card: '#191826',
    well: '#12111f',
    hairline: '#2a293d',
    ink: '#e6e6e6',
    inkSecondary: '#c7c7c7',
    inkMuted: '#b5b5b5',
    accent: '#4c3fc5',
    onAccent: '#ffffff',
    accentText: '#a5b4fc',
  },
} as const

/**
 * Brand's `--font-sans` stack with the system faces email clients actually
 * have. No client used for this mail loads web fonts reliably, so Inter shows
 * only where it is installed and the platform UI face carries the rest.
 */
export const EMAIL_FONT_STACK =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Helvetica, Arial, sans-serif"

/** The postal line every Tangle email footer carries (Stripe business profile support address). */
export const TANGLE_POSTAL_ADDRESS =
  'Tangle Technologies, Inc., 3740 South Ocean Blvd, #1407, Highland Beach, FL 33487, USA'
