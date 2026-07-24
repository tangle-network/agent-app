/**
 * Pure ruler tick-step and label math for the canvas rulers. Nothing here
 * touches React or the DOM — all interaction geometry is extracted so it can
 * be unit-tested without a browser.
 *
 * Canvas rulers show document-coordinate values (CSS px). Tick density adapts
 * to the current zoom so major ticks never sit closer than `minMajorSpacingPx`
 * screen pixels apart. The step table covers typical design zoom ranges; beyond
 * the table the step grows by doubling the last candidate.
 */

/** Ordered candidate major-tick steps in document px. Chosen so common design
 *  values (10, 50, 100, 500…) are always available as label boundaries. */
const TICK_STEP_CANDIDATES_PX = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const

/** Define spacing and visibility rules for major and minor ticks in a coordinate system */
export interface TickStep {
  /** Document-coordinate step between major ticks. */
  major: number
  /** Document-coordinate step between minor ticks (major / 5). */
  minor: number
  /** True when minor ticks should be drawn (they sit ≥ minMinorSpacingPx apart). */
  drawMinor: boolean
}

/**
 * Select the major tick step that keeps major ticks ≥ minMajorSpacingPx apart
 * at the given zoom. Minor ticks are rendered when they'd clear minMinorSpacingPx.
 *
 * Both spacing thresholds are SCREEN pixels — the caller provides `zoom` (screen
 * px per document px) so the result is zoom-independent.
 */
export function selectTickStep(input: {
  zoom: number
  minMajorSpacingPx?: number
  minMinorSpacingPx?: number
}): TickStep {
  if (!Number.isFinite(input.zoom) || input.zoom <= 0) {
    throw new Error(`zoom must be a positive finite number, got ${input.zoom}`)
  }
  const minMajor = input.minMajorSpacingPx ?? 40
  const minMinor = input.minMinorSpacingPx ?? 8

  let major = TICK_STEP_CANDIDATES_PX[TICK_STEP_CANDIDATES_PX.length - 1]!
  for (const candidate of TICK_STEP_CANDIDATES_PX) {
    if (candidate * input.zoom >= minMajor) {
      major = candidate
      break
    }
  }
  // Beyond the table: double until the constraint is satisfied.
  while (major * input.zoom < minMajor) {
    major = major * 2
  }

  const minor = major / 5
  const drawMinor = minor * input.zoom >= minMinor

  return { major, minor, drawMinor }
}

/** Define a ruler tick with a position and optional label for measurement markings */
export interface RulerTick {
  /** Position in document coordinates. */
  position: number
  /** Label text, or null for a minor tick. */
  label: string | null
}

/**
 * Generate all ticks visible in a ruler of `documentLength` document-px,
 * given the current tick step. The caller clips to the viewport; this produces
 * all ticks for the full document extent so the ruler can be rendered
 * declaratively without a separate clipping pass.
 */
export function buildRulerTicks(input: {
  documentLength: number
  step: TickStep
}): RulerTick[] {
  if (input.documentLength <= 0) return []

  const { major, minor, drawMinor } = input.step
  const ticks: RulerTick[] = []

  for (let pos = 0; pos <= input.documentLength; pos += major) {
    ticks.push({ position: pos, label: formatRulerLabel(pos) })
    if (!drawMinor) continue
    for (let m = 1; m < 5; m += 1) {
      const minorPos = pos + m * minor
      if (minorPos >= input.documentLength) break
      ticks.push({ position: minorPos, label: null })
    }
  }

  return ticks
}

/** Format a document-px position as a compact label: integers stay whole,
 *  decimals are rounded to 1 place. Values ≥ 1000 are compacted to "1k" etc. */
export function formatRulerLabel(value: number): string {
  if (!Number.isFinite(value)) return ''
  if (Math.abs(value) >= 1000) {
    const k = value / 1000
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/**
 * Convert a screen-coordinate pointer position to a document-coordinate guide
 * drop position, given the ruler's scroll offset and zoom. Used by both the
 * horizontal and vertical ruler drag-guide creation paths.
 *
 * `scrollOffset` is how many document-px of the ruler are scrolled off-screen
 * to the left/top. `pointerScreenPx` is the cursor position in screen px
 * relative to the ruler element's origin.
 */
export function screenToDocumentPosition(input: {
  pointerScreenPx: number
  scrollOffset: number
  zoom: number
}): number {
  if (!Number.isFinite(input.zoom) || input.zoom <= 0) {
    throw new Error(`zoom must be a positive finite number, got ${input.zoom}`)
  }
  return input.pointerScreenPx / input.zoom + input.scrollOffset
}

/** Snap a guide drop position to the nearest major tick if within
 *  `snapThresholdPx` document px; otherwise returns the raw position. */
export function snapGuideToTick(position: number, step: TickStep, snapThresholdPx: number): number {
  const nearest = Math.round(position / step.major) * step.major
  return Math.abs(nearest - position) <= snapThresholdPx ? nearest : position
}

// ---------------------------------------------------------------------------
// Z-order index math — extracted so Toolbar and LayersPanel agree
// ---------------------------------------------------------------------------

/** Index of the topmost element for a given owner length. */
export function topIndex(ownerLength: number): number {
  return ownerLength - 1
}

/** Move an element one step toward the top (higher index = above in z-order).
 *  Returns the current index unchanged if already at the top. */
export function indexForward(current: number, ownerLength: number): number {
  return Math.min(current + 1, ownerLength - 1)
}

/** Move an element one step toward the bottom (lower index = below). Returns
 *  the current index unchanged if already at the bottom. */
export function indexBackward(current: number): number {
  return Math.max(current - 1, 0)
}

/** Clamp an arbitrary target index to valid range. */
export function clampIndex(target: number, ownerLength: number): number {
  return Math.max(0, Math.min(target, ownerLength - 1))
}
