import { PALETTE, paletteOf, paletteOfKind } from "../art/palette.ts"
import type { EnemyKind, MomentOf } from "../sim/index.ts"
import { ON_TWOS } from "./cues.ts"
import { angleOf, pick, spray, spread } from "./fx.ts"
import type { Fx } from "./fx.ts"
import { flashShape } from "./shards.ts"


/** The kind an actor is, from the view, else the zone's accent picks for it. */
const kindOf = (fx: Fx, id: number): EnemyKind | undefined => fx.context.game.view().enemies.find((enemy) => enemy.id === id)?.kind

/** The accent of an enemy's zone, or of the zone being played for what has no kind (an orb). */
const accentOf = (fx: Fx, kind: EnemyKind | undefined) => kind === undefined ? paletteOf(fx.context.game.view().zone).danger : paletteOfKind(kind).danger

const onSpawned = (fx: Fx, spawned: MomentOf<"enemySpawned">) => {
  const { x, z, duration } = spawned
  const accent = accentOf(fx, spawned.kind)
  fx.layers.flat.spawn({ frames: fx.f.summon, x, y: 0.06, z, size: 3.2, sizeEnd: 0.9, rotation: fx.rng() * 6, spin: 2, life: duration, alpha: 0.2, alphaEnd: 1, fps: 12 })
  fx.layers.glow.spawn({ frames: fx.f.flare, x, y: 1.6, z, size: 4.2, sizeEnd: 2, rotation: Math.PI / 2, color: accent, alpha: 0.7, alphaEnd: 0, life: duration * 0.8, fps: 12 })
  fx.layers.floor.spawn({ frames: pick(fx.rng, fx.f.splats, 0), x, y: 0.024, z, size: 1.2, sizeEnd: 2.2, rotation: fx.rng() * 6, life: 6, hold: 0.7, alpha: 0.7, alphaEnd: 0, fps: 12 })
  fx.cues.play({
    clock: "game",
    life: duration,
    fps: ON_TWOS,
    draw: () => {},
    end: () => {
      fx.layers.flat.spawn({ frames: fx.f.burst, x, y: 0.5, z, size: 1.8, sizeEnd: 2.4, rotation: fx.rng() * 6, life: 3 / ON_TWOS, alphaEnd: 0.4 })
      fx.layers.flatGlow.spawn({ frames: fx.f.shock, x, y: 0.1, z, size: 1, sizeEnd: 3, color: accent, life: 0.2, alpha: 0.8 })
    }
  })
}

const onBlink = (fx: Fx, blink: MomentOf<"blink">) => {
  const { fromX, fromZ, toX, toZ } = blink
  const angle = angleOf(toX - fromX, toZ - fromZ)
  const kind = kindOf(fx, blink.id) ?? "trickster"
  const accent = accentOf(fx, kind)
  flashShape(fx, kind, fromX, fromZ, angle, 1.25, 2 / ON_TWOS)
  const length = Math.hypot(toX - fromX, toZ - fromZ)
  const dots = Math.max(2, Math.floor(length / 0.55))
  for (let index = 1; index < dots; index++) {
    const t = index / dots
    fx.layers.flat.spawn({ frames: fx.f.dotTriangle, x: fromX + (toX - fromX) * t, y: 0.2, z: fromZ + (toZ - fromZ) * t, size: kind === "trickster" ? 0.3 : 0.6, rotation: angle, color: accent, life: blink.duration + 0.15, hold: 0.3 + t * 0.4, alpha: 1, alphaEnd: 0 })
  }
  fx.layers.flat.spawn({ frames: fx.f.lockon, x: toX, y: 0.25, z: toZ, size: 2, sizeEnd: 1, rotation: Math.PI / 4, life: blink.duration, alpha: 0.3, alphaEnd: 1, fps: 12 })
}

const onAttack = (fx: Fx, attack: MomentOf<"enemyAttack">) => {
  if (attack.kind === "shooter") return
  const angle = angleOf(attack.dirX, attack.dirZ)
  for (let index = 0; index < 3; index++) {
    const side = spread(fx.rng, 0.35)
    fx.layers.flat.spawn({
      frames: fx.f.speedline,
      x: attack.x - attack.dirX * (0.8 + index * 0.35) - attack.dirZ * side,
      y: 0.3,
      z: attack.z - attack.dirZ * (0.8 + index * 0.35) + attack.dirX * side,
      vx: attack.dirX * 4,
      vz: attack.dirZ * 4,
      size: 1.4,
      sizeEnd: 0.6,
      rotation: angle,
      color: accentOf(fx, attack.kind),
      life: 0.22,
      alphaEnd: 0
    })
  }
  fx.layers.flat.spawn({ frames: fx.f.chevron, x: attack.x + attack.dirX * 0.9, y: 0.3, z: attack.z + attack.dirZ * 0.9, size: 0.9, rotation: angle, life: 2 / ON_TWOS, alpha: 1, alphaEnd: 0.5 })
}

