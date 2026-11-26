import { paletteOfKind } from "../art/palette.ts"
import { Tuning } from "../sim/index.ts"
import type { BossId, EnemyKind, MomentOf } from "../sim/index.ts"
import { ON_TWOS } from "./cues.ts"
import { angleOf, drawnAt, pick, spray, spread } from "./fx.ts"
import type { Fx } from "./fx.ts"
import { flashShape, shapeCell, shatter } from "./shards.ts"

/**
 * The bosses' beats drawn in ink: the name card's summoning circle and converging speed lines, the glint each pattern
 * opens on, the roar of a shift (impact frames, rings of shock running out, the floor cracking), the cracked white ring
 * of a break, stars over a stunned Gatekeeper, Sunder splitting and rejoining, the moons' cuts, and the defeat: the
 * biggest drawing after the special, the boss held breaking apart in slow motion under cinema bars, then shattering.
 */

const accentOf = (boss: EnemyKind) => paletteOfKind(boss).danger

/** Focus lines round a point on the ground for `life` real seconds, fading over their drawings. */
const focus = (fx: Fx, x: number, z: number, life: number, alpha: number) => {
  fx.cues.play({
    clock: "real",
    life,
    fps: 12,
    draw: (drawing) => {
      const screen = fx.context.view.worldToScreen({ x, y: 0.6, z })
      if (screen === null) return
      fx.screen.setFocus(drawing, screen.x, screen.y, "paper", Math.max(0.2, alpha - drawing * 0.04), 1 + drawing * 0.05, fx.rng)
    },
    end: () => fx.screen.hideFocus()
  })
}

/** The name card: a summoning circle opens under the boss, ink bursts round it, speed lines rush in. */
const onIntro = (fx: Fx, intro: MomentOf<"bossIntro">) => {
  const { x, z } = intro
  const accent = accentOf(intro.boss)
  const size = Tuning.ENEMY[intro.boss].radius
  fx.layers.flat.spawn({ frames: fx.f.summon, x, y: 0.05, z, size: size * 7, sizeEnd: size * 5.2, rotation: fx.rng() * 6, spin: 0.6, color: accent, life: intro.duration + 0.4, alpha: 0.9, alphaEnd: 0.4, clock: "real", fps: 6 })
  fx.layers.flat.spawn({ frames: fx.f.dryRing, x, y: 0.07, z, size: size * 2, sizeEnd: size * 9, life: 0.6, alpha: 0.8, alphaEnd: 0, clock: "real" })
  fx.layers.flatGlow.spawn({ frames: fx.f.shock, x, y: 0.1, z, size: size * 2, sizeEnd: size * 8, color: accent, life: 0.5, alpha: 1, alphaEnd: 0, clock: "real" })
  for (let index = 0; index < 10; index++) {
    const direction = (index / 10) * Math.PI * 2 + spread(fx.rng, 0.2)
    const reach = size * (2.2 + fx.rng() * 1.6)
    fx.layers.floor.spawn({ frames: pick(fx.rng, fx.f.splats, fx.f.inkDrop), x: x + Math.cos(direction) * reach, y: 0.024, z: z + Math.sin(direction) * reach, size: 1 + fx.rng() * 1.2, rotation: direction, life: 12, hold: 0.85, alpha: 0.8, alphaEnd: 0, fps: 0 })
  }
  fx.cues.play({
    clock: "real",
    life: intro.duration,
    fps: ON_TWOS,
    draw: (drawing) => {
      if (drawing % 2 === 1) return
      for (let index = 0; index < 4; index++) {
        const direction = fx.rng() * Math.PI * 2
        const reach = size * (4 + fx.rng() * 3)
        fx.layers.flat.spawn({ frames: fx.f.speedline, x: x + Math.cos(direction) * reach, y: 0.3, z: z + Math.sin(direction) * reach, vx: -Math.cos(direction) * 10, vz: -Math.sin(direction) * 10, size: 2.4, sizeEnd: 0.8, rotation: direction + Math.PI, color: index % 2 === 0 ? 0xffffff : accent, life: 0.3, alphaEnd: 0, clock: "real" })
      }
    }
  })
  focus(fx, x, z, intro.duration * 0.6, 0.55)
  fx.impacts.frame(["ink"])
  fx.context.rig.punch(3)
  fx.context.rig.shake(0.25, { x, z, shape: "rumble", duration: 0.6 })
}

