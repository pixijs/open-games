import { linearOf } from "../art/color.ts"
import { PALETTE, paletteOfKind } from "../art/palette.ts"
import { Tuning } from "../sim/index.ts"
import type { EnemyKind, EnemyView, MomentOf } from "../sim/index.ts"
import { ON_TWOS } from "./cues.ts"
import { angleOf, drawnAt, pick, spray, spread } from "./fx.ts"
import type { Fx } from "./fx.ts"
import { flashShape, shapeCell } from "./shards.ts"

const accentOf = (kind: EnemyKind) => paletteOfKind(kind).danger
const AMBER = accentOf("warden")
const VIOLET = accentOf("splitter")

/**
 * What the Spiral's and the Void's enemies do in ink: the orbiter's dotted orbit and its cut, the warden's armour
 * ringing as blows glance off it, its spiral volley, the white ring that marks it open and its shell bursting when it
 * dies, the lancer's lock-on and its charge, and the splitter breaking in two.
 */

/** Units of ground between the dots an orbiter leaves as it circles, and between a charging lancer's afterimages. */
const ORBIT_DOT = 0.55
const CHARGE_GHOST = 0.9

interface Trail {
  x: number
  z: number
  walked: number
}

const onClank = (fx: Fx, clank: MomentOf<"clank">) => {
  const radius = Tuning.ENEMY[clank.kind].radius
  const x = clank.x - clank.dirX * radius
  const z = clank.z - clank.dirZ * radius
  const back = angleOf(-clank.dirX, -clank.dirZ)
  fx.layers.glow.spawn({ frames: fx.f.glint, x, y: 0.6, z, size: 2.2, sizeEnd: 0.5, rotation: spread(fx.rng, 0.4), color: 0xffffff, life: 0.18, alpha: 1 })
  fx.layers.flat.spawn({ frames: fx.f.ringSmall, x: clank.x, y: 0.55, z: clank.z, size: radius * 2.3, sizeEnd: radius * 2.8, color: 0xffffff, life: 2 / ON_TWOS, alpha: 1, alphaEnd: 0.2 })
  spray(fx, { count: 8, x, y: 0.6, z, angle: back, cone: 0.9, speed: [7, 13], size: [0.4, 0.7], frame: (index) => (index % 3 === 0 ? fx.f.sparkRed : fx.f.spark), life: 0.24 })
  fx.context.rig.shake(0.08, { x, z, dirX: -clank.dirX, dirZ: -clank.dirZ, shape: "recoil", duration: 0.16 })
  fx.context.rig.punch(0.8)
}

const onVolley = (fx: Fx, volley: MomentOf<"volley">) => {
  fx.layers.flatGlow.spawn({ frames: fx.f.shock, x: volley.x, y: 0.12, z: volley.z, size: 2, sizeEnd: 6, color: AMBER, life: 4 / ON_TWOS, alpha: 1, alphaEnd: 0 })
  fx.layers.glow.spawn({ frames: fx.f.glint, x: volley.x, y: 0.9, z: volley.z, size: 3, sizeEnd: 0.6, rotation: 0.78, color: 0xffffff, life: 0.2 })
  fx.context.rig.shake(0.08, { x: volley.x, z: volley.z, shape: "rumble", duration: volley.shots * volley.interval })
}

/** The warden's open window: a white ring round it that tightens while it lasts, so the opening reads at a glance. */
const onOpen = (fx: Fx, open: MomentOf<"wardenOpen">) => {
  for (let index = 0; index < 6; index++) {
    const direction = (index / 6) * Math.PI * 2 + spread(fx.rng, 0.3)
    fx.layers.flat.spawn({ frames: fx.f.pebble, x: open.x + Math.cos(direction) * 0.9, y: 0.4, z: open.z + Math.sin(direction) * 0.9, vx: Math.cos(direction) * 2.4, vy: 2.5, vz: Math.sin(direction) * 2.4, size: 0.16, gravity: 16, ground: true, spin: 8, life: 0.6, hold: 0.5, alphaEnd: 0 })
  }
  fx.layers.flat.spawn({ frames: fx.f.dryRing, x: open.x, y: 0.1, z: open.z, size: 1.8, sizeEnd: 3.6, life: 3 / ON_TWOS, alpha: 0.8, alphaEnd: 0 })
  fx.cues.play({
    clock: "game",
    life: open.duration,
    fps: ON_TWOS,
    draw: (drawing, age) => {
      const at = fx.context.actor(open.id)?.node.position
      if (at === undefined) return
      const left = 1 - age / open.duration
      fx.layers.flat.spawn({ frames: fx.f.ringSmall, x: at.x, y: 0.06, z: at.z, size: 2.2 + left * 1.4, color: 0xffffff, life: 1 / ON_TWOS, alpha: drawing % 2 === 0 ? 0.85 : 0.5, alphaEnd: drawing % 2 === 0 ? 0.85 : 0.5 })
    }
  })
}

