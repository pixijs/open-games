import { PALETTE } from "../art/palette.ts"
import type { MomentOf, Slab } from "../sim/index.ts"
import { ON_TWOS } from "./cues.ts"
import { angleOf, spread } from "./fx.ts"
import type { Fx } from "./fx.ts"
import { flashShape, shapeCell } from "./shards.ts"

/**
 * The Void's edges and falling floor. A ring-out holds the shape white at the edge for a drawing, then it drops with
 * speed lines streaming up past it and, far below, a red flash where it is lost. A cracking slab trickles grit
 * into the dark and the frame rumbles; a falling one bursts dust and stone from its edges, and its pieces flash
 * red far below. A player caught on one leaves an afterimage dropping where they stood and lands with a ring.
 */

/**
 * How far below the floor the red flash of something lost to the void shows, and how far out past where it fell: far
 * enough that the floor never hides it, since from the play camera a point 7 below shows about 4 nearer the lens.
 */
const DEPTH = 7
const BEYOND = 4.5

const slabsOf = (fx: Fx, indices: ReadonlyArray<number>): ReadonlyArray<Slab> => {
  const floor = fx.context.game.arena.floor
  if (floor.kind !== "slabs") return []
  return indices.map((index) => floor.slabs[index]).filter((slab) => slab !== undefined)
}

/** A point on a slab's edge, `t` of the way round its outline. */
const edgePoint = (slab: Slab, t: number): readonly [number, number, number] => {
  const width = slab.halfWidth * 2
  const depth = slab.halfDepth * 2
  const around = t * (width + depth) * 2
  if (around < width) return [slab.x - slab.halfWidth + around, slab.z - slab.halfDepth, -Math.PI / 2]
  if (around < width + depth) return [slab.x + slab.halfWidth, slab.z - slab.halfDepth + around - width, 0]
  if (around < width * 2 + depth) return [slab.x + slab.halfWidth - (around - width - depth), slab.z + slab.halfDepth, Math.PI / 2]
  return [slab.x - slab.halfWidth, slab.z + slab.halfDepth - (around - width * 2 - depth), Math.PI]
}

/** Below and beyond (x, z) along (dirX, dirZ), in the flat layers, so a floor between it and the lens still hides it. */
const farFlash = (fx: Fx, fromX: number, fromZ: number, dirX: number, dirZ: number, size: number) => {
  const x = fromX + dirX * BEYOND
  const z = fromZ + dirZ * BEYOND
  fx.layers.flatGlow.spawn({ frames: fx.f.halo, x, y: -DEPTH, z, size: size * 2.6, sizeEnd: size * 0.8, color: PALETTE.red, alpha: 1, life: 0.35, fps: 0 })
  fx.layers.flat.spawn({ frames: fx.f.radial, x, y: -DEPTH + 0.1, z, size, sizeEnd: size * 1.4, rotation: fx.rng() * 6, color: PALETTE.red, life: 3 / ON_TWOS, alpha: 1, alphaEnd: 0.3 })
}

const onRingOut = (fx: Fx, out: MomentOf<"ringOut">) => {
  const cell = shapeCell(out.kind)
  const drift = angleOf(out.dirX, out.dirZ)
  flashShape(fx, out.kind, out.x, out.z, drift, 1.3, 2 / ON_TWOS)
  fx.layers.face.spawn({ frames: fx.f.burst, x: out.x, y: 0.5, z: out.z, size: cell * 2.4, sizeEnd: cell * 2.8, rotation: drift, color: PALETTE.ink, life: 1 / ON_TWOS, fps: 0, alpha: 1, alphaEnd: 1 })
  fx.layers.flat.spawn({ frames: fx.f.dryRing, x: out.x, y: 0.1, z: out.z, size: cell, sizeEnd: cell * 3, life: 3 / ON_TWOS, alpha: 0.8, alphaEnd: 0 })
  fx.impacts.pulse("ink", 0.4)
  fx.context.rig.punch(1.5)
  let x = out.x
  let z = out.z
  fx.cues.play({
    clock: "game",
    life: out.duration,
    fps: ON_TWOS,
    draw: (drawing, age) => {
      const at = fx.context.actor(out.id)?.node.position
      x = at?.x ?? x
      z = at?.z ?? z
      if (drawing < 2) return
      const fall = age / out.duration
      const y = -fall * fall * DEPTH
      for (let line = 0; line < 3; line++) {
        fx.layers.flat.spawn({ frames: fx.f.speedline, x: x + spread(fx.rng, 0.6), y: y + 0.4, z: z - 0.6 - fx.rng() * 1.2, vz: -5, size: 1.4 + fx.rng() * 1.4, sizeEnd: 0.6, rotation: -Math.PI / 2, color: line === 0 ? PALETTE.red : 0xffffff, alpha: 0.9, alphaEnd: 0, life: 0.2 })
      }
    },
    end: () => {
      farFlash(fx, x, z, out.dirX, out.dirZ, 3.4)
      fx.impacts.pulse("red", 0.25)
      fx.context.rig.shake(0.08, { x, z, shape: "rumble", duration: 0.25 })
    }
  })
}