const onPattern = (fx: Fx, pattern: MomentOf<"bossPattern">) => {
  const at = drawnAt(fx, pattern.id, pattern)
  fx.layers.glow.spawn({ frames: fx.f.glint, x: at.x, y: 2.2, z: at.z, size: 3.2, sizeEnd: 0.8, rotation: 0.78, color: accentOf(pattern.boss), life: 0.24 })
}

/** A shift: impact frames, a roar of rings running out, stone thrown up, the floor cracked round it. */
const onPhase = (fx: Fx, phase: MomentOf<"bossPhase">) => {
  const { x, z } = drawnAt(fx, phase.id, phase)
  const accent = accentOf(phase.boss)
  const reach = Tuning.BOSS.roarReach
  fx.impacts.frame(["stark", "ink"], { fps: 15 })
  for (let ring = 0; ring < 3; ring++) {
    fx.cues.play({
      clock: "game",
      life: (ring + 1) * 0.12,
      fps: ON_TWOS,
      draw: () => {},
      end: () => {
        fx.layers.flat.spawn({ frames: fx.f.shock, x, y: 0.12, z, size: 2, sizeEnd: reach * 2.2, rotation: fx.rng() * 6, life: 0.45, alpha: 1, alphaEnd: 0 })
        fx.layers.flatGlow.spawn({ frames: fx.f.haloRing, x, y: 0.1, z, size: 2, sizeEnd: reach * 2.1, color: accent, life: 0.45, alpha: 0.85, fps: 0 })
      }
    })
  }
  fx.layers.flat.spawn({ frames: fx.f.dryRing, x, y: 0.08, z, size: 3, sizeEnd: reach * 2.4, life: 0.6, alpha: 0.8, alphaEnd: 0 })
  for (let index = 0; index < 16; index++) {
    const direction = (index / 16) * Math.PI * 2 + spread(fx.rng, 0.2)
    const speed = 5 + fx.rng() * 5
    fx.layers.flat.spawn({ frames: fx.f.pebble, x: x + Math.cos(direction) * 1.5, y: 0.3, z: z + Math.sin(direction) * 1.5, vx: Math.cos(direction) * speed, vy: 4 + fx.rng() * 4, vz: Math.sin(direction) * speed, size: 0.22 + fx.rng() * 0.25, spin: spread(fx.rng, 10), gravity: 20, ground: true, life: 1.2, hold: 0.6, alphaEnd: 0 })
    if (index % 3 === 0) fx.layers.floor.spawn({ frames: pick(fx.rng, fx.f.cracks, fx.f.inkDrop), x: x + Math.cos(direction) * 3, y: 0.022, z: z + Math.sin(direction) * 3, size: 2.4, rotation: direction, life: 10, hold: 0.8, alpha: 0.8, alphaEnd: 0, fps: 0 })
  }
  fx.cues.play({
    clock: "game",
    life: phase.duration,
    fps: ON_TWOS,
    draw: (drawing) => {
      const at = drawnAt(fx, phase.id, { x, z })
      if (drawing % 2 === 0) fx.layers.glow.spawn({ frames: fx.f.halo, x: at.x, y: 0.6, z: at.z, size: 6, sizeEnd: 4, color: accent, life: 2 / ON_TWOS, alpha: 0.5, fps: 0 })
      fx.layers.flat.spawn({ frames: fx.f.speedline, x: at.x + spread(fx.rng, 2), y: 0.4, z: at.z + spread(fx.rng, 2), vy: 6, size: 1.8, sizeEnd: 0.6, rotation: fx.rng() * 6, color: 0xffffff, life: 0.2, alphaEnd: 0 })
    }
  })
  focus(fx, x, z, 0.7, 0.75)
  fx.impacts.pulse("ink", 0.7, 6)
  fx.context.rig.shake(0.6, { x, z, shape: "explosion", duration: 0.8 })
  fx.context.rig.punch(4)
}