/** A splitter breaks along its seam: a white cut, the two halves thrown out along the pieces' paths, then the splitlings pop in. */
const onSplit = (fx: Fx, split: MomentOf<"split">) => {
  const shape = fx.f.shapes.splitter
  const cell = shapeCell("splitter")
  const first = split.pieces[0]
  const across = first === undefined ? 0 : angleOf(first.dirX, first.dirZ) + Math.PI / 2
  flashShape(fx, "splitter", split.x, split.z, across, 1.3, 1.5 / ON_TWOS)
  fx.layers.flat.spawn({ frames: fx.f.cutline, x: split.x, y: 0.62, z: split.z, size: cell * 3, sizeEnd: cell * 3.6, rotation: across, life: 2 / ON_TWOS, alpha: 1, alphaEnd: 0.5 })
  fx.layers.glow.spawn({ frames: fx.f.halo, x: split.x, y: 0.5, z: split.z, size: 3, sizeEnd: 0.8, color: VIOLET, life: 0.18, alpha: 0.9, fps: 0 })
  split.pieces.forEach((piece, index) => {
    const frame = shape.halves[index % 2]
    if (frame === undefined) return
    const angle = angleOf(piece.dirX, piece.dirZ)
    fx.layers.flat.spawn({ frames: frame, x: split.x, y: 0.45, z: split.z, vx: piece.dirX * 6, vz: piece.dirZ * 6, size: cell, rotation: across, spin: (index % 2 === 0 ? 1 : -1) * 6, drag: 8, life: 2 / ON_TWOS, alpha: 1, alphaEnd: 1 })
    for (let line = 0; line < 2; line++) {
      const side = spread(fx.rng, 0.25)
      fx.layers.flat.spawn({ frames: fx.f.speedline, x: piece.x - piece.dirX * (0.6 + line * 0.4) - piece.dirZ * side, y: 0.3, z: piece.z - piece.dirZ * (0.6 + line * 0.4) + piece.dirX * side, vx: piece.dirX * 3, vz: piece.dirZ * 3, size: 1.4, sizeEnd: 0.6, rotation: angle, color: VIOLET, life: 0.24, alphaEnd: 0 })
    }
  })
  spray(fx, { count: 6, x: split.x, y: 0.5, z: split.z, angle: across, cone: Math.PI, speed: [6, 12], size: [0.4, 0.7], frame: () => fx.f.sparkRed, life: 0.28 })
}

/**
 * Per frame, from the view: the orbiter's dotted orbit, the warden's three arms turning on its windup ring, the
 * lancer's lock-on at the end of its aim line, and afterimages along a lancer's charge or an orbiter's cut.
 */
const followFoes = (fx: Fx, trails: Map<number, Trail>, seen: Set<number>, drawing: number) => {
  seen.clear()
  for (const enemy of fx.context.game.view().enemies) {
    seen.add(enemy.id)
    const { x, z } = drawnAt(fx, enemy.id, enemy)
    const trail = trails.get(enemy.id) ?? { x, z, walked: 0 }
    trails.set(enemy.id, trail)
    const step = Math.hypot(x - trail.x, z - trail.z)
    trail.walked += step
    const dirX = step > 0 ? (x - trail.x) / step : 0
    const dirZ = step > 0 ? (z - trail.z) / step : 0
    trail.x = x
    trail.z = z
    if (enemy.kind === "orbiter") orbit(fx, enemy, trail, x, z, dirX, dirZ)
    if (enemy.kind === "lancer") lance(fx, enemy, trail, x, z, dirX, dirZ, drawing)
    if (enemy.kind === "warden" && enemy.state === "Windup" && drawing >= 0) arms(fx, enemy, x, z)
    if (enemy.kind === "leaper" || enemy.kind === "sunder") fallLines(fx, enemy, x, z, drawing)
  }
  for (const id of trails.keys()) if (!seen.has(id)) trails.delete(id)
}

