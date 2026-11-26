import type { Container3D } from "@pixi/3d"

import { PALETTE, rgbOf } from "../../art/palette.ts"
import type { MomentOf, ZoneId } from "../../sim/index.ts"
import { Arc } from "../arcs.ts"
import { ON_TWOS } from "../cues.ts"
import { pick, spray, spread } from "../fx.ts"
import type { Fx } from "../fx.ts"
import { CLEAVE_SHAPE, paletteNow } from "./kit.ts"
import type { WeaponKit } from "./kit.ts"

/** Per drawing of the cleave: tail, head, erosion, brightness. Two smear drawings sweep it out before it holds and dries. */
const CLEAVE: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0.48, 0, 2.9],
  [0, 0.86, 0, 2.5],
  [0, 1, 0.05, 2.0],
  [0.18, 1, 0.24, 1.65],
  [0.42, 1, 0.5, 1.35],
  [0.66, 1, 0.76, 1.1],
  [0.84, 1, 0.92, 1]
]

/** How the cleave's crescent sits: drawn this much past its reach, banked and flattened like the blade's first cut. */
const CLEAVE_LOOK = { reach: 1.42, height: 0.5, bank: 0.2, flatten: 0.1, turn: 0.1 } as const

/**
 * The breaker on screen. The cleave is a fat crescent in a heavier dry brush, smeared out over two drawings while it
 * follows the hero's lunge, throwing ink speed lines and grit off its head. The slam's mark is a thin white ring with
 * four ticks that tightens on twos while the hero hops (the hop itself is look's); the landing cracks an ink
 * starburst across the floor under a shock ring in the zone's accent with a white core, throws stone chips and dust,
 * shoots speed lines out from the centre and punches the lens.
 */