/** A break: the stark frame, a cracked white ring round it held while it is open, shards bursting off. */
const onBroken = (fx: Fx, broken: MomentOf<"bossBroken">) => {
  const { x, z } = drawnAt(fx, broken.id, broken)
  const size = Tuning.ENEMY[broken.boss].radius
  fx.impacts.frame(["stark"])
  fx.layers.face.spawn({ frames: fx.f.xflash, x, y: 1.2, z, size: size * 4, sizeEnd: size * 4.6, rotation: spread(fx.rng, 0.4), life: 3 / ON_TWOS, alpha: 1, alphaEnd: 0.4 })
  spray(fx, { count: 14, x, y: 0.8, z, angle: 0, cone: Math.PI, speed: [8, 16], size: [0.6, 1.1], frame: () => fx.f.shard, life: 0.4 })
  fx.cues.play({
    clock: "game",
    life: broken.duration,
    fps: ON_TWOS,
    draw: (drawing, age) => {
      const at = drawnAt(fx, broken.id, { x, z })
      const left = 1 - age / broken.duration
      fx.layers.flat.spawn({ frames: drawing % 2 === 0 ? fx.f.dryRing : fx.f.ringSmall, x: at.x, y: 0.09, z: at.z, size: size * (2.6 + left * 0.8), rotation: drawing * 0.4, life: 1 / ON_TWOS, alpha: 0.9, alphaEnd: 0.9 })
      if (drawing % 3 === 0) fx.layers.floor.spawn({ frames: pick(fx.rng, fx.f.cracks, fx.f.inkDrop), x: at.x + spread(fx.rng, size), y: 0.023, z: at.z + spread(fx.rng, size), size: 1.4, rotation: fx.rng() * 6, life: 6, hold: 0.7, alpha: 0.6, alphaEnd: 0, fps: 0 })
    }
  })
  fx.context.rig.punch(3.5)
  fx.context.rig.shake(0.3, { x, z, shape: "explosion", duration: 0.4 })
}

const onRecovered = (fx: Fx, recovered: MomentOf<"bossRecovered">) => {
  const boss = fx.context.game.view().enemies.find((enemy) => enemy.id === recovered.id)
  if (boss === undefined) return
  const { x, z } = drawnAt(fx, recovered.id, boss)
  spray(fx, { count: 10, x, y: 0.5, z, angle: 0, cone: Math.PI, speed: [5, 10], size: [0.4, 0.7], frame: () => fx.f.sparkWhite, life: 0.3 })
  fx.layers.flatGlow.spawn({ frames: fx.f.haloRing, x, y: 0.1, z, size: 4, sizeEnd: 7, color: accentOf(recovered.boss), life: 0.3, alpha: 0.8, fps: 0 })
}

/** A charge that met a wall or pillar: a crash burst, stone thrown, stars circling over the dazed Gatekeeper. */
const onStunned = (fx: Fx, stunned: MomentOf<"bossStunned">) => {
  const { x, z } = stunned
  fx.layers.face.spawn({ frames: fx.f.burst, x, y: 0.8, z, size: 5, sizeEnd: 5.6, rotation: fx.rng() * 6, life: 3 / ON_TWOS, alpha: 1, alphaEnd: 0.5 })
  for (let index = 0; index < (stunned.breaks ? 18 : 10); index++) {
    const direction = fx.rng() * Math.PI * 2
    const speed = 3 + fx.rng() * 6
    fx.layers.flat.spawn({ frames: fx.f.pebble, x, y: 0.6, z, vx: Math.cos(direction) * speed, vy: 3 + fx.rng() * 5, vz: Math.sin(direction) * speed, size: stunned.breaks ? 0.3 + fx.rng() * 0.4 : 0.2 + fx.rng() * 0.2, spin: spread(fx.rng, 12), gravity: 20, ground: true, life: 1.2, hold: 0.6, alphaEnd: 0 })
  }
  fx.cues.play({
    clock: "game",
    life: stunned.duration,
    fps: ON_TWOS,
    draw: (drawing) => {
      const at = drawnAt(fx, stunned.id, stunned)
      for (let star = 0; star < 3; star++) {
        const angle = drawing * 0.5 + (star / 3) * Math.PI * 2
        fx.layers.face.spawn({ frames: fx.f.star, x: at.x + Math.cos(angle) * 1.4, y: 2.4 + Math.sin(angle * 2) * 0.15, z: at.z + Math.sin(angle) * 1.4, size: 0.5, rotation: angle, color: 0xffffff, life: 1 / ON_TWOS, alpha: 1, alphaEnd: 1 })
      }
    }
  })
  fx.impacts.pulse("ink", 0.5, 2)
  fx.context.rig.shake(0.45, { x, z, shape: "explosion", duration: 0.4 })
  fx.context.rig.punch(2.5)
}

