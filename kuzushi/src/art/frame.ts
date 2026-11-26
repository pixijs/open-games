/**
 * Whole-frame looks for impact frames, flashes and focus, applied by look's grade pass (src/look/post.ts).
 * The host makes one set of controls and hands it to every install as `HostContext.frame`: vfx drives it, look
 * binds it to its shader. Every value is 0 (off) to 1 (full) unless noted, and holds until changed, so an effect
 * that sets one also clears it.
 *
 * @example
 * ```ts
 * context.frame.set({ impact: 1, invert: 1 })   // an inverted black, white and accent impact frame
 * context.frame.set({ radialBlur: 0.8, centerX: 0.5, centerY: 0.45 })
 * context.frame.reset()                          // a clean frame
 * ```
 */
export interface FrameFx {
  /** Inverts light and dark; the accent stays. */
  invert: number
  /** Flattens the frame to four tones. */
  posterize: number
  /** The impact frame: a hard ink and paper threshold, the accent kept. Pair with `invert` or `redImpact` for the other kinds. */
  impact: number
  /** Turns the impact frame's shadows to the zone's accent and its accents to ink: the accent-flooded kind. */
  redImpact: number
  /** Washes the frame toward the zone's accent, keeping its light and dark. */
  redFlash: number
  /** Washes the frame toward paper white. */
  whiteFlash: number
  /** Removes all colour, the accent included. */
  desaturate: number
  /** Crushes the mid-tones toward ink, for the special's drained grade. */
  crush: number
  /** Zoom blur toward the centre point. */
  radialBlur: number
  /** The centre point of the zoom blur and the focus vignette, as a fraction of the view: 0 left to 1 right. */
  centerX: number
  /** The centre point, as a fraction of the view: 0 top to 1 bottom. */
  centerY: number
  /** Extra vignette round the centre point, on top of the resting one, for focus moments such as the special. */
  vignette: number
  /** Draws the frame as its outlines alone, paper (the accent kept) on ink: a room inking in behind a transition. */
  lines: number
}

const RESTING_FRAME: Readonly<FrameFx> = {
  invert: 0,
  posterize: 0,
  impact: 0,
  redImpact: 0,
  redFlash: 0,
  whiteFlash: 0,
  desaturate: 0,
  crush: 0,
  radialBlur: 0,
  centerX: 0.5,
  centerY: 0.5,
  vignette: 0,
  lines: 0
}

type Apply = (values: Readonly<FrameFx>) => void

export interface FrameControls {
  /** The values now on screen. */
  get(): Readonly<FrameFx>
  /** Changes some values; they show on the next drawn frame. */
  set(patch: Partial<FrameFx>): void
  /** Back to a clean frame. */
  reset(): void
  /** For look's grade pass: receives every change. Returns the unbind. */
  bind(apply: Apply): () => void
}

export const makeFrameControls = (): FrameControls => {
  const values: FrameFx = { ...RESTING_FRAME }
  let applied: Apply | null = null
  const set = (patch: Partial<FrameFx>) => {
    Object.assign(values, patch)
    applied?.(values)
  }
  return {
    get: () => values,
    set,
    reset: () => set(RESTING_FRAME),
    bind: (apply) => {
      applied = apply
      apply(values)
      return () => {
        if (applied === apply) applied = null
      }
    }
  }
}
