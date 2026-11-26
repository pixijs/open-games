import { PALETTE } from "../art/palette.ts"
import type { MomentOf } from "../sim/index.ts"
import { ARC_SHAPES } from "./arcs.ts"
import type { ArcShapeName } from "./arcs.ts"
import { ON_TWOS } from "./cues.ts"
import { drawnAt, spread } from "./fx.ts"
import type { Fx } from "./fx.ts"

/**
 * The slash combo as drawn crescents: a smear drawing that is mostly overexposed light, the full crescent,
 * then three drawings that erode from the tail into dry-brush streaks. The third step is a full spin.
 */

/** Per drawing: tail, head, erosion, brightness. */
type Pose = readonly [number, number, number, number]

const CRESCENT: ReadonlyArray<Pose> = [
  [0, 0.74, 0, 2.6],
  [0, 1, 0, 1.9],
  [0.22, 1, 0.24, 1.5],
  [0.5, 1, 0.52, 1.25],
  [0.74, 1, 0.8, 1.05]
]

const SPIN: ReadonlyArray<Pose> = [
  [0, 0.42, 0, 2.6],
  [0, 0.8, 0, 2.1],
  [0.04, 1, 0.08, 1.8],
  [0.26, 1, 0.34, 1.5],
  [0.5, 1, 0.6, 1.25],
  [0.74, 1, 0.84, 1.05]
]

const ARC_HEIGHT = 0.55

/**
 * How the two cuts of the combo differ so they read as crossing swipes, not one stroke twice: the same crescent
 * mirrored across the aim line, each turned this far (radians) toward the side it starts from, flattened along the
 * facing and banked toward that side.
 */
const CROSS = { turn: 0.08, flatten: 0.2, bank: 0.22 } as const

const shapeFor = (step: 1 | 2 | 3): ArcShapeName => (step === 3 ? "spin" : "wide")

const playSlash = (fx: Fx, slash: MomentOf<"slash">, playerId: number | null) => {
  const shape = shapeFor(slash.step)
  const arc = fx.arcs.take(shape)
  const poses = slash.step === 3 ? SPIN : CRESCENT
  const mirror = slash.sweep === -1
  const bank = slash.step === 3 ? 0.1 : slash.sweep * CROSS.bank
  const radius = slash.range * (slash.step === 3 ? 1.4 : 1.65)
  const span = ARC_SHAPES[shape].span
  const facing = slash.facing + slash.sweep * CROSS.turn
  const flatten = slash.step === 3 ? 0 : CROSS.flatten
  const variant = Math.floor(fx.rng() * 3)
  const anchor = { x: slash.x, z: slash.z }
  const follow = () => {
    const placed = playerId === null ? undefined : fx.context.actor(playerId)?.node.position
    if (placed !== undefined) {
      anchor.x = placed.x
      anchor.z = placed.z
    }
  }
  follow()
  arc.place(anchor.x, ARC_HEIGHT, anchor.z, facing, radius, mirror, bank, flatten)
  const headAt = (head: number) => {
    const local = span / 2 - span * head
    const turned = mirror ? -local : local
    const along = Math.cos(turned) * radius * 0.86 * (1 - flatten)
    const across = Math.sin(turned) * radius * 0.86 * (1 + flatten * 0.5)
    const x = anchor.x + Math.cos(facing) * along - Math.sin(facing) * across
    const z = anchor.z + Math.sin(facing) * along + Math.cos(facing) * across
    return { angle: facing + turned, x, z }
  }
  const turn = mirror ? 1 : -1
  fx.cues.play({
    clock: "game",
    life: poses.length / ON_TWOS,
    fps: ON_TWOS,
    draw: (drawing) => {
      const pose = poses[drawing]
      if (pose === undefined) return
      const [tail, head, erode, glow] = pose
      arc.pose(tail, head, erode, glow, variant + drawing)
      if (drawing > 1) return
      const tip = headAt(head)
      const along = tip.angle + (slash.step === 3 ? -Math.PI / 2 : (turn * Math.PI) / 2)
      for (let index = 0; index < (drawing === 0 ? 4 : 2); index++) {
        const back = 0.4 + fx.rng() * 0.9
        fx.layers.flat.spawn({
          frames: fx.f.speedline,
          x: tip.x - Math.cos(along) * back,
          y: ARC_HEIGHT + 0.05,
          z: tip.z - Math.sin(along) * back,
          vx: Math.cos(along) * 9,
          vz: Math.sin(along) * 9,
          rotation: along + spread(fx.rng, 0.12),
          size: 1.3 + fx.rng() * 0.9,
          sizeEnd: 0.6,
          life: 0.2,
          alpha: 1,
          alphaEnd: 0,
          hold: 0.4
        })
      }
      fx.layers.glow.spawn({ frames: fx.f.glint, x: tip.x, y: ARC_HEIGHT + 0.1, z: tip.z, size: drawing === 0 ? 1.6 : 1.1, sizeEnd: 0.3, rotation: fx.rng() * Math.PI, color: 0xffffff, life: 0.14, alpha: 0.9 })
    },
    follow: (age) => {
      if (age > slash.duration) return
      follow()
      arc.node.position.set(anchor.x, ARC_HEIGHT, anchor.z)
    },
    end: () => fx.arcs.give(shape, arc)
  })
  if (slash.step === 3) {
    fx.layers.flatGlow.spawn({ frames: fx.f.shock, x: slash.x, y: 0.08, z: slash.z, size: radius * 1.6, sizeEnd: radius * 2.4, color: PALETTE.red, alpha: 0.9, life: 0.27, rotation: fx.rng() * 6 })
    fx.layers.flat.spawn({ frames: fx.f.dryRing, x: slash.x, y: 0.06, z: slash.z, size: radius * 1.5, sizeEnd: radius * 2.6, alpha: 0.7, life: 0.27, rotation: fx.rng() * 6 })
    fx.context.rig.shake(0.08, { x: slash.x, z: slash.z, shape: "recoil", duration: 0.2 })
  } else {
    fx.context.rig.shake(0.035, { x: slash.x, z: slash.z, dirX: Math.cos(slash.facing), dirZ: Math.sin(slash.facing), shape: "recoil", duration: 0.16 })
  }
}

/** Plays every slash, and a glint on the blade in each windup. */
export const installSlashes = (fx: Fx) => {
  let windingUp = false
  const off = fx.context.moments.on("slash", (slash) => playSlash(fx, slash, fx.context.game.view().player?.id ?? null))
  return {
    update: () => {
      const player = fx.context.game.view().player
      const winding = player?.attackPhase === "windup" && (player.move === "cut" || player.move === "crosscut" || player.move === "spin")
      if (player !== null && winding && !windingUp) {
        const at = drawnAt(fx, player.id, player)
        const x = at.x + Math.cos(player.facing) * 0.5
        const z = at.z + Math.sin(player.facing) * 0.5
        fx.layers.glow.spawn({ frames: fx.f.glint, x, y: 0.6, z, size: player.move === "spin" ? 1.7 : 1.1, sizeEnd: 0.2, rotation: 0.3, life: 0.1, alpha: 1 })
      }
      windingUp = winding
    },
    dispose: off
  }
}