/** Sunder splitting: a white cut down its seam, the two halves thrown apart on speed lines. */
const onSplit = (fx: Fx, split: MomentOf<"bossSplit">) => {
  const { x, z } = split
  const cell = shapeCell("sunder")
  flashShape(fx, "sunder", x, z, 0, 1.3, 2 / ON_TWOS)
  fx.layers.flat.spawn({ frames: fx.f.cutline, x, y: 1, z, size: cell * 3.2, sizeEnd: cell * 3.8, rotation: Math.PI / 3, life: 3 / ON_TWOS, alpha: 1, alphaEnd: 0.5 })
  const halves = fx.f.shapes.sunder.halves
  halves.forEach((frame, index) => {
    const side = index === 0 ? 1 : -1
    const direction = Math.PI / 3 + side * Math.PI / 2
    fx.layers.flat.spawn({ frames: frame, x, y: 0.6, z, vx: Math.cos(direction) * 8, vz: Math.sin(direction) * 8, size: cell, rotation: Math.PI / 3, spin: side * 4, drag: 10, life: 3 / ON_TWOS, alpha: 1, alphaEnd: 0.6 })
  })
  spray(fx, { count: 8, x, y: 0.6, z, angle: 0, cone: Math.PI, speed: [6, 12], size: [0.4, 0.8], frame: () => fx.f.sparkWhite, life: 0.3 })
  fx.impacts.frame(["stark"])
  fx.context.rig.shake(0.35, { x, z, shape: "explosion", duration: 0.35 })
}

const onRejoined = (fx: Fx, rejoined: MomentOf<"bossRejoined">) => {
  const { x, z } = rejoined
  flashShape(fx, "sunder", x, z, 0, 1.2, 2 / ON_TWOS)
  fx.layers.flatGlow.spawn({ frames: fx.f.shock, x, y: 0.1, z, size: 2, sizeEnd: 9, color: accentOf("sunder"), life: 0.4, alpha: 1, alphaEnd: 0 })
  fx.layers.glow.spawn({ frames: fx.f.glint, x, y: 1.2, z, size: 4.5, sizeEnd: 1, rotation: 0.78, color: 0xffffff, life: 0.25 })
  fx.context.rig.punch(2)
}

/** A moon cutting through: a white cut along its line, afterimages of the ring left along it. */
const onMoonCut = (fx: Fx, cut: MomentOf<"moonCut">) => {
  const angle = angleOf(cut.dirX, cut.dirZ)
  const accent = accentOf("orrery")
  fx.layers.flat.spawn({ frames: fx.f.cutline, x: cut.x + cut.dirX * cut.length / 2, y: 0.45, z: cut.z + cut.dirZ * cut.length / 2, size: cut.length * 1.2, sizeEnd: cut.length * 1.35, rotation: angle, life: 3 / ON_TWOS, alpha: 1, alphaEnd: 0.3 })
  for (let ghost = 1; ghost <= 4; ghost++) {
    const along = (ghost / 5) * cut.length
    flashShape(fx, "orbiter", cut.x + cut.dirX * along, cut.z + cut.dirZ * along, 0, 0.9, (1 + ghost * 0.5) / ON_TWOS)
  }
  for (let line = 0; line < 3; line++) {
    const side = spread(fx.rng, 0.4)
    fx.layers.flat.spawn({ frames: fx.f.speedline, x: cut.x - cut.dirZ * side, y: 0.3, z: cut.z + cut.dirX * side, vx: cut.dirX * 12, vz: cut.dirZ * 12, size: 2.2, sizeEnd: 0.8, rotation: angle, color: line === 0 ? 0xffffff : accent, life: 0.25, alphaEnd: 0 })
  }
}

