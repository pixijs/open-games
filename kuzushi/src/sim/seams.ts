import { Clock } from "@typeonce/ritmo"

import type { Terrain } from "./arena.ts"
import type { Dir } from "./geometry.ts"
import { clearReach, lineContact } from "./reach.ts"
import { Game, Moments, PlayerState, Body, Seam, Strikes } from "./schema.ts"
import { inSteps, PlayTime, progressTo, secondsOf } from "./time.ts"
import type { Duration } from "./time.ts"

/** A seam to draw: where it starts and runs, how far it may go, how fast and thick, and how long it burns. */
export interface SeamSpec {
  readonly owner: number
  readonly x: number
  readonly z: number
  readonly dir: Dir
  readonly reach: number
  readonly speed: number
  readonly halfWidth: number
  readonly live: Duration
}

/** The seam a spec draws on this floor: it stops at the first wall or edge. */
export const seamDraft = (spec: SeamSpec, terrain: Terrain, play: Clock.Time<60>) => {
  const length = Math.max(0.5, clearReach(terrain, spec.x, spec.z, spec.dir, spec.reach))
  const grow = inSteps((length / spec.speed) * play.hz)
  const growSteps = Clock.steps(grow)
  const liveSteps = Clock.steps(spec.live)
  return {
    seam: {
      owner: spec.owner,
      x: spec.x,
      z: spec.z,
      dirX: spec.dir.x,
      dirZ: spec.dir.z,
      length,
      halfWidth: spec.halfWidth,
      grownAt: Clock.deadline(play, grow),
      growSteps,
      endAt: Clock.deadline(play, inSteps(growSteps + liveSteps)),
      liveSteps
    },
    grow: secondsOf(grow)
  }
}

/** How far a seam has run: its whole length once grown. */
export const seamFront = (seam: { readonly length: number; readonly grownAt: Clock.Deadline<60>; readonly growSteps: number }, play: Clock.Time<60>): number =>
  seam.length * progressTo(play, seam.grownAt, seam.growSteps)

/**
 * Seams burn on the gameplay clock: each touches the player along the length it has run (a strike that can't be
 * parried, only dashed through), then heals and is gone.
 */
export const BurnSeams = Game.System("Game/BurnSeams", {
  resources: { play: Game.System.readResource(PlayTime) },
  queries: {
    seams: Game.Query({ selection: { seam: Game.Query.read(Seam) } }),
    players: Game.Query({ selection: { body: Game.Query.read(Body), state: Game.Query.read(PlayerState) } })
  },
  events: { strikes: Game.System.writeEvent(Strikes), moments: Game.System.writeEvent(Moments) },
  commands: Game.System.commands(Game.System.despawns(Seam))
}, ({ resources, queries, events, commands }) => {
  const play = resources.play.get()
  const players = queries.players
  const player = players.each().map((entity) => ({ body: players.data.body.get(entity), state: players.data.state.get(entity) }))[0]
  for (const entity of queries.seams.each()) {
    const seam = queries.seams.data.seam.get(entity)
    if (Clock.reached(play, seam.endAt)) {
      commands.despawn(entity)
      events.moments.emit({ type: "seamHealed", id: entity.id })
      continue
    }
    if (player === undefined || player.state._tag === "Down") continue
    const dir = { x: seam.dirX, z: seam.dirZ }
    const touch = lineContact(seam.x, seam.z, dir, seamFront(seam, play), seam.halfWidth, player.body)
    if (touch === null) continue
    events.strikes.emit({ id: seam.owner, x: touch.x, z: touch.z, radius: seam.halfWidth, dirX: touch.dir.x, dirZ: touch.dir.z, melee: false })
  }
})
