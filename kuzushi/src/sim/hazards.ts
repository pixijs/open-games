import { Clock } from "@typeonce/ritmo"

import { insideSlab } from "./arena.ts"
import type { ArenaLayout, Point } from "./arena.ts"
import { beamReach, nearestOnBeam, sweepAngle, sweepTime } from "./beam.ts"
import { templateOf } from "./dungeon/templates.ts"
import { dirOf, normalize, within } from "./geometry.ts"
import { groundOf, hazardLive, hazardOf, layoutOf } from "./ground.ts"
import { Body, Boss, CurrentStage, Game, Hazard, HazardHits, Moments, PlayerState, PrevBody, Waves } from "./schema.ts"
import type { HazardValue, WavesValue } from "./schema.ts"
import { fallenSlabs, slabGroupsOf } from "./stages.ts"
import type { BeamHazard, CollapseHazard, StageHazard } from "./stages.ts"
import { PlayTime, secondsOf } from "./time.ts"
import { PLAYER } from "./tuning.ts"

/** The hazard a floor starts with, at `fallen` slab groups gone: a beam rests until its first telegraph. */
export const startingHazard = (hazard: StageHazard, play: Clock.Time<60>, fallen: number): HazardValue => {
  switch (hazard.kind) {
    case "none": return { _tag: "None" }
    case "beam": return { _tag: "BeamRest", until: Clock.deadline(play, hazard.first), angle: hazard.startAngle }
    case "collapse": return { _tag: "FloorSteady", fallen }
  }
}

/** Whether the room's fight has passed the clear of wave `after`: its slabs may crack. Never outside a fight (the sandbox, a cleared room). */
const cleared = (waves: WavesValue, after: number): boolean => {
  switch (waves._tag) {
    case "Intro":
    case "Fighting": return waves.wave > after
    case "Breath": return waves.wave >= after
    case "Idle":
    case "Arming":
    case "Clearing":
    case "Won": return false
  }
}

/** The nearest place on the standing slabs where the player fits, for setting them down when theirs falls. */
const nearestStanding = (layout: ArenaLayout, standing: ReadonlyArray<number>, x: number, z: number): Point => {
  if (layout.floor.kind !== "slabs") return { x, z }
  const margin = PLAYER.radius + 0.15
  const slabs = layout.floor.slabs
  return standing.reduce<Point>((best, index) => {
    const slab = slabs[index]
    if (slab === undefined) return best
    const spot = {
      x: Math.min(slab.x + slab.halfWidth - margin, Math.max(slab.x - slab.halfWidth + margin, x)),
      z: Math.min(slab.z + slab.halfDepth - margin, Math.max(slab.z - slab.halfDepth + margin, z))
    }
    return (spot.x - x) ** 2 + (spot.z - z) ** 2 < (best.x - x) ** 2 + (best.z - z) ** 2 ? spot : best
  }, layout.start)
}

/** Whether (x, z) stands on one of `slabs` of the floor. */
const onSlabs = (layout: ArenaLayout, slabs: ReadonlyArray<number>, x: number, z: number): boolean => {
  if (layout.floor.kind !== "slabs") return false
  const all = layout.floor.slabs
  return slabs.some((index) => {
    const slab = all[index]
    return slab !== undefined && insideSlab(slab, x, z)
  })
}

/** Starts the beam's telegraph now; the debug hooks use it too. */
export const warnBeam = (beam: BeamHazard, play: Clock.Time<60>, angle: number): HazardValue =>
  ({ _tag: "BeamWarn", until: Clock.deadline(play, beam.lead), angle })

/** Cracks the next slab group now; the debug hooks use it too. */
export const crackSlabs = (collapse: CollapseHazard, play: Clock.Time<60>, fallen: number): HazardValue =>
  ({ _tag: "FloorCracking", fallen, until: Clock.deadline(play, collapse.crack) })

/**
 * The floor's hazard on the gameplay clock, in a room only while its doors are sealed. The Spiral's beam rests, warns,
 * then sweeps clockwise from the spire, stopped by pillars, and reaches for the player wherever it lies across them.
 * The Void's slabs crack after the waves they name and fall, setting a player caught on them down on standing floor; in
 * a boss room a group cracks as the boss's shift into the phase after its wave starts, and Sunder landing on a cracking
 * slab brings its group down at once.
 * Combat resolves what reaches the player; ring-outs take enemies left over nothing. A switched-off hazard (or a
 * cleared room's) starts nothing new: a sweep or a crack already running still ends.
 */