const onSlam = (fx: Fx, slam: MomentOf<"slam">) => {
  const { x, z, radius } = slam
  const accent = accentOf(fx, kindOf(fx, slam.id))
  fx.layers.flat.spawn({ frames: fx.f.shock, x, y: 0.12, z, size: radius * 1.2, sizeEnd: radius * 2.5, rotation: fx.rng() * 6, life: 4 / ON_TWOS, alpha: 1, alphaEnd: 0.2 })
  fx.layers.flatGlow.spawn({ frames: fx.f.haloRing, x, y: 0.1, z, size: radius * 1.4, sizeEnd: radius * 2.8, color: accent, life: 0.3, alpha: 0.9, fps: 0 })
  fx.layers.floor.spawn({ frames: pick(fx.rng, fx.f.cracks, 0), x, y: 0.022, z, size: radius * 1.9, rotation: fx.rng() * 6, life: 9, hold: 0.85, alpha: 0.9, alphaEnd: 0, fps: 0 })
  fx.layers.flat.spawn({ frames: fx.f.halo, x, y: 0.15, z, size: radius * 1.2, sizeEnd: radius * 2.8, color: PALETTE.concrete300, alpha: 0.55, life: 0.5, alphaEnd: 0 })
  for (let index = 0; index < 12; index++) {
    const direction = (index / 12) * Math.PI * 2 + spread(fx.rng, 0.3)
    const speed = 3 + fx.rng() * 4
    fx.layers.flat.spawn({ frames: fx.f.pebble, x: x + Math.cos(direction) * radius * 0.5, y: 0.2, z: z + Math.sin(direction) * radius * 0.5, vx: Math.cos(direction) * speed, vy: 3 + fx.rng() * 4, vz: Math.sin(direction) * speed, size: 0.18 + fx.rng() * 0.2, spin: spread(fx.rng, 10), gravity: 20, ground: true, life: 1, hold: 0.6, alphaEnd: 0 })
  }
  fx.context.rig.shake(0.45, { x, z, shape: "explosion", duration: 0.45 })
}

const onFired = (fx: Fx, fired: MomentOf<"projectileFired">) => {
  const angle = angleOf(fired.dirX, fired.dirZ)
  fx.layers.flat.spawn({ frames: fx.f.burst, x: fired.x + fired.dirX * 0.3, y: 0.5, z: fired.z + fired.dirZ * 0.3, size: 1.2, sizeEnd: 1.5, rotation: angle, life: 2 / ON_TWOS, alphaEnd: 0.5 })
  fx.layers.glow.spawn({ frames: fx.f.halo, x: fired.x, y: 0.5, z: fired.z, size: 1.6, sizeEnd: 0.4, color: accentOf(fx, undefined), life: 0.12, fps: 0 })
}

const onGone = (fx: Fx, gone: MomentOf<"projectileGone">) => {
  if (gone.reason === "hit") return
  fx.layers.flat.spawn({ frames: fx.f.ringSmall, x: gone.x, y: 0.45, z: gone.z, size: 0.4, sizeEnd: 1.1, color: accentOf(fx, undefined), life: 3 / ON_TWOS, alphaEnd: 0 })
  spray(fx, { count: 4, x: gone.x, y: 0.45, z: gone.z, angle: 0, cone: Math.PI, speed: [3, 5], size: [0.25, 0.35], frame: () => fx.f.sparkRed, life: 0.2 })
  if (gone.reason === "wall") fx.layers.floor.spawn({ frames: fx.f.inkDrop, x: gone.x, y: 0.024, z: gone.z, size: 0.35, rotation: fx.rng() * 6, life: 6, hold: 0.8, alpha: 0.6, alphaEnd: 0, fps: 0 })
}

/** How the enemies arrive, blink, launch, slam and shoot. */
export const installEnemyEffects = (fx: Fx) => {
  const { moments } = fx.context
  const offs = [
    moments.on("enemySpawned", (spawned) => onSpawned(fx, spawned)),
    moments.on("blink", (blink) => onBlink(fx, blink)),
    moments.on("enemyAttack", (attack) => onAttack(fx, attack)),
    moments.on("slam", (slam) => onSlam(fx, slam)),
    moments.on("projectileFired", (fired) => onFired(fx, fired)),
    moments.on("projectileGone", (gone) => onGone(fx, gone))
  ]
  return () => {
    for (const off of offs) off()
  }
}
