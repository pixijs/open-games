import { PALETTE } from "../art/palette.ts"
import { Tuning } from "../sim/index.ts"
import type { HitSource, MomentOf } from "../sim/index.ts"
import { ON_TWOS } from "./cues.ts"
import { angleOf, drawnAt, pick, spray, spread } from "./fx.ts"
import type { Fx } from "./fx.ts"
import { flashShape, shatter } from "./shards.ts"

/** How big each blow's starburst draws, and how hard it shakes the camera. */
const BLOWS: Readonly<Record<HitSource, readonly [number, number]>> = {
  slash: [3.4, 0.07],
  spin: [4, 0.12],
  cleave: [4.2, 0.12],
  slam: [4.6, 0.16],
  dart: [2.2, 0.04],
  pierce: [3.4, 0.09],
  sigil: [3.2, 0.07],
  seal: [3.8, 0.11],
  reflect: [3, 0.07],
  special: [3.4, 0.07],
  ringOut: [3.4, 0.07]
}

const hitSize = (hit: MomentOf<"hit">): number => BLOWS[hit.source][0]

const onHit = (fx: Fx, hit: MomentOf<"hit">) => {
  if (hit.source === "special" || hit.killed) return
  const { x, z } = drawnAt(fx, hit.id, hit)
  const blow = angleOf(hit.dirX, hit.dirZ)
  const enemy = fx.context.game.view().enemies.find((each) => each.id === hit.id)
  flashShape(fx, hit.kind, x, z, enemy?.facing ?? blow, 1)
  const beyond = Tuning.ENEMY[hit.kind].radius * 0.5
  fx.layers.flat.spawn({ frames: fx.f.burst, x: x + hit.dirX * beyond, y: 0.62, z: z + hit.dirZ * beyond, size: hitSize(hit), sizeEnd: hitSize(hit) * 1.2, rotation: blow + spread(fx.rng, 0.2), life: 3 / ON_TWOS, alpha: 1, alphaEnd: 0.6 })
  fx.layers.glow.spawn({ frames: fx.f.halo, x, y: 0.55, z, size: 2.4, sizeEnd: 0.6, color: PALETTE.red, alpha: 0.8, life: 0.16, fps: 0 })
  spray(fx, { count: 7, x, y: 0.55, z, angle: blow, cone: 0.75, speed: [6, 14], size: [0.45, 0.9], frame: (index) => (index < 5 ? fx.f.sparkRed : fx.f.spark), life: 0.28 })
  for (let index = 0; index < 3; index++) {
    const distance = 0.5 + fx.rng() * 1.4
    const direction = blow + spread(fx.rng, 0.6)
    fx.layers.floor.spawn({ frames: fx.f.inkDrop, x: x + Math.cos(direction) * distance, y: 0.026, z: z + Math.sin(direction) * distance, size: 0.1 + fx.rng() * 0.18, rotation: fx.rng() * 6, life: 7, hold: 0.8, alpha: 0.85, alphaEnd: 0, fps: 0 })
  }
  const strength = BLOWS[hit.source][1]
  fx.context.rig.shake(strength, { x, z, dirX: hit.dirX, dirZ: hit.dirZ, duration: 0.2 })
}

/** How far past the enemy, along the blow, the ordinary kill's ink starburst sits, so it opens away from the player. */
const KILL_BURST_PUSH = 1.1

/**
 * A kill. Only the last of a wave cuts the whole frame to impact frames; any other draws its impact locally, an ink
 * starburst behind the white one for a drawing, and closes an ink vignette round the frame. A ring-out falls instead
 * of shattering (./edges.ts) and a splitter splits (./foes.ts), each with no starburst over it.
 */