/** What flies off each boss as it is felled, held through the slow motion before the last break. */
const flingParts = (fx: Fx, boss: BossId, x: number, z: number) => {
  const throwShape = (kind: EnemyKind, count: number, speed: number, size: number) => {
    for (let index = 0; index < count; index++) {
      const direction = (index / count) * Math.PI * 2 + spread(fx.rng, 0.3)
      fx.layers.flat.spawn({ frames: fx.f.shapes[kind].flash, x: x + Math.cos(direction), y: 1, z: z + Math.sin(direction), vx: Math.cos(direction) * speed, vy: 5, vz: Math.sin(direction) * speed, size: shapeCell(kind) * size, rotation: direction, spin: spread(fx.rng, 8), gravity: 12, ground: true, drag: 1, life: 1.6, hold: 0.7, alpha: 1, alphaEnd: 0 })
    }
  }
  switch (boss) {
    case "gatekeeper":
      throwShape("trickster", 1, 4, 1.8)
      throwShape("shooter", 2, 6, 1.8)
      return
    case "orrery":
      for (let ring = 0; ring < 2; ring++) {
        fx.layers.flat.spawn({ frames: fx.f.haloRing, x, y: 0.8, z, size: 4.5, sizeEnd: 9 + ring * 3, rotation: ring, spin: ring === 0 ? 3 : -3, color: accentOf("orrery"), life: 1.2, alpha: 1, alphaEnd: 0, fps: 0 })
      }
      throwShape("orbiter", 3, 3, 1)
      return
    case "sunder":
      throwShape("lancer", 6, 7, 1.4)
      return
  }
}

/** The defeat's first drawing: frames cut to ink, the boss held white under crossing cuts, its parts flung, cinema bars. */
const onFelled = (fx: Fx, felled: MomentOf<"bossFelled">) => {
  const { x, z } = drawnAt(fx, felled.id, felled)
  const accent = accentOf(felled.boss)
  const cell = shapeCell(felled.boss)
  const blow = angleOf(felled.dirX, felled.dirZ)
  fx.impacts.frame(["ink", "stark", "ink", "stark"], { fps: 15, force: true })
  flashShape(fx, felled.boss, x, z, blow, 1.25, felled.duration * 0.5)
  for (const cut of [blow + Math.PI / 2, blow + Math.PI / 2 + 0.9]) {
    fx.layers.flat.spawn({ frames: fx.f.cutline, x, y: 1.4, z, size: cell * 3.4, sizeEnd: cell * 4, rotation: cut, life: felled.duration * 0.6, alpha: 1, alphaEnd: 0.6 })
  }
  fx.layers.flat.spawn({ frames: fx.f.radial, x, y: 0.15, z, size: cell * 3.2, sizeEnd: cell * 4, rotation: fx.rng() * 6, life: 4 / ON_TWOS, alpha: 0.85, alphaEnd: 0 })
  fx.layers.flatGlow.spawn({ frames: fx.f.shock, x, y: 0.1, z, size: cell, sizeEnd: cell * 8, color: accent, life: felled.duration * 0.6, alpha: 1, alphaEnd: 0 })
  for (let index = 0; index < 14; index++) {
    const direction = fx.rng() * Math.PI * 2
    const reach = cell * (0.8 + fx.rng() * 2)
    fx.layers.floor.spawn({ frames: pick(fx.rng, fx.f.splats, fx.f.inkDrop), x: x + Math.cos(direction) * reach, y: 0.024, z: z + Math.sin(direction) * reach, size: 1.2 + fx.rng() * 1.8, rotation: direction, life: 14, hold: 0.85, alpha: 0.9, alphaEnd: 0, fps: 0 })
  }
  flingParts(fx, felled.boss, x, z)
  for (const fallen of felled.fallen) shatter(fx, fallen.kind, fallen.x, fallen.z, fallen.x - x, fallen.z - z)
  focus(fx, x, z, felled.duration, 0.85)
  fx.cues.play({
    clock: "real",
    life: felled.duration + 0.4,
    fps: 12,
    draw: (drawing, age) => {
      const settle = Math.min(1, age / 0.2) * (1 - Math.max(0, (age - felled.duration) / 0.4))
      fx.screen.setBars(settle)
      fx.screen.setStrobe("paper", drawing === 0 ? 0.7 : 0)
      fx.context.rig.dutch(drawing % 4 < 2 ? 4 : -4)
    },
    end: () => {
      fx.screen.setBars(0)
      fx.context.rig.dutch(0)
    }
  })
  fx.context.rig.shake(0.7, { x, z, shape: "explosion", duration: felled.duration })
  fx.context.rig.punch(6)
}