export const RunHazards = Game.System("Game/Hazards", {
  resources: {
    play: Game.System.readResource(PlayTime),
    stage: Game.System.readResource(CurrentStage),
    hazard: Game.System.writeResource(Hazard),
    waves: Game.System.readResource(Waves)
  },
  queries: {
    players: Game.Query({ selection: { body: Game.Query.write(Body), prev: Game.Query.write(PrevBody), state: Game.Query.read(PlayerState) } }),
    bosses: Game.Query({ selection: { boss: Game.Query.read(Boss) } })
  },
  events: { heard: Game.System.readEvent(Moments), moments: Game.System.writeEvent(Moments), hits: Game.System.writeEvent(HazardHits) }
}, ({ resources, queries, events }) => {
  const play = resources.play.get()
  const current = resources.stage.get()
  const layout = layoutOf(current)
  const spec = hazardOf(current)
  const live = hazardLive(current)
  const hazard = resources.hazard.get()
  const players = queries.players
  const player = players.each()[0]

  if (spec.kind === "beam") {
    switch (hazard._tag) {
      case "BeamRest": {
        if (!live || !Clock.reached(play, hazard.until)) return
        resources.hazard.set(warnBeam(spec, play, hazard.angle))
        events.moments.emit({ type: "beamWarned", x: spec.x, z: spec.z, angle: hazard.angle, lead: secondsOf(spec.lead) })
        return
      }
      case "BeamWarn": {
        if (!Clock.reached(play, hazard.until)) return
        const duration = sweepTime(spec)
        resources.hazard.set({ _tag: "BeamSweep", until: Clock.deadline(play, duration), from: hazard.angle })
        events.moments.emit({ type: "beamStarted", x: spec.x, z: spec.z, angle: hazard.angle, speed: spec.speed, duration: secondsOf(duration) })
        return
      }
      case "BeamSweep": {
        if (Clock.reached(play, hazard.until)) {
          const angle = hazard.from + spec.sweep
          resources.hazard.set({ _tag: "BeamRest", until: Clock.deadline(play, spec.rest), angle })
          events.moments.emit({ type: "beamEnded", x: spec.x, z: spec.z, angle })
          return
        }
        if (player === undefined || players.data.state.get(player)._tag === "Down") return
        const angle = sweepAngle(spec, hazard.from, play, hazard.until)
        const body = players.data.body.get(player)
        const near = nearestOnBeam(spec, angle, beamReach(spec, layout, angle), body.x, body.z)
        if (!within(near.x, near.z, body.x, body.z, spec.halfWidth + PLAYER.radius)) return
        const out = normalize(body.x - near.x, body.z - near.z, dirOf(angle + Math.PI / 2))
        events.hits.emit({ hazard: "beam", x: near.x, z: near.z, dirX: out.x, dirZ: out.z })
        return
      }
      default:
        return
    }
  }

  if (spec.kind === "collapse") {
    const groups = slabGroupsOf(layout)
    switch (hazard._tag) {
      case "FloorSteady": {
        const next = groups[hazard.fallen]
        const boss = current.room !== null && templateOf(current.room.template).role === "boss"
        const phase = Math.max(0, ...queries.bosses.each().map((entity) => queries.bosses.data.boss.get(entity).phase))
        if (!live || next === undefined || !(boss ? phase > next.after : cleared(resources.waves.get(), next.after))) return
        resources.hazard.set(crackSlabs(spec, play, hazard.fallen))
        events.moments.emit({ type: "slabsCracking", slabs: next.slabs, duration: secondsOf(spec.crack) })
        return
      }
      case "FloorCracking": {
        const cracking = groups[hazard.fallen]?.slabs ?? []
        const crushed = events.heard.all().some((moment) => moment.type === "landed" && moment.kind === "sunder" && onSlabs(layout, cracking, moment.x, moment.z))
        if (!crushed && !Clock.reached(play, hazard.until)) return
        const fallen = hazard.fallen + 1
        resources.hazard.set({ _tag: "FloorSteady", fallen })
        events.moments.emit({ type: "slabsFell", slabs: groups[hazard.fallen]?.slabs ?? [] })
        if (player === undefined) return
        const body = players.data.body.get(player)
        const terrain = groundOf(current, { _tag: "FloorSteady", fallen })
        if (terrain.onFloor(body.x, body.z)) return
        const gone = fallenSlabs(layout, fallen)
        const slabs = layout.floor.kind === "slabs" ? layout.floor.slabs : []
        const standing = slabs.flatMap((_, index) => gone.has(index) ? [] : [index])
        const spot = nearestStanding(layout, standing, body.x, body.z)
        const set = { ...body, x: spot.x, z: spot.z }
        players.data.body.set(player, set)
        players.data.prev.set(player, set)
        events.moments.emit({ type: "playerCaught", fromX: body.x, fromZ: body.z, x: spot.x, z: spot.z })
        const dir = normalize(spot.x - body.x, spot.z - body.z, { x: 0, z: -1 })
        events.hits.emit({ hazard: "fall", x: body.x, z: body.z, dirX: dir.x, dirZ: dir.z })
        return
      }
      default:
        return
    }
  }
})
