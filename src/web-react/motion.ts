/**
 * The React half of the motion primitives that ship in `src/theme/tokens.css`.
 *
 * The stylesheet owns every keyframe, duration and easing, and that is the
 * whole point: a component that writes its own timing is invisible to the
 * reduced-motion collapse at `:root`, so "it writes its own timing" and "it
 * ignores reduced motion" are the same defect. The one thing CSS cannot supply
 * is WHERE in a group a row sits, which is per-element data — hence these two
 * helpers and nothing else.
 */

import { useState, type CSSProperties } from 'react'

/**
 * Position in a staggered `.agent-arrive` group. `--stagger-index` is a custom
 * property and `CSSProperties` has no index signature for one, so the cast is
 * the only way to hand React a value tokens.css already defines (it declares
 * the property with a `0` default and caps the delay at 8 steps internally, so
 * a long list never opens with a multi-second cascade).
 *
 * Use it directly only where the group's order is FIXED once rendered — an
 * ask's option rows, a turn's append-only tool segments. A list that can
 * re-sort wants {@link useArrivalStyle}.
 *
 * `base` merges a caller's own style, because a row that carries layout of its
 * own would otherwise have to spread the two itself at every call site, and the
 * spread order matters: the index must win, or a stale `--stagger-index` on the
 * base silently overrides the position being asked for.
 */
export function staggerStyle(index: number, base?: CSSProperties): CSSProperties {
  return { ...base, '--stagger-index': index } as CSSProperties
}

/**
 * The same style, frozen at the row's first render.
 *
 * A settled `.agent-arrive` is finished, not inert: `animation-delay` is part
 * of its timing, so handing an already-arrived row a LARGER delay pushes it
 * back into the animation's before-phase and it plays again. Any list that
 * re-sorts does exactly that — `mergeActivityPages` sorts newest-first, so one
 * newer run landing on a refresh shifts every row's index by one and the whole
 * panel would re-animate because nothing about it changed. Freezing the index
 * at mount makes the arrival a property of ARRIVING rather than of the row's
 * current position, which is the difference between choreography and flicker.
 *
 * Rules of hooks: a row that needs this is a component, not a `.map` body.
 */
export function useArrivalStyle(index: number): CSSProperties {
  const [frozen] = useState(index)
  return staggerStyle(frozen)
}
