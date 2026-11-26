import { gsap } from "gsap"

import type { FrameControls, FrameFx } from "../../art/frame.ts"

type Drained = Partial<Pick<FrameFx, "desaturate" | "crush">>

export interface Drain {
  /** Tweens the given keys from where the frame has them now; any tween before it stops. */
  to(target: Drained, duration: number, ease?: string): gsap.core.Tween
  /** Sets the given keys at once, stopping any tween. */
  set(target: Drained): void
}

/**
 * The scene drained to grey behind a modal screen, through the frame's grade: one for the UI, shared by the title,
 * pause and results, so whichever screen came last decides and leaving one can't strand the scene grey. Pause and
 * results move only `desaturate`: vfx's special writes `crush` every frame of its fade.
 */
export const createDrain = (frame: FrameControls): Drain => {
  let tween: gsap.core.Tween | null = null
  return {
    to: (target, duration, ease = "power2.out") => {
      tween?.kill()
      const now = frame.get()
      const values: Drained = {}
      if (target.desaturate !== undefined) values.desaturate = now.desaturate
      if (target.crush !== undefined) values.crush = now.crush
      tween = gsap.to(values, { ...target, duration, ease, onUpdate: () => frame.set(values) })
      return tween
    },
    set: (target) => {
      tween?.kill()
      tween = null
      frame.set(target)
    }
  }
}