const orbit = (fx: Fx, enemy: EnemyView, trail: Trail, x: number, z: number, dirX: number, dirZ: number) => {
  const cutting = enemy.state === "Lunge"
  const gap = cutting ? CHARGE_GHOST * 0.7 : ORBIT_DOT
  if (trail.walked < gap || (enemy.state !== "Move" && !cutting)) return
  trail.walked = 0
  if (cutting) {
    flashShape(fx, "orbiter", x - dirX * 0.4, z - dirZ * 0.4, 0, 1, 0.12)
    fx.layers.flat.spawn({ frames: fx.f.speedline, x: x - dirX * 1.2, y: 0.3, z: z - dirZ * 1.2, vx: dirX * 3, vz: dirZ * 3, size: 2.2, sizeEnd: 1, rotation: angleOf(dirX, dirZ), color: AMBER, life: 0.22, alphaEnd: 0 })
    return
  }
  fx.layers.floor.spawn({ frames: fx.f.ringSmall, x, y: 0.03, z, size: 0.5, sizeEnd: 0.22, color: AMBER, life: 1, hold: 0.3, alpha: 0.95, alphaEnd: 0, fps: 0 })
}

const lance = (fx: Fx, enemy: EnemyView, trail: Trail, x: number, z: number, dirX: number, dirZ: number, drawing: number) => {
  const telegraph = enemy.telegraph
  if (enemy.state === "Windup" && telegraph !== null && drawing >= 0) {
    const reach = telegraph.size
    const tx = x + telegraph.dirX * reach
    const tz = z + telegraph.dirZ * reach
    const lock = Math.min(1, telegraph.progress * 1.3)
    fx.layers.face.spawn({ frames: fx.f.lockon, x: tx, y: 0.3, z: tz, size: 2.4 - lock * 1.2, rotation: Math.PI / 4 + (1 - lock) * 0.8, life: 1 / ON_TWOS, alpha: 0.6 + lock * 0.4, alphaEnd: 0.6 + lock * 0.4 })
    if (drawing % 2 === 0) fx.layers.glow.spawn({ frames: fx.f.glint, x: x + telegraph.dirX * 0.9, y: 0.45, z: z + telegraph.dirZ * 0.9, size: 0.8 + lock * 0.8, rotation: 0.78, color: 0xffffff, life: 1 / ON_TWOS })
    return
  }
  if (enemy.state !== "Lunge" || trail.walked < CHARGE_GHOST) return
  trail.walked = 0
  const angle = angleOf(dirX, dirZ)
  fx.layers.flat.spawn({ frames: fx.f.shapes.lancer.flash, x: x - dirX * 0.5, y: 0.45, z: z - dirZ * 0.5, size: shapeCell("lancer") * 1.1, rotation: angle, life: 0.16, alpha: 0.8, alphaEnd: 0 })
  fx.layers.flat.spawn({ frames: fx.f.cutline, x: x - dirX * 1.4, y: 0.32, z: z - dirZ * 1.4, size: 3.4, sizeEnd: 2.2, rotation: angle, life: 0.2, alpha: 1, alphaEnd: 0 })
  fx.layers.floor.spawn({ frames: fx.f.speedline, x: x - dirX * 0.8, y: 0.025, z: z - dirZ * 0.8, size: 2.2, rotation: angle + Math.PI, color: PALETTE.ink, life: 2.5, hold: 0.5, alpha: 0.35, alphaEnd: 0, fps: 0 })
}

/** Three chevrons riding the warden's windup ring, turning as it winds up: where its three arms will fire. */
const arms = (fx: Fx, enemy: EnemyView, x: number, z: number) => {
  const telegraph = enemy.telegraph
  if (telegraph === null) return
  const turn = enemy.facing + telegraph.progress * 1.2
  const radius = 1.3 + telegraph.progress * 0.5
  for (let arm = 0; arm < 3; arm++) {
    const angle = turn + (arm / 3) * Math.PI * 2
    fx.layers.flat.spawn({ frames: fx.f.chevron, x: x + Math.cos(angle) * radius, y: 0.1, z: z + Math.sin(angle) * radius, size: 0.6, rotation: angle, life: 1 / ON_TWOS, alpha: 0.5 + telegraph.progress * 0.5, alphaEnd: 0.5 + telegraph.progress * 0.5 })
  }
}

