/** Shared vocabulary for mutually exclusive canvas gestures. */
export interface MarqueeState {
  active: boolean
  startDocX: number
  startDocY: number
  endDocX: number
  endDocY: number
}

export const NO_MARQUEE: MarqueeState = { active: false, startDocX: 0, startDocY: 0, endDocX: 0, endDocY: 0 }

export type GestureMode = 'idle' | 'pan' | 'marquee' | 'drag'
