import { PALETTE } from "../art/palette.ts"
import { ON_TWOS } from "./cues.ts"
import type { Clocks } from "./cues.ts"
import { angleOf, drawnAt, spread } from "./fx.ts"
import type { Fx } from "./fx.ts"

const AFTERIMAGE_GAP = 1.15
const DOT_GAP = 0.36

interface Dash {
  lastX: number
  lastZ: number
  /** Distance walked since the last afterimage and the last dot. */
  ghostCarry: number
  dotCarry: number
  dots: number
  readonly angle: number
}

/** Calls `place` every `gap` along a walk of `step`, given `carry` already walked since the last one. Returns the new carry. */
const everyAlong = (carry: number, gap: number, step: number, place: (along: number) => void): number => {
  let along = gap - carry
  for (; along <= step; along += gap) place(along)
  return step - (along - gap)
}

interface OrbTrail {
  lastX: number
  lastZ: number
  travelled: number
  drawingAge: number
}

/**
 * What moving things leave behind: the dash's afterimages and dotted trail (from the player's drawn position each
 * frame of the dash), and each orb's glow and dotted comet tail.
 */
export const installTrails = (fx: Fx) => {
  let dash: Dash | null = null
  const orbs = new Map<number, OrbTrail>()
  const seen = new Set<number>()

  const offStart = fx.context.moments.on("dashStarted", (started) => {
    const angle = angleOf(started.dirX, started.dirZ)
    dash = { lastX: started.x, lastZ: started.z, ghostCarry: AFTERIMAGE_GAP * 0.5, dotCarry: DOT_GAP, dots: 0, angle }
    fx.layers.flat.spawn({ frames: fx.f.dryRing, x: started.x, y: 0.06, z: started.z, size: 0.9, sizeEnd: 2.2, alpha: 0.6, life: 3 / ON_TWOS, alphaEnd: 0 })
    for (let index = 0; index < 4; index++) {
      const side = spread(fx.rng, 0.5)
      fx.layers.flat.spawn({
        frames: fx.f.speedline,
        x: started.x - started.dirX * (0.4 + fx.rng()) - started.dirZ * side,
        y: 0.35,
        z: started.z - started.dirZ * (0.4 + fx.rng()) + started.dirX * side,
        vx: -started.dirX * 3,
        vz: -started.dirZ * 3,
        rotation: angle,
        size: 1.6 + fx.rng() * 1.2,
        sizeEnd: 0.8,
        life: 0.25,
        hold: 0.3,
        alphaEnd: 0
      })
    }
    fx.context.rig.shake(0.04, { dirX: -started.dirX, dirZ: -started.dirZ, shape: "recoil", duration: 0.15 })
  })

  const offEnd = fx.context.moments.on("dashEnded", (ended) => {
    for (let index = 0; index < 4; index++) {
      const direction = (dash?.angle ?? 0) + Math.PI + spread(fx.rng, 1.2)
      fx.layers.flat.spawn({ frames: fx.f.pebble, x: ended.x, y: 0.1, z: ended.z, vx: Math.cos(direction) * 2.5, vy: 2, vz: Math.sin(direction) * 2.5, size: 0.14, gravity: 16, ground: true, spin: 6, life: 0.5, hold: 0.5, alphaEnd: 0 })
    }
    dash = null
  })

  const trailDash = () => {
    const player = fx.context.game.view().player
    const current = dash
    if (current === null || player === null || player.state !== "Dash") return
    const { x, z } = drawnAt(fx, player.id, player)
    const { lastX: fromX, lastZ: fromZ, angle } = current
    const step = Math.hypot(x - fromX, z - fromZ)
    if (step < 0.0001) return
    const dirX = (x - fromX) / step
    const dirZ = (z - fromZ) / step
    current.dotCarry = everyAlong(current.dotCarry, DOT_GAP, step, (along) => {
      const triangle = current.dots % 3 === 2
      fx.layers.floor.spawn({ frames: triangle ? fx.f.dotTriangle : fx.f.dotSquare, x: fromX + dirX * along, y: 0.05, z: fromZ + dirZ * along, size: triangle ? 0.34 : 0.2, rotation: angle, life: 1.1, hold: 0.6, alpha: 1, alphaEnd: 0 })
      current.dots += 1
    })
    current.ghostCarry = everyAlong(current.ghostCarry, AFTERIMAGE_GAP, step, (along) => {
      const x = fromX + dirX * along
      const z = fromZ + dirZ * along
      fx.layers.flat.spawn({ frames: fx.f.ghost, x, y: 0.32, z, size: 1.55, rotation: angle, life: 0.28, alpha: 0.9, alphaEnd: 0 })
      const side = spread(fx.rng, 0.45)
      fx.layers.flat.spawn({ frames: fx.f.speedline, x: x - dirX * 1.2 - dirZ * side, y: 0.36, z: z - dirZ * 1.2 + dirX * side, vx: dirX * 2, vz: dirZ * 2, rotation: angle, size: 3.2 + fx.rng() * 1.6, sizeEnd: 2, life: 0.26, hold: 0.3, alphaEnd: 0 })
    })
    current.lastX = x
    current.lastZ = z
  }

  const trailOrbs = (clocks: Clocks) => {
    seen.clear()
    for (const orb of fx.context.game.view().projectiles) {
      seen.add(orb.id)
      const { x, z } = drawnAt(fx, orb.id, orb)
      const trail = orbs.get(orb.id) ?? { lastX: x, lastZ: z, travelled: 0, drawingAge: 1 }
      orbs.set(orb.id, trail)
      if (clocks.game === 0) continue
      const enemy = orb.owner === "enemy"
      trail.travelled += Math.hypot(x - trail.lastX, z - trail.lastZ)
      trail.lastX = x
      trail.lastZ = z
      if (trail.travelled > 0.3) {
        trail.travelled = 0
        fx.layers.flat.spawn({ frames: enemy ? fx.f.droplet : fx.f.dotSquare, x, y: 0.42, z, size: 0.32, sizeEnd: 0.06, rotation: angleOf(orb.dirX, orb.dirZ), life: 0.3, alpha: 0.9, alphaEnd: 0.2 })
      }
      trail.drawingAge += clocks.game
      if (trail.drawingAge >= 1 / ON_TWOS) {
        trail.drawingAge = 0
        fx.layers.glow.spawn({ frames: fx.f.halo, x, y: 0.45, z, size: 1.2 + fx.rng() * 0.3, color: enemy ? PALETTE.red : PALETTE.paper, alpha: enemy ? 0.32 : 0.55, alphaEnd: 0.1, life: 2 / ON_TWOS })
      }
    }
    for (const id of orbs.keys()) if (!seen.has(id)) orbs.delete(id)
  }

  return {
    update: (clocks: Clocks) => {
      trailDash()
      trailOrbs(clocks)
    },
    clear: () => {
      dash = null
      orbs.clear()
    },
    dispose: () => {
      offStart()
      offEnd()
    }
  }
}
