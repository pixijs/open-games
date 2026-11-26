import { PALETTE, paletteOfKind } from "../art/palette.ts"
import { homeOf, Tuning } from "../sim/index.ts"
import type { EnemyKind } from "../sim/index.ts"
import { ON_TWOS } from "./cues.ts"
import { FRAGMENT_SCALE, fragmentOffset } from "./draw/shapes.ts"
import { angleOf, pick, spray, spread } from "./fx.ts"
import type { Fx } from "./fx.ts"

/** World size of the atlas cell that draws a shape at the size its actor stands. */
const SHAPE_CELL: Readonly<Record<EnemyKind | "player", number>> = {
  chaser: Tuning.ENEMY.chaser.radius * 2.6,
  shooter: Tuning.ENEMY.shooter.radius * 2.9,
  bruiser: Tuning.ENEMY.bruiser.radius * 2.45,
  trickster: Tuning.ENEMY.trickster.radius * 2.4,
  orbiter: Tuning.ENEMY.orbiter.radius * 2.5,
  warden: Tuning.ENEMY.warden.radius * 2.5,
  lancer: Tuning.ENEMY.lancer.radius * 6,
  splitter: Tuning.ENEMY.splitter.radius * 2.6,
  splitling: Tuning.ENEMY.splitling.radius * 2.6,
  sweeper: Tuning.ENEMY.sweeper.radius * 5.6,
  pulsar: Tuning.ENEMY.pulsar.radius * 2.4,
  leaper: Tuning.ENEMY.leaper.radius * 2.7,
  cutter: Tuning.ENEMY.cutter.radius * 4.3,
  gatekeeper: Tuning.ENEMY.gatekeeper.radius * 2.6,
  orrery: Tuning.ENEMY.orrery.radius * 2.45,
  sunder: Tuning.ENEMY.sunder.radius * 2.5,
  player: 1.6
}

export const shapeCell = (kind: EnemyKind | "player"): number => SHAPE_CELL[kind]

/** The struck shape whitened for a held drawing. */
export const flashShape = (fx: Fx, kind: EnemyKind | "player", x: number, z: number, facing: number, scale = 1.15, life = 1 / ON_TWOS) => {
  fx.layers.flat.spawn({ frames: fx.f.shapes[kind].flash, x, y: 0.5, z, size: shapeCell(kind) * scale, rotation: facing, life, alpha: 1, alphaEnd: 1 })
}

/**
 * A kill: the shape flashes white under a cut line (held through the kill's hit-stop), splits along the cut and
 * slides apart, then shatters into its four pieces, which arc out, land and fade. Ink stays on the floor.
 */