const onKill = (fx: Fx, kill: MomentOf<"enemyKilled">, split: boolean) => {
  const fell = kill.source === "ringOut"
  if (!fell && !split) shatter(fx, kill.kind, kill.x, kill.z, kill.dirX, kill.dirZ, { big: kill.lastOfWave })
  if (kill.source === "special" || (fell && !kill.lastOfWave)) return
  fx.context.rig.shake(kill.lastOfWave ? 0.3 : 0.16, { x: kill.x, z: kill.z, dirX: kill.dirX, dirZ: kill.dirZ, duration: 0.3 })
  fx.context.rig.punch(kill.lastOfWave ? 5 : 1.6)
  if (split && !kill.lastOfWave) return
  if (!kill.lastOfWave) {
    const x = kill.x + kill.dirX * KILL_BURST_PUSH
    const z = kill.z + kill.dirZ * KILL_BURST_PUSH
    fx.layers.face.spawn({ frames: fx.f.burst, x, y: 0.6, z, size: 4, sizeEnd: 4.6, rotation: fx.rng() * Math.PI * 2, color: PALETTE.ink, life: 1 / ON_TWOS, fps: 0, alpha: 1, alphaEnd: 1 })
    fx.impacts.pulse("ink", 0.42)
    return
  }
  fx.impacts.frame(["ink", "ink", "red"])
  const focusAt = { x: kill.x, z: kill.z }
  fx.cues.play({
    clock: "real",
    life: 0.7,
    fps: 12,
    draw: (drawing) => {
      const screen = fx.context.view.worldToScreen({ x: focusAt.x, y: 0.4, z: focusAt.z })
      if (screen === null) return
      fx.screen.setFocus(drawing, screen.x, screen.y, "paper", drawing < 2 ? 0.9 : 0.55, 1, fx.rng)
    },
    end: () => fx.screen.hideFocus()
  })
  fx.layers.flatGlow.spawn({ frames: fx.f.shock, x: kill.x, y: 0.1, z: kill.z, size: 2, sizeEnd: 16, color: PALETTE.red, life: 0.6, alpha: 0.9, clock: "real" })
  fx.layers.flat.spawn({ frames: fx.f.dryRing, x: kill.x, y: 0.08, z: kill.z, size: 2, sizeEnd: 13, life: 0.5, alpha: 0.6, clock: "real" })
}

const onParry = (fx: Fx, parry: MomentOf<"parry">) => {
  const x = parry.x + parry.dirX * 0.65
  const z = parry.z + parry.dirZ * 0.65
  fx.layers.face.spawn({ frames: fx.f.xflash, x, y: 0.75, z, size: 4.2, sizeEnd: 5, rotation: spread(fx.rng, 0.3), life: 3 / ON_TWOS, alpha: 1, alphaEnd: 0.5 })
  fx.layers.glow.spawn({ frames: fx.f.halo, x, y: 0.7, z, size: 3.2, sizeEnd: 1, color: PALETTE.red, alpha: 0.7, life: 0.2, fps: 0 })
  fx.layers.flat.spawn({ frames: fx.f.shock, x, y: 0.2, z, size: 1.2, sizeEnd: 4, life: 3 / ON_TWOS, alpha: 1, alphaEnd: 0.3 })
  spray(fx, { count: 10, x, y: 0.6, z, angle: 0, cone: Math.PI, speed: [9, 15], size: [0.6, 1], frame: () => fx.f.shard, life: 0.3 })
  fx.impacts.frame(["stark"])
  fx.context.rig.punch(3)
  fx.context.rig.shake(0.12, { x, z, dirX: -parry.dirX, dirZ: -parry.dirZ, shape: "recoil", duration: 0.22 })
}

const onParryStarted = (fx: Fx, parry: MomentOf<"parryStarted">) => {
  const x = parry.x + Math.cos(parry.facing) * 0.55
  const z = parry.z + Math.sin(parry.facing) * 0.55
  fx.layers.flat.spawn({ frames: fx.f.dryRing, x: parry.x, y: 0.1, z: parry.z, size: 1.4, sizeEnd: 2.2, life: 2 / ON_TWOS, alpha: 0.55, alphaEnd: 0.2 })
  fx.layers.glow.spawn({ frames: fx.f.glint, x, y: 0.65, z, size: 1.3, sizeEnd: 0.4, rotation: 0.78, life: 0.12, alpha: 1 })
}

const onReflect = (fx: Fx, reflect: MomentOf<"reflect">) => {
  fx.layers.face.spawn({ frames: fx.f.burst, x: reflect.x, y: 0.5, z: reflect.z, size: 1.6, sizeEnd: 2, rotation: spread(fx.rng, 3), life: 3 / ON_TWOS, alphaEnd: 0.5 })
  fx.layers.glow.spawn({ frames: fx.f.haloRing, x: reflect.x, y: 0.5, z: reflect.z, size: 0.6, sizeEnd: 2.4, life: 0.2, alpha: 1, fps: 0 })
}