const onCracking = (fx: Fx, cracking: MomentOf<"slabsCracking">) => {
  const slabs = slabsOf(fx, cracking.slabs)
  for (const slab of slabs) {
    fx.layers.flatGlow.spawn({ frames: fx.f.haloRing, x: slab.x, y: 0.04, z: slab.z, size: Math.max(slab.halfWidth, slab.halfDepth) * 1.2, sizeEnd: Math.max(slab.halfWidth, slab.halfDepth) * 2.6, color: PALETTE.red, life: 0.4, alpha: 0.7, alphaEnd: 0 })
  }
  fx.context.rig.shake(0.06, { shape: "rumble", duration: cracking.duration })
  fx.cues.play({
    clock: "game",
    life: cracking.duration,
    fps: ON_TWOS,
    draw: (_drawing, age) => {
      const share = age / cracking.duration
      for (const slab of slabs) {
        for (let grit = 0; grit < 1 + Math.floor(share * 3); grit++) {
          const [x, z, out] = edgePoint(slab, fx.rng())
          fx.layers.flat.spawn({ frames: grit % 2 === 0 ? fx.f.pebble : fx.f.inkDrop, x: x + Math.cos(out) * 0.1, y: -0.05, z: z + Math.sin(out) * 0.1, vx: Math.cos(out) * 0.6, vy: -0.5, vz: Math.sin(out) * 0.6, size: 0.08 + fx.rng() * 0.14, spin: spread(fx.rng, 6), gravity: 14, life: 0.9, hold: 0.5, alpha: 0.9, alphaEnd: 0 })
        }
      }
    }
  })
}

const onFell = (fx: Fx, fell: MomentOf<"slabsFell">) => {
  const slabs = slabsOf(fx, fell.slabs)
  for (const slab of slabs) {
    const size = Math.max(slab.halfWidth, slab.halfDepth)
    fx.layers.flat.spawn({ frames: fx.f.shock, x: slab.x, y: 0.1, z: slab.z, size: size * 1.4, sizeEnd: size * 3.2, life: 4 / ON_TWOS, alpha: 1, alphaEnd: 0 })
    for (let chunk = 0; chunk < 10; chunk++) {
      const [x, z, out] = edgePoint(slab, chunk / 10 + fx.rng() * 0.08)
      const speed = 1.5 + fx.rng() * 3
      fx.layers.flat.spawn({ frames: chunk % 3 === 0 ? fx.f.shard : fx.f.pebble, x, y: 0.1, z, vx: Math.cos(out) * speed, vy: 2 + fx.rng() * 3, vz: Math.sin(out) * speed, size: 0.2 + fx.rng() * 0.35, spin: spread(fx.rng, 9), gravity: 18, life: 1.4, hold: 0.6, alpha: 1, alphaEnd: 0 })
    }
    const out = Math.hypot(slab.x, slab.z) || 1
    fx.cues.play({ clock: "game", life: 1.1, fps: ON_TWOS, draw: () => {}, end: () => farFlash(fx, slab.x, slab.z, slab.x / out, slab.z / out, size * 1.4) })
  }
  fx.impacts.pulse("ink", 0.55, 2)
  fx.context.rig.shake(0.3, { shape: "explosion", duration: 0.5 })
}

const onCaught = (fx: Fx, caught: MomentOf<"playerCaught">) => {
  const angle = angleOf(caught.x - caught.fromX, caught.z - caught.fromZ)
  flashShape(fx, "player", caught.fromX, caught.fromZ, angle, 1.2, 2 / ON_TWOS)
  fx.layers.flat.spawn({ frames: fx.f.ghost, x: caught.fromX, y: 0.2, z: caught.fromZ, vy: -6, size: 1.6, rotation: angle, gravity: 10, life: 0.5, alpha: 0.9, alphaEnd: 0 })
  const length = Math.hypot(caught.x - caught.fromX, caught.z - caught.fromZ)
  const dots = Math.max(2, Math.floor(length / 0.45))
  for (let index = 1; index < dots; index++) {
    const t = index / dots
    fx.layers.flat.spawn({ frames: fx.f.dotSquare, x: caught.fromX + (caught.x - caught.fromX) * t, y: 0.2, z: caught.fromZ + (caught.z - caught.fromZ) * t, size: 0.2, rotation: angle, life: 0.5, hold: 0.2 + t * 0.4, alpha: 1, alphaEnd: 0 })
  }
  fx.layers.flat.spawn({ frames: fx.f.dryRing, x: caught.x, y: 0.08, z: caught.z, size: 0.8, sizeEnd: 2.6, life: 4 / ON_TWOS, alpha: 0.9, alphaEnd: 0 })
}

export const installEdges = (fx: Fx) => {
  const { moments } = fx.context
  const offs = [
    moments.on("ringOut", (out) => onRingOut(fx, out)),
    moments.on("slabsCracking", (cracking) => onCracking(fx, cracking)),
    moments.on("slabsFell", (fell) => onFell(fx, fell)),
    moments.on("playerCaught", (caught) => onCaught(fx, caught))
  ]
  return () => {
    for (const off of offs) off()
  }
}
