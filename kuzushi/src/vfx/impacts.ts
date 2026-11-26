import type { FrameControls } from "../art/frame.ts"
import { settings } from "../art/settings.ts"
import type { Cues } from "./cues.ts"
import { ON_TWOS } from "./cues.ts"
import { setImpact } from "./frame.ts"
import type { ImpactKind } from "./frame.ts"
import type { Screen } from "./screen.ts"

/**
 * Real seconds that must pass between full-screen impact frames, so a busy fight never strobes and flashes stay
 * under three a second. The special's own frames are choreographed and skip the wait, but still start it.
 */
const GAP = 0.45

export interface ImpactOptions {
  /** Drawings a second; 24 by default. */
  readonly fps?: number
  /** Plays even inside the gap after another frame: only for the special. */
  readonly force?: boolean
}

/**
 * The frame's big punctuation. `frame` cuts the whole picture to impact frames, one kind per drawing; inside the gap
 * after another one, for a viewer who asked for reduced motion, or with impact flashes set to reduced, it darkens the
 * frame's edge instead, and with them off it draws nothing. `pulse`
 * closes an ink or red vignette round the frame for a few drawings on twos: the small blow's cousin of a frame.
 */
export interface Impacts {
  frame(kinds: ReadonlyArray<Exclude<ImpactKind, "none">>, options?: ImpactOptions): void
  pulse(color: "ink" | "red", alpha: number, drawings?: number): void
}

export const makeImpacts = (cues: Cues, frame: FrameControls, screen: Screen, now: () => number, calm: () => boolean): Impacts => {
  let clearAt = Number.NEGATIVE_INFINITY

  const pulse = (color: "ink" | "red", alpha: number, drawings = 1) => {
    cues.play({
      clock: "real",
      life: (drawings + 1) / ON_TWOS,
      fps: ON_TWOS,
      draw: (drawing) => screen.setPulse(color, drawing < drawings ? alpha : alpha * 0.4),
      end: () => screen.setPulse(color, 0)
    })
  }

  return {
    pulse,
    frame: (kinds, options = {}) => {
      const level = settings.get().flashes
      if (level === "off") return
      const fps = options.fps ?? 24
      const length = kinds.length / fps
      if (options.force !== true && now() < clearAt) {
        pulse("ink", 0.5)
        return
      }
      clearAt = now() + length + GAP
      if (calm() || level === "reduced") {
        pulse("ink", 0.9, Math.max(1, Math.round(length * ON_TWOS)))
        return
      }
      cues.play({
        clock: "real",
        life: length,
        fps,
        draw: (drawing) => setImpact(frame, kinds[drawing] ?? "none"),
        end: () => setImpact(frame, "none")
      })
    }
  }
}