/** A warden's death bursts its shell: the plates fly off round it, spinning, as the eye shatters. */
const onKill = (fx: Fx, kill: MomentOf<"enemyKilled">) => {
  if (kill.kind !== "warden" || kill.source === "ringOut") return
  const plates = fx.f.shapes.warden.fragments
  for (let index = 0; index < 6; index++) {
    const direction = (index / 6) * Math.PI * 2 + spread(fx.rng, 0.25)
    const speed = 4 + fx.rng() * 3
    fx.layers.flat.spawn({
      frames: plates[index % plates.length] ?? fx.f.shard,
      x: kill.x + Math.cos(direction) * 0.8,
      y: 0.5,
      z: kill.z + Math.sin(direction) * 0.8,
      vx: Math.cos(direction) * speed + kill.dirX * 2,
      vy: 3 + fx.rng() * 3,
      vz: Math.sin(direction) * speed + kill.dirZ * 2,
      size: 0.9,
      sizeEnd: 0.7,
      rotation: direction,
      spin: spread(fx.rng, 10),
      gravity: 16,
      ground: true,
      drag: 1.5,
      life: 1.2,
      hold: 0.6,
      alphaEnd: 0
    })
  }
}

/** Per drawing of a sweep's smear: tail, head, erosion, brightness; then it erodes from the tail. */
const SMEAR = [[0, 0.35, 0, 2.4], [0, 0.7, 0, 2], [0, 1, 0, 1.8], [0.25, 1, 0.3, 1.45], [0.55, 1, 0.6, 1.2], [0.8, 1, 0.85, 1]] as const

/**
 * An arm sweeping (a sweeper's, the Orrery's two hands): a crescent smear in the accent following the arm round the
 * arc it marked, revealed as the arm passes and eroding behind it into dry-brush streaks.
 */
const onSweep = (fx: Fx, sweep: MomentOf<"sweep">) => {
  const edge = linearOf(accentOf(sweep.kind))
  for (let arm = 0; arm < sweep.arms; arm++) {
    const from = sweep.from + arm * Math.PI
    const centre = from + sweep.turn * sweep.span / 2
    const shape = sweep.arms > 1 ? "hand" : "sweep"
    const arc = fx.arcs.take(shape)
    const radius = sweep.radius * 1.04
    arc.place(sweep.x, 0.42, sweep.z, centre, radius, sweep.turn === 1, sweep.turn * 0.12, 0)
    const variant = Math.floor(fx.rng() * 3)
    const drawings = Math.max(3, Math.round(sweep.duration * ON_TWOS))
    fx.cues.play({
      clock: "game",
      life: (drawings + SMEAR.length - 3) / ON_TWOS,
      fps: ON_TWOS,
      draw: (drawing) => {
        const sweeping = drawing < drawings
        const pose = sweeping ? [0, (drawing + 1) / drawings, 0, 2.2] as const : SMEAR[Math.min(SMEAR.length - 1, drawing - drawings + 3)] ?? SMEAR[5]
        arc.pose(pose[0], pose[1], pose[2], pose[3], variant, 1, edge)
        if (!sweeping) return
        const angle = from + sweep.turn * sweep.span * ((drawing + 1) / drawings)
        const tipX = sweep.x + Math.cos(angle) * sweep.radius
        const tipZ = sweep.z + Math.sin(angle) * sweep.radius
        fx.layers.flat.spawn({ frames: fx.f.speedline, x: tipX, y: 0.35, z: tipZ, size: 1.6, sizeEnd: 0.6, rotation: angle + sweep.turn * Math.PI / 2, color: accentOf(sweep.kind), life: 0.2, alphaEnd: 0 })
        fx.layers.floor.spawn({ frames: fx.f.speck, x: tipX, y: 0.025, z: tipZ, size: 0.5, rotation: angle, color: PALETTE.ink, life: 3, hold: 0.4, alpha: 0.5, alphaEnd: 0, fps: 0 })
      },
      end: () => fx.arcs.give(shape, arc)
    })
  }
  fx.context.rig.shake(sweep.arms > 1 ? 0.18 : 0.06, { x: sweep.x, z: sweep.z, shape: "rumble", duration: sweep.duration })
}

/** A leap leaving: dust bursting from where it stood, speed lines rising. */
const onLeap = (fx: Fx, leap: MomentOf<"leap">) => {
  const big = leap.radius > 2
  fx.layers.flat.spawn({ frames: fx.f.dryRing, x: leap.fromX, y: 0.06, z: leap.fromZ, size: big ? 3 : 1.4, sizeEnd: big ? 6 : 3, life: 4 / ON_TWOS, alpha: 0.7, alphaEnd: 0 })
  for (let index = 0; index < (big ? 8 : 5); index++) {
    const side = spread(fx.rng, big ? 1.4 : 0.6)
    fx.layers.face.spawn({ frames: fx.f.speedline, x: leap.fromX + side, y: 0.5, z: leap.fromZ + spread(fx.rng, 0.4), vy: 9, size: 1.6, sizeEnd: 0.6, rotation: Math.PI / 2, color: 0xffffff, life: 0.25, alphaEnd: 0 })
  }
}