export const installBreaker = (fx: Fx, kit: WeaponKit, parent: Container3D) => {
  const pools = new Map<ZoneId, Array<Arc>>()
  const made: Array<Arc> = []
  let seeds = 0

  const take = (zone: ZoneId): Arc => {
    const free = pools.get(zone) ?? []
    pools.set(zone, free)
    const fresh = () => {
      const arc = new Arc(kit.cleave[zone], kit.cleaveStrip, (seeds += 1))
      made.push(arc)
      return arc
    }
    const arc = free.pop() ?? fresh()
    parent.addChild(arc.node)
    return arc
  }
  const give = (zone: ZoneId, arc: Arc) => {
    arc.hide()
    pools.get(zone)?.push(arc)
  }

  const cleave = (attack: MomentOf<"attack">) => {
    const shape = attack.shape
    if (shape.kind !== "arc") return
    const zone = fx.context.game.view().zone
    const palette = paletteNow(fx)
    const edge = rgbOf(palette.danger)
    const arc = take(zone)
    const radius = shape.range * CLEAVE_LOOK.reach
    const facing = shape.facing + CLEAVE_LOOK.turn
    const variant = Math.floor(fx.rng() * 3)
    const anchor = { x: shape.x, z: shape.z }
    const follow = () => {
      const player = fx.context.game.view().player
      const placed = player === null ? undefined : fx.context.actor(player.id)?.node.position
      if (placed === undefined) return
      anchor.x = placed.x
      anchor.z = placed.z
    }
    follow()
    arc.place(anchor.x, CLEAVE_LOOK.height, anchor.z, facing, radius, false, CLEAVE_LOOK.bank, CLEAVE_LOOK.flatten)
    const span = CLEAVE_SHAPE.span
    const headAt = (head: number) => {
      const turned = span / 2 - span * head
      const along = Math.cos(turned) * radius * 0.82 * (1 - CLEAVE_LOOK.flatten)
      const across = Math.sin(turned) * radius * 0.82
      return {
        angle: facing + turned,
        x: anchor.x + Math.cos(facing) * along - Math.sin(facing) * across,
        z: anchor.z + Math.sin(facing) * along + Math.cos(facing) * across
      }
    }
    fx.cues.play({
      clock: "game",
      life: CLEAVE.length / ON_TWOS,
      fps: ON_TWOS,
      draw: (drawing) => {
        const pose = CLEAVE[drawing]
        if (pose === undefined) return
        const [tail, head, erode, glow] = pose
        arc.pose(tail, head, erode, glow, variant + drawing, 1, edge)
        if (drawing > 1) return
        const tip = headAt(head)
        const along = tip.angle - Math.PI / 2
        for (let index = 0; index < 5; index++) {
          const back = 0.4 + fx.rng() * 1.2
          fx.layers.flat.spawn({
            frames: fx.f.speedline,
            x: tip.x - Math.cos(along) * back,
            y: CLEAVE_LOOK.height + 0.05,
            z: tip.z - Math.sin(along) * back,
            vx: Math.cos(along) * 11,
            vz: Math.sin(along) * 11,
            rotation: along + spread(fx.rng, 0.14),
            size: 1.8 + fx.rng() * 1.2,
            sizeEnd: 0.8,
            color: index % 2 === 0 ? PALETTE.ink : 0xffffff,
            life: 0.24,
            hold: 0.4
          })
        }
        spray(fx, { count: 5, x: tip.x, y: 0.2, z: tip.z, angle: along, cone: 0.6, speed: [4, 9], size: [0.12, 0.22], frame: () => fx.f.pebble, life: 0.5 })
        fx.layers.glow.spawn({ frames: fx.f.glint, x: tip.x, y: CLEAVE_LOOK.height + 0.1, z: tip.z, size: 2, sizeEnd: 0.4, rotation: fx.rng() * Math.PI, life: 0.16, alpha: 0.95 })
      },
      follow: (age) => {
        if (age > attack.duration) return
        follow()
        arc.node.position.set(anchor.x, CLEAVE_LOOK.height, anchor.z)
      },
      end: () => give(zone, arc)
    })
    fx.layers.floor.spawn({ frames: fx.f.dryRing, x: shape.x, y: 0.05, z: shape.z, size: 2.4, sizeEnd: 4.2, rotation: facing, life: 3 / ON_TWOS, alpha: 0.5, alphaEnd: 0, fps: 0 })
    fx.context.rig.shake(0.08, { x: shape.x, z: shape.z, dirX: Math.cos(shape.facing), dirZ: Math.sin(shape.facing), shape: "recoil", duration: 0.22 })
    fx.context.rig.punch(1.2)
  }

  /** The mark the hop aims at: drawn fresh on twos, tightening onto its radius, until the slam lands or a dash cancels it. */
  const mark = (marked: MomentOf<"marked">) => {
    const diameter = marked.radius * 2
    const player = fx.context.game.view().player
    if (player !== null) {
      fx.layers.flat.spawn({ frames: fx.f.dryRing, x: player.x, y: 0.06, z: player.z, size: 1.2, sizeEnd: 2.6, life: 3 / ON_TWOS, alpha: 0.6, alphaEnd: 0 })
      spray(fx, { count: 5, x: player.x, y: 0.1, z: player.z, angle: 0, cone: Math.PI, speed: [1.5, 3.5], size: [0.1, 0.18], frame: () => fx.f.pebble, life: 0.4 })
    }
    fx.cues.play({
      clock: "game",
      life: marked.delay,
      fps: ON_TWOS,
      draw: (drawing, age) => {
        const waiting = fx.context.game.view().weapon.marks.some((each) => each.id === marked.mark)
        if (!waiting && drawing > 0) return
        const through = Math.min(1, age / Math.max(0.01, marked.delay))
        const late = through > 0.7
        fx.layers.floor.spawn({ frames: fx.f.weapon.slamRing, x: marked.x, y: 0.05, z: marked.z, size: diameter * (1.2 - 0.2 * through), rotation: drawing * 0.09, life: 1 / ON_TWOS + 0.005, fps: 0, alpha: late && drawing % 2 === 0 ? 1 : 0.85, alphaEnd: 0.85 })
        fx.layers.flatGlow.spawn({ frames: fx.f.halo, x: marked.x, y: 0.06, z: marked.z, size: diameter * (0.5 + 0.5 * through), color: 0xffffff, life: 1 / ON_TWOS + 0.005, fps: 0, alpha: 0.12 + 0.18 * through, alphaEnd: 0.12 })
      }
    })
  }

  /**
   * The landing, in held drawings on the game clock (the slam's hit-stop holds the first): a white core and the shock
   * ring in the accent; then the ink starburst and the cracks it leaves; then the debris, the white ring opening and
   * the speed lines.
   */
  const land = (burst: MomentOf<"burst">) => {
    const { x, z, radius } = burst
    const accent = paletteNow(fx).danger
    const struck = burst.hits > 0
    fx.cues.play({
      clock: "game",
      life: 3 / ON_TWOS,
      fps: ON_TWOS,
      draw: (drawing) => {
        if (drawing === 0) {
          fx.layers.flat.spawn({ frames: fx.f.weapon.brushRing, x, y: 0.16, z, size: radius * 1.1, rotation: fx.rng() * 6, life: 1 / ON_TWOS + 0.005, fps: 0, alpha: 1, alphaEnd: 1 })
          fx.layers.flatGlow.spawn({ frames: fx.f.shock, x, y: 0.1, z, size: radius * 1.5, sizeEnd: radius * 3.2, color: accent, life: 0.34, alpha: 1, alphaEnd: 0 })
          fx.layers.glow.spawn({ frames: fx.f.halo, x, y: 0.4, z, size: radius * 1.1, sizeEnd: radius * 0.4, color: 0xffffff, life: 0.1, alpha: 0.65, fps: 0 })
          return
        }
        if (drawing === 1) {
          fx.layers.flat.spawn({ frames: fx.f.burst[0] ?? 0, x, y: 0.12, z, size: radius * 2.6, sizeEnd: radius * 2.9, rotation: fx.rng() * Math.PI * 2, color: PALETTE.ink, life: 2 / ON_TWOS, fps: 0, alpha: 1, alphaEnd: 0.7 })
          fx.layers.floor.spawn({ frames: pick(fx.rng, fx.f.cracks, 0), x, y: 0.024, z, size: radius * 2.7, rotation: fx.rng() * 6, life: 6, hold: 0.7, alpha: 0.95, alphaEnd: 0, fps: 0 })
          fx.layers.floor.spawn({ frames: pick(fx.rng, fx.f.cracks, 0), x, y: 0.025, z, size: radius * 1.7, rotation: fx.rng() * 6, life: 5, hold: 0.6, alpha: 0.85, alphaEnd: 0, fps: 0 })
          return
        }
        fx.layers.flat.spawn({ frames: fx.f.weapon.brushRing, x, y: 0.14, z, size: radius * 1.7, sizeEnd: radius * 2.6, rotation: fx.rng() * 6, life: 4 / ON_TWOS, alpha: 1, alphaEnd: 0 })
        fx.layers.flat.spawn({ frames: fx.f.dryRing, x, y: 0.2, z, size: radius * 2, sizeEnd: radius * 3.6, life: 0.5, alpha: 0.45, alphaEnd: 0 })
        for (let index = 0; index < 12; index++) {
          const direction = (index / 12) * Math.PI * 2 + spread(fx.rng, 0.15)
          const from = radius * (0.45 + fx.rng() * 0.3)
          fx.layers.flat.spawn({
            frames: fx.f.speedline,
            x: x + Math.cos(direction) * from,
            y: 0.25,
            z: z + Math.sin(direction) * from,
            vx: Math.cos(direction) * 15,
            vz: Math.sin(direction) * 15,
            rotation: direction,
            size: 1.8 + fx.rng(),
            sizeEnd: 0.9,
            life: 0.22,
            hold: 0.35
          })
        }
        for (let index = 0; index < 14; index++) {
          const direction = fx.rng() * Math.PI * 2
          const speed = 3 + fx.rng() * 6
          fx.layers.flat.spawn({ frames: fx.f.pebble, x, y: 0.15, z, vx: Math.cos(direction) * speed, vy: 3 + fx.rng() * 4, vz: Math.sin(direction) * speed, size: 0.14 + fx.rng() * 0.16, gravity: 18, ground: true, spin: 8, life: 0.9, hold: 0.6, alphaEnd: 0 })
        }
        for (let index = 0; index < 3; index++) {
          const direction = fx.rng() * Math.PI * 2
          fx.layers.floor.spawn({ frames: pick(fx.rng, fx.f.splats, 0), x: x + Math.cos(direction) * radius * 0.6, y: 0.026, z: z + Math.sin(direction) * radius * 0.6, size: 1.4 + fx.rng(), rotation: direction, life: 6, hold: 0.7, alpha: 0.8, alphaEnd: 0, fps: 0 })
        }
      }
    })
    fx.impacts.pulse("ink", struck ? 0.6 : 0.4)
    fx.context.rig.punch(struck ? 4.5 : 3)
    fx.context.rig.shake(struck ? 0.34 : 0.24, { x, z, shape: "explosion", duration: 0.4 })
  }

  const offs = [
    fx.context.moments.on("attack", (attack) => {
      if (attack.move === "cleave") cleave(attack)
    }),
    fx.context.moments.on("marked", (marked) => {
      if (marked.move === "slam") mark(marked)
    }),
    fx.context.moments.on("burst", (burst) => {
      if (burst.move === "slam") land(burst)
    })
  ]

  return {
    clear: () => {
      for (const arc of made) arc.hide()
    },
    dispose: () => {
      for (const off of offs) off()
      for (const arc of made) arc.destroy()
    }
  }
}