/** The beam burns: embers rise, sparks fly back along it and a scorch stays where the player stood. */
const burn = (fx: Fx, hurt: MomentOf<"playerHurt">) => {
  for (let index = 0; index < 6; index++) {
    fx.layers.glow.spawn({ frames: fx.f.ember, x: hurt.x + spread(fx.rng, 0.5), y: 0.3, z: hurt.z + spread(fx.rng, 0.5), vy: 2 + fx.rng() * 2, size: 0.22, sizeEnd: 0.05, color: PALETTE.red, life: 0.7, alphaEnd: 0 })
  }
  fx.layers.floor.spawn({ frames: fx.f.cracks[0] ?? fx.f.inkDrop, x: hurt.x, y: 0.023, z: hurt.z, size: 1.6, rotation: fx.rng() * 6, life: 6, hold: 0.7, alpha: 0.7, alphaEnd: 0, fps: 0 })
  fx.layers.glow.spawn({ frames: fx.f.halo, x: hurt.x, y: 0.5, z: hurt.z, size: 3, sizeEnd: 1, color: PALETTE.red, alpha: 1, life: 0.25, fps: 0 })
}

const onHurt = (fx: Fx, hurt: MomentOf<"playerHurt">) => {
  if (hurt.cause === "beam") burn(fx, hurt)
  const blow = angleOf(hurt.dirX, hurt.dirZ)
  flashShape(fx, "player", hurt.x, hurt.z, blow + Math.PI, 1.2, 2 / ON_TWOS)
  fx.layers.flat.spawn({ frames: fx.f.burst, x: hurt.x, y: 0.62, z: hurt.z, size: 3, sizeEnd: 3.6, rotation: blow, life: 3 / ON_TWOS, alphaEnd: 0.6 })
  spray(fx, { count: 9, x: hurt.x, y: 0.55, z: hurt.z, angle: blow, cone: 1, speed: [7, 14], size: [0.5, 1], frame: (index) => (index % 3 === 0 ? fx.f.shard : fx.f.sparkRed), life: 0.32 })
  fx.layers.floor.spawn({ frames: pick(fx.rng, fx.f.redSplats, 0), x: hurt.x + hurt.dirX * 0.4, y: 0.025, z: hurt.z + hurt.dirZ * 0.4, size: 2.2, rotation: blow, life: 8, hold: 0.8, alpha: 0.85, alphaEnd: 0, fps: 0 })
  fx.impacts.pulse("red", 0.7, 2)
  fx.context.rig.shake(0.35, { x: hurt.x, z: hurt.z, dirX: hurt.dirX, dirZ: hurt.dirZ, duration: 0.35 })
  fx.context.rig.punch(2)
}

const onDown = (fx: Fx, down: MomentOf<"playerDown">) => {
  shatter(fx, "player", down.x, down.z, 0, -1, { big: true })
  fx.impacts.frame(["ink", "red", "ink"], { fps: 18 })
  fx.context.rig.shake(0.4, { x: down.x, z: down.z, shape: "explosion", duration: 0.5 })
}

const onNearMiss = (fx: Fx, miss: MomentOf<"nearMiss">) => {
  fx.layers.glow.spawn({ frames: fx.f.glint, x: miss.x, y: 0.8, z: miss.z, size: 2, sizeEnd: 0.4, rotation: 0.4, life: 0.2, alpha: 1 })
  fx.layers.flat.spawn({ frames: fx.f.ringSmall, x: miss.x, y: 0.3, z: miss.z, size: 0.8, sizeEnd: 2.6, life: 3 / ON_TWOS, alpha: 0.9, alphaEnd: 0 })
  fx.context.rig.punch(1)
}

const onFocusFull = (fx: Fx) => {
  const player = fx.context.game.view().player
  if (player === null) return
  const { x, z } = drawnAt(fx, player.id, player)
  fx.layers.flatGlow.spawn({ frames: fx.f.haloRing, x, y: 0.15, z, size: 1, sizeEnd: 6, life: 0.4, alpha: 1, clock: "real" })
  for (let index = 0; index < 8; index++) {
    const direction = (index / 8) * Math.PI * 2
    fx.layers.glow.spawn({ frames: index % 2 === 0 ? fx.f.glint : fx.f.ember, x: x + Math.cos(direction) * 0.7, y: 0.3, z: z + Math.sin(direction) * 0.7, vx: Math.cos(direction) * 1.5, vy: 2.5 + fx.rng() * 1.5, vz: Math.sin(direction) * 1.5, size: 0.5, sizeEnd: 0.1, color: index % 2 === 0 ? 0xffffff : PALETTE.red, life: 0.6, alphaEnd: 0, clock: "real" })
  }
}

