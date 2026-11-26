import type { FrameControls, FrameFx } from "../art/frame.ts"

/** What the frame shows for an impact frame: the world inverted to ink on paper, flooded red, or cut to stark paper on ink. */
export type ImpactKind = "none" | "ink" | "red" | "stark"

const IMPACT: Readonly<Record<ImpactKind, Partial<FrameFx>>> = {
  none: { impact: 0, invert: 0, redImpact: 0 },
  ink: { impact: 1, invert: 1, redImpact: 0 },
  red: { impact: 1, invert: 0, redImpact: 1 },
  stark: { impact: 1, invert: 0, redImpact: 0 }
}

export const setImpact = (frame: FrameControls, kind: ImpactKind): void => frame.set(IMPACT[kind])

/** True while an impact frame turns the picture's light to ink, so flat effects over it must flip too. */
export const isInked = (values: Readonly<FrameFx>): boolean => values.impact > 0.5 && (values.invert > 0.5 || values.redImpact > 0.5)

/** Centres the focus vignette and zoom blur on screen point (x, y) of a `width` by `height` view, blurring by `amount` (0 to 1). */
export const focusOn = (frame: FrameControls, x: number, y: number, width: number, height: number, amount: number): void =>
  frame.set({ centerX: x / Math.max(1, width), centerY: y / Math.max(1, height), radialBlur: amount })

/** The special's drained grade, vignette and blur all off, centred again. */
export const settleFocus = (frame: FrameControls): void => frame.set({ crush: 0, vignette: 0, radialBlur: 0, centerX: 0.5, centerY: 0.5 })