/** A leap landing: a shock ring and a dust ring the size of its strike, pebbles thrown, a crack left, the camera jolted. */
const onLanded = (fx: Fx, landed: MomentOf<"landed">) => {
  const { x, z, radius } = landed
  const accent = accentOf(landed.kind)
  fx.layers.flat.spawn({ frames: fx.f.shock, x, y: 0.12, z, size: radius * 1.1, sizeEnd: radius * 2.4, rotation: fx.rng() * 6, life: 4 / ON_TWOS, alpha: 1, alphaEnd: 0.2 })
  fx.layers.flatGlow.spawn({ frames: fx.f.haloRing, x, y: 0.1, z, size: radius * 1.4, sizeEnd: radius * 2.6, color: accent, life: 0.3, alpha: 0.9, fps: 0 })
  fx.layers.flat.spawn({ frames: fx.f.dryRing, x, y: 0.08, z, size: radius * 1.6, sizeEnd: radius * 2.8, life: 5 / ON_TWOS, alpha: 0.75, alphaEnd: 0 })
  fx.layers.floor.spawn({ frames: pick(fx.rng, fx.f.cracks, fx.f.inkDrop), x, y: 0.022, z, size: radius * 1.8, rotation: fx.rng() * 6, life: 8, hold: 0.8, alpha: 0.85, alphaEnd: 0, fps: 0 })
  for (let index = 0; index < 10; index++) {
    const direction = (index / 10) * Math.PI * 2 + spread(fx.rng, 0.3)
    const speed = 3 + fx.rng() * 4
    fx.layers.flat.spawn({ frames: fx.f.pebble, x: x + Math.cos(direction) * radius * 0.5, y: 0.2, z: z + Math.sin(direction) * radius * 0.5, vx: Math.cos(direction) * speed, vy: 3 + fx.rng() * 3, vz: Math.sin(direction) * speed, size: 0.18 + fx.rng() * 0.18, spin: spread(fx.rng, 10), gravity: 20, ground: true, life: 0.9, hold: 0.6, alphaEnd: 0 })
  }
  fx.context.rig.shake(radius > 2 ? 0.5 : 0.22, { x, z, shape: "explosion", duration: 0.35 })
  if (radius > 2) fx.context.rig.punch(2.5)
}

/** A leaper falling: speed lines streaming down onto its spot in the fall's last drawings. */
const fallLines = (fx: Fx, enemy: EnemyView, x: number, z: number, drawing: number) => {
  if (enemy.state !== "Leap" || drawing < 0) return
  const air = (enemy.kind === "sunder" ? Tuning.SUNDER.leap.air.steps : Tuning.LEAPER.air.steps) / 60
  if (enemy.timeLeft > air * 0.3) return
  for (let index = 0; index < 2; index++) {
    fx.layers.face.spawn({ frames: fx.f.speedline, x: x + spread(fx.rng, 0.8), y: 2.5, z: z + spread(fx.rng, 0.5), vy: -14, size: 2, sizeEnd: 1, rotation: Math.PI / 2, color: index === 0 ? 0xffffff : accentOf(enemy.kind), life: 0.16, alphaEnd: 0 })
  }
}

export const installFoes = (fx: Fx) => {
  const trails = new Map<number, Trail>()
  const seen = new Set<number>()
  let drawing = -1
  const { moments } = fx.context
  const offs = [
    moments.on("clank", (clank) => onClank(fx, clank)),
    moments.on("volley", (volley) => onVolley(fx, volley)),
    moments.on("wardenOpen", (open) => onOpen(fx, open)),
    moments.on("split", (split) => onSplit(fx, split)),
    moments.on("enemyKilled", (kill) => onKill(fx, kill)),
    moments.on("sweep", (sweep) => onSweep(fx, sweep)),
    moments.on("leap", (leap) => onLeap(fx, leap)),
    moments.on("landed", (landed) => onLanded(fx, landed))
  ]
  return {
    update: (gameElapsed: number, gameDt: number) => {
      if (gameDt === 0) return
      const now = Math.floor(gameElapsed * ON_TWOS)
      const fresh = now !== drawing
      drawing = now
      followFoes(fx, trails, seen, fresh ? drawing : -1)
    },
    clear: () => trails.clear(),
    dispose: () => {
      for (const off of offs) off()
    }
  }
}
