import { Clock } from "@typeonce/ritmo"

import { angleOf, inArc, nearestOnLine, within } from "../geometry.ts"
import type { ComboStep, HitShape } from "../moments.ts"
import type { BodyValue, PlayerStateValue } from "../schema.ts"
import { MOVE } from "../tuning.ts"
import type { WeaponMove } from "../weapons.ts"

/** Whether a circle of `radius` at (x, z) touches `shape`. */
export const inShape = (shape: HitShape, x: number, z: number, radius: number): boolean => {
  switch (shape.kind) {
    case "arc": return inArc(shape.x, shape.z, shape.facing, shape.range, shape.halfAngle, x, z, radius)
    case "circle": return within(shape.x, shape.z, x, z, shape.radius + radius)
    case "line": {
      const near = nearestOnLine(shape.x, shape.z, { x: shape.dirX, z: shape.dirZ }, shape.length, x, z)
      return within(near.x, near.z, x, z, shape.halfWidth + radius)
    }
  }
}

/** A sweep's shape round the hero at `body` along (dirX, dirZ). */
export const arcShape = (move: WeaponMove, body: BodyValue, dirX: number, dirZ: number): HitShape | null => {
  const spec = MOVE[move]
  return spec.kind !== "arc" ? null : { kind: "arc", x: body.x, z: body.z, facing: angleOf(dirX, dirZ), range: spec.range, halfAngle: spec.halfAngle, sweep: spec.sweep }
}

/** A hit shape the player's own body carries this step: a sweep's arc or the slam's circle, while its active frames last. */
export interface LiveHit {
  readonly move: WeaponMove
  readonly step: ComboStep
  readonly swing: number
  readonly shape: HitShape
  /** The first active step: the moment it lands. */
  readonly first: boolean
}

export const liveHit = (state: PlayerStateValue, body: BodyValue, play: Clock.Time<60>): LiveHit | null => {
  switch (state._tag) {
    case "Attack": {
      if (!Clock.reached(play, state.activeAt) || Clock.reached(play, state.recoverAt)) return null
      const shape = arcShape(state.move, body, state.dirX, state.dirZ)
      return shape === null ? null : { move: state.move, step: state.step, swing: state.swing, shape, first: play.step === state.activeAt }
    }
    case "Slam": {
      if (!Clock.reached(play, state.activeAt) || Clock.reached(play, state.recoverAt)) return null
      return { move: "slam", step: 2, swing: state.swing, shape: { kind: "circle", x: body.x, z: body.z, radius: MOVE.slam.radius }, first: play.step === state.activeAt }
    }
    default: return null
  }
}