export const shatter = (fx: Fx, kind: EnemyKind | "player", x: number, z: number, dirX: number, dirZ: number, options: { readonly big?: boolean } = {}) => {
  const blow = angleOf(dirX, dirZ)
  const cut = blow + Math.PI / 2 + spread(fx.rng, 0.35)
  const cell = shapeCell(kind)
  const shape = fx.f.shapes[kind]
  const big = options.big ?? false

  flashShape(fx, kind, x, z, cut, 1.2, 1.5 / ON_TWOS)
  fx.layers.flat.spawn({ frames: fx.f.cutline, x, y: 0.62, z, size: cell * 2.6, sizeEnd: cell * 3.4, rotation: cut, life: 2 / ON_TWOS, alpha: 1, alphaEnd: 0.6 })
  fx.layers.flat.spawn({ frames: fx.f.burst, x, y: 0.58, z, size: big ? 4.4 : 3.2, sizeEnd: big ? 5.2 : 3.8, rotation: blow, life: 3 / ON_TWOS, alpha: 1, alphaEnd: 0.7 })
  const accent = kind === "player" ? PALETTE.red : paletteOfKind(kind).danger
  const courtyard = kind === "player" || homeOf(kind) === "courtyard"
  fx.layers.flatGlow.spawn({ frames: fx.f.flare, x, y: 0.5, z, size: cell * 4, sizeEnd: cell * 6, rotation: cut, color: accent, life: 2 / ON_TWOS, alpha: 0.9 })
  fx.layers.glow.spawn({ frames: fx.f.halo, x, y: 0.5, z, size: big ? 5 : 3.4, sizeEnd: 1, color: accent, life: 0.2, alpha: 0.85, fps: 0 })

  fx.cues.play({
    clock: "game",
    life: 3 / ON_TWOS,
    fps: ON_TWOS,
    draw: (drawing) => {
      if (drawing !== 1) return
      const nx = Math.sin(cut)
      const nz = -Math.cos(cut)
      for (const [index, sign] of [[0, 1], [1, -1]] as const) {
        const frame = shape.halves[index]
        if (frame === undefined) continue
        fx.layers.flat.spawn({
          frames: frame,
          x: x + nx * sign * 0.06,
          y: 0.45,
          z: z + nz * sign * 0.06,
          vx: nx * sign * 2.4 + dirX * 1.5,
          vz: nz * sign * 2.4 + dirZ * 1.5,
          size: cell,
          rotation: cut,
          spin: sign * 1.5,
          life: 2 / ON_TWOS,
          alpha: 1,
          alphaEnd: 1
        })
      }
    },
    end: () => {
      const cos = Math.cos(cut)
      const sin = Math.sin(cut)
      const half = (cell / 2) * 0.96
      shape.fragments.forEach((frame, index) => {
        const [ox, oy] = fragmentOffset(index)
        const offX = (ox * cos + oy * sin) * half
        const offZ = (ox * sin - oy * cos) * half
        const outward = Math.hypot(offX, offZ) || 1
        const speed = 3 + fx.rng() * 3
        fx.layers.flat.spawn({
          frames: frame,
          x: x + offX,
          y: 0.5,
          z: z + offZ,
          vx: (offX / outward) * speed + dirX * 3.5,
          vy: 3 + fx.rng() * 2.5,
          vz: (offZ / outward) * speed + dirZ * 3.5,
          size: cell / FRAGMENT_SCALE,
          sizeEnd: (cell / FRAGMENT_SCALE) * 0.8,
          rotation: cut,
          spin: spread(fx.rng, 9),
          gravity: 16,
          ground: true,
          drag: 1.5,
          life: 1.1,
          hold: 0.65,
          alpha: 1,
          alphaEnd: 0
        })
      })
      spray(fx, { count: 7, x, y: 0.5, z, angle: blow, cone: 1.1, speed: [8, 17], size: [0.5, 1], frame: () => (courtyard && kind !== "player" ? fx.f.sparkRed : fx.f.shard), life: 0.35 })
    }
  })

  const splats = kind === "player" || !courtyard ? fx.f.splats : fx.f.redSplats
  fx.layers.floor.spawn({
    frames: pick(fx.rng, splats, fx.f.splats[0] ?? 0),
    x: x + dirX * 0.5,
    y: 0.025,
    z: z + dirZ * 0.5,
    size: (big ? 3.6 : 2.6) + fx.rng() * 0.8,
    rotation: blow + spread(fx.rng, 0.3),
    life: 10,
    hold: 0.8,
    alpha: 0.88,
    alphaEnd: 0,
    fps: 0
  })
  for (let index = 0; index < 5; index++) {
    const direction = blow + spread(fx.rng, 0.9)
    const distance = 0.6 + fx.rng() * 1.8
    fx.layers.floor.spawn({ frames: fx.f.inkDrop, x: x + Math.cos(direction) * distance, y: 0.026, z: z + Math.sin(direction) * distance, size: 0.12 + fx.rng() * 0.22, rotation: fx.rng() * 6, life: 9, hold: 0.8, alpha: 0.9, alphaEnd: 0, fps: 0 })
  }
}
