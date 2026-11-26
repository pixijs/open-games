import { Clock } from "@typeonce/ritmo"

import type { ArenaLayout } from "./arena.ts"
import { dirOf } from "./geometry.ts"
import type { HazardValue } from "./schema.ts"
import type { BeamHazard } from "./stages.ts"
import { seconds, secondsOf } from "./time.ts"
import type { Deadline, Duration } from "./time.ts"

/** How long one sweep lasts. */
export const sweepTime = (beam: BeamHazard): Duration => seconds(beam.sweep / beam.speed)

/** The beam's angle during a sweep that started at `from` and ends at `until`. */
export const sweepAngle = (beam: BeamHazard, from: number, play: Clock.Time<60>, until: Deadline): number => {
  const total = Clock.steps(sweepTime(beam))
  const elapsed = Math.max(0, total - Clock.remaining(play, until))
  return from + beam.speed * (elapsed / play.hz)
}

/** Where the telegraph runs during a sweep: `lead` ahead of the beam, never past the sweep's end. */
export const leadAngle = (beam: BeamHazard, from: number, angle: number): number =>
  Math.min(from + beam.sweep, angle + beam.speed * secondsOf(beam.lead))

/** How far the beam reaches along `angle`: to the first pillar it meets past the spire, else the wall. */
export const beamReach = (beam: BeamHazard, layout: ArenaLayout, angle: number): number => {
  const dir = dirOf(angle)
  let reach = layout.floor.kind === "round" ? layout.floor.radius : Math.max(layout.halfWidth, layout.halfDepth)
  for (const pillar of layout.pillars) {
    const fx = beam.x - pillar.x
    const fz = beam.z - pillar.z
    const b = fx * dir.x + fz * dir.z
    const disc = b * b - (fx * fx + fz * fz - pillar.radius * pillar.radius)
    if (disc < 0) continue
    const enter = -b - Math.sqrt(disc)
    if (enter > beam.from && enter < reach) reach = enter
  }
  return reach
}

/** The point of the beam nearest (x, z), on its line from the spire's surface to `reach`. */
export const nearestOnBeam = (beam: BeamHazard, angle: number, reach: number, x: number, z: number): { readonly x: number; readonly z: number } => {
  const dir = dirOf(angle)
  const along = Math.min(reach, Math.max(beam.from, (x - beam.x) * dir.x + (z - beam.z) * dir.z))
  return { x: beam.x + dir.x * along, z: beam.z + dir.z * along }
}

/** The beam's angle now, for a hazard in any beam phase; null when there is no beam. */
export const beamAngleOf = (beam: BeamHazard, hazard: HazardValue, play: Clock.Time<60>): number | null => {
  switch (hazard._tag) {
    case "BeamRest":
    case "BeamWarn": return hazard.angle
    case "BeamSweep": return sweepAngle(beam, hazard.from, play, hazard.until)
    default: return null
  }
}