/** The defeat's last drawing: the shape breaks in pieces of its own, a burst over it; Sunder's wedges drop into the void. */
const onDefeated = (fx: Fx, defeated: MomentOf<"bossDefeated">) => {
  const { x, z } = defeated
  const accent = accentOf(defeated.boss)
  shatter(fx, defeated.boss, x, z, 0, 1, { big: true })
  fx.layers.face.spawn({ frames: fx.f.burst, x, y: 1, z, size: 9, sizeEnd: 11, rotation: fx.rng() * 6, life: 4 / ON_TWOS, alpha: 1, alphaEnd: 0.4 })
  fx.layers.flat.spawn({ frames: fx.f.dryRing, x, y: 0.08, z, size: 4, sizeEnd: 18, life: 0.7, alpha: 0.8, alphaEnd: 0 })
  if (defeated.boss === "sunder") {
    for (let wedge = 0; wedge < 6; wedge++) {
      const direction = (wedge / 6) * Math.PI * 2
      const frame = fx.f.shapes.sunder.fragments[wedge % 4] ?? fx.f.shard
      fx.layers.flat.spawn({ frames: frame, x: x + Math.cos(direction) * 1.2, y: 0.5, z: z + Math.sin(direction) * 1.2, vx: Math.cos(direction) * 3, vy: -1, vz: Math.sin(direction) * 3, size: shapeCell("sunder") * 0.9, sizeEnd: shapeCell("sunder") * 0.2, rotation: direction, spin: spread(fx.rng, 5), gravity: 9, life: 1.6, alpha: 1, alphaEnd: 0 })
    }
    fx.cues.play({ clock: "real", life: 1.1, fps: 12, draw: () => {}, end: () => fx.layers.glow.spawn({ frames: fx.f.halo, x, y: -9, z, size: 12, sizeEnd: 4, color: accent, life: 0.5, alpha: 1, fps: 0, clock: "real" }) })
  }
  fx.impacts.frame(["stark", "ink"], { fps: 18, force: true })
  fx.context.rig.shake(0.5, { x, z, shape: "explosion", duration: 0.5 })
  fx.context.rig.punch(5)
}

export const installBossEffects = (fx: Fx) => {
  const { moments } = fx.context
  const offs = [
    moments.on("bossIntro", (intro) => onIntro(fx, intro)),
    moments.on("bossPattern", (pattern) => onPattern(fx, pattern)),
    moments.on("bossPhase", (phase) => onPhase(fx, phase)),
    moments.on("bossBroken", (broken) => onBroken(fx, broken)),
    moments.on("bossRecovered", (recovered) => onRecovered(fx, recovered)),
    moments.on("bossStunned", (stunned) => onStunned(fx, stunned)),
    moments.on("bossSplit", (split) => onSplit(fx, split)),
    moments.on("bossRejoined", (rejoined) => onRejoined(fx, rejoined)),
    moments.on("moonCut", (cut) => onMoonCut(fx, cut)),
    moments.on("bossFelled", (felled) => onFelled(fx, felled)),
    moments.on("bossDefeated", (defeated) => onDefeated(fx, defeated))
  ]
  return () => {
    for (const off of offs) off()
  }
}
