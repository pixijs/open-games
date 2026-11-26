import type { FrameTime } from "../host/types.ts"

/**
 * Effect time. `game` runs with the gameplay clock, so hit-stop holds an effect on its drawing (a held key pose)
 * and slow motion slows it; `real` runs whenever the world is on screen and not paused (play and the results
 * screens), for the special's choreography while the world stands frozen and for the impact frames that end a run.
 */
export type ClockKind = "game" | "real"

export interface Clocks {
  game: number
  real: number
}

export const advanceClocks = (clocks: Clocks, frame: FrameTime, running: boolean): void => {
  clocks.game = frame.gameDt
  clocks.real = running ? frame.dt : 0
}

/** Drawings a second when an effect animates on twos (four game frames each at 60 Hz). */
export const ON_TWOS = 15

/** Drawings a second for the flat effects over the frame (the exit chevrons, the transitions), on twos at 24 fps. */
export const SCREEN_TWOS = 12

/** A timed effect drawn in held drawings: `draw` runs only when the drawing changes, `follow` every frame. */
export interface Cue {
  readonly clock: ClockKind
  /** Seconds it lasts. */
  readonly life: number
  /** Drawings a second. */
  readonly fps: number
  draw(drawing: number, age: number): void
  follow?(age: number): void
  end?(): void
}

interface Running {
  readonly cue: Cue
  age: number
  drawing: number
}

export interface Cues {
  play(cue: Cue): void
  update(clocks: Clocks): void
  clear(): void
}

export const makeCues = (): Cues => {
  const running: Array<Running> = []
  return {
    play: (cue) => {
      running.push({ cue, age: 0, drawing: 0 })
      cue.draw(0, 0)
      cue.follow?.(0)
    },
    update: (clocks) => {
      for (let index = running.length - 1; index >= 0; index--) {
        const entry = running[index]
        if (entry === undefined) continue
        const dt = clocks[entry.cue.clock]
        if (dt === 0) continue
        entry.age += dt
        if (entry.age >= entry.cue.life) {
          running.splice(index, 1)
          entry.cue.end?.()
          continue
        }
        const drawing = Math.floor(entry.age * entry.cue.fps)
        if (drawing !== entry.drawing) {
          entry.drawing = drawing
          entry.cue.draw(drawing, drawing / entry.cue.fps)
        }
        entry.cue.follow?.(entry.age)
      }
    },
    clear: () => {
      for (const entry of running.splice(0)) entry.cue.end?.()
    }
  }
}