/** A clear's drop picked up: a paper starburst where it stood, a ring, and glints thrown up into the air. */
const onDropTaken = (fx: Fx, taken: MomentOf<"dropTaken">) => {
  const { x, z } = taken
  fx.layers.face.spawn({ frames: fx.f.burst, x, y: 0.9, z, size: 1.8, sizeEnd: 2.8, rotation: fx.rng() * 6, life: 3 / ON_TWOS, alpha: 1, alphaEnd: 0.2, clock: "real" })
  fx.layers.flatGlow.spawn({ frames: fx.f.haloRing, x, y: 0.12, z, size: 0.8, sizeEnd: 4.2, life: 0.35, alpha: 1, alphaEnd: 0, clock: "real" })
  for (let index = 0; index < 10; index++) {
    const direction = (index / 10) * Math.PI * 2
    fx.layers.glow.spawn({ frames: index % 3 === 0 ? fx.f.ember : fx.f.glint, x: x + Math.cos(direction) * 0.4, y: 0.7, z: z + Math.sin(direction) * 0.4, vx: Math.cos(direction) * 2.2, vy: 3 + fx.rng() * 2, vz: Math.sin(direction) * 2.2, size: 0.45, sizeEnd: 0.1, color: index % 3 === 0 ? PALETTE.red : 0xffffff, life: 0.55, alphaEnd: 0, clock: "real" })
  }
}

const onStageCleared = (fx: Fx) => {
  const player = fx.context.game.view().player
  if (player === null) return
  fx.impacts.frame(["stark", "ink"], { fps: 18 })
  fx.layers.flatGlow.spawn({ frames: fx.f.shock, x: player.x, y: 0.1, z: player.z, size: 2, sizeEnd: 30, color: PALETTE.red, life: 0.8, alpha: 1, alphaEnd: 0, clock: "real" })
  fx.layers.flat.spawn({ frames: fx.f.dryRing, x: player.x, y: 0.08, z: player.z, size: 2, sizeEnd: 24, life: 0.7, alpha: 0.8, alphaEnd: 0, clock: "real" })
}

/**
 * Hits, kills, parries, reflections, the player's own hurts, and the stage's last blow. Full-screen impact frames
 * are kept for the moments that end something (a parry, a wave's last kill, the stage, the player) and the special.
 */
export const installCombat = (fx: Fx) => {
  const { moments } = fx.context
  /** Real time of the last spin that pulsed the frame: one per spin, however many it strikes. */
  let spinPulseAt = Number.NEGATIVE_INFINITY
  /** Splitters that split this frame: their split is their death, drawn by ./foes.ts instead of a shatter. */
  const split = new Set<number>()
  const offs = [
    moments.on("hit", (hit) => {
      onHit(fx, hit)
      if (hit.source !== "spin" || fx.context.time.elapsed - spinPulseAt < 0.4) return
      spinPulseAt = fx.context.time.elapsed
      fx.impacts.pulse("ink", 0.36)
    }),
    moments.on("roomCleared", () => onStageCleared(fx)),
    moments.on("split", (moment) => split.add(moment.id)),
    moments.on("enemyKilled", (kill) => {
      onKill(fx, kill, split.delete(kill.id))
    }),
    moments.on("parry", (parry) => onParry(fx, parry)),
    moments.on("parryStarted", (parry) => onParryStarted(fx, parry)),
    moments.on("reflect", (reflect) => onReflect(fx, reflect)),
    moments.on("playerHurt", (hurt) => onHurt(fx, hurt)),
    moments.on("playerDown", (down) => onDown(fx, down)),
    moments.on("nearMiss", (miss) => onNearMiss(fx, miss)),
    moments.on("focusFull", () => onFocusFull(fx)),
    moments.on("dropTaken", (taken) => onDropTaken(fx, taken))
  ]
  return () => {
    for (const off of offs) off()
  }
}
