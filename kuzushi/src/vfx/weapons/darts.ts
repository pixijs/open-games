import type { Container3D } from "@pixi/3d"

import type { FrameTime } from "../../host/types.ts"
import type { MomentOf } from "../../sim/index.ts"
import { Tuning } from "../../sim/index.ts"
import { ON_TWOS } from "../cues.ts"
import { angleOf, drawnAt, spray, spread } from "../fx.ts"
import type { Fx } from "../fx.ts"
import type { WeaponKit } from "./kit.ts"
import { GroundStrip } from "./strip.ts"

const { DARTS, MOVE } = Tuning

/** How high darts fly, and the gap between the dots of a dart's trail. */
const FLIGHT = { height: 0.5, dot: 0.3, line: 0.75 } as const

/** The charge's aim line: its length while charging (grown on twos) and at full, and its width. */
const AIM = { from: 1.4, to: 8.5, width: 0.42, fullWidth: 0.56 } as const

const PERFECT_SECONDS = DARTS.perfect.steps / 60

interface Trail {
  lastX: number
  lastZ: number
  dots: number
  lines: number
}

/**
 * Darts on screen. Each shot flashes a muzzle star at the tip and leaves a dotted trail; a wall chips it into white
 * shards. Holding on grows a thin white aim line from the tip with chevrons riding it (look folds the hero toward
 * its dart pose); full, it rings and quivers, brightest through the perfect window. The pierce is a long white streak
 * held for two drawings with speed lines along it, a perfect one ringing on the tip. A dash's reload rings in round
 * the hero.
 */
export const installDarts = (fx: Fx, kit: WeaponKit, parent: Container3D) => {
  const aim = new GroundStrip(kit.aim, parent)
  const free: Array<GroundStrip> = []
  const streaks: Array<GroundStrip> = []
  const trails = new Map<number, Trail>()
  const ours = new Set<number>()
  let fullAt: number | null = null
  let drawing = -1

  const streakBand = (): GroundStrip => {
    const band = free.pop() ?? new GroundStrip(kit.streak, parent)
    streaks.push(band)
    return band
  }

  const shot = (moment: MomentOf<"shot">) => {
    ours.add(moment.id)
    const angle = angleOf(moment.dirX, moment.dirZ)
    const { x, z, pierce } = moment
    fx.layers.flat.spawn({ frames: fx.f.weapon.muzzle, x: x + moment.dirX * 0.2, y: FLIGHT.height, z: z + moment.dirZ * 0.2, size: pierce ? 2.6 : 1.3, sizeEnd: pierce ? 3.2 : 1.6, rotation: angle, life: 2 / ON_TWOS, fps: 0, alpha: 1, alphaEnd: 0.6 })
    fx.layers.glow.spawn({ frames: fx.f.glint, x, y: FLIGHT.height + 0.1, z, size: pierce ? 2.4 : 1.2, sizeEnd: 0.3, rotation: 0.4, life: 0.12, alpha: 1 })
    if (!pierce) {
      fx.context.rig.shake(0.025, { x, z, dirX: -moment.dirX, dirZ: -moment.dirZ, shape: "recoil", duration: 0.1 })
      return
    }
    const reach = MOVE.pierce.reach
    const band = streakBand()
    const widths = [0.7, 0.7, 0.5, 0.3] as const
    const alphas = [1, 1, 0.65, 0.3] as const
    fx.cues.play({
      clock: "game",
      life: widths.length / ON_TWOS,
      fps: ON_TWOS,
      draw: (held) => band.place(x, FLIGHT.height - 0.05, z, angle, reach, widths[held] ?? 0.3, alphas[held] ?? 0.3),
      end: () => {
        band.hide()
        const at = streaks.indexOf(band)
        if (at < 0) return
        streaks.splice(at, 1)
        free.push(band)
      }
    })
    for (let index = 0; index < 10; index++) {
      const along = 1 + fx.rng() * (reach - 2)
      const side = spread(fx.rng, 0.5)
      fx.layers.flat.spawn({
        frames: fx.f.speedline,
        x: x + moment.dirX * along - moment.dirZ * side,
        y: FLIGHT.height + spread(fx.rng, 0.15),
        z: z + moment.dirZ * along + moment.dirX * side,
        vx: moment.dirX * 22,
        vz: moment.dirZ * 22,
        rotation: angle,
        size: 2 + fx.rng() * 1.6,
        sizeEnd: 1,
        life: 0.22,
        hold: 0.4
      })
    }
    fx.layers.flat.spawn({ frames: fx.f.dryRing, x, y: 0.06, z, size: 1, sizeEnd: 2.6, life: 3 / ON_TWOS, alpha: 0.6, alphaEnd: 0 })
    if (moment.perfect) {
      fx.layers.flat.spawn({ frames: fx.f.ringSmall, x, y: FLIGHT.height, z, size: 0.6, sizeEnd: 3.4, life: 3 / ON_TWOS, alpha: 1, alphaEnd: 0 })
      fx.layers.glow.spawn({ frames: fx.f.haloRing, x, y: FLIGHT.height, z, size: 1, sizeEnd: 4, life: 0.25, alpha: 1, fps: 0 })
      fx.impacts.pulse("ink", 0.4)
    }
    fx.context.rig.shake(moment.perfect ? 0.16 : 0.12, { x, z, dirX: -moment.dirX, dirZ: -moment.dirZ, shape: "recoil", duration: 0.22 })
    fx.context.rig.punch(moment.perfect ? 2.6 : 1.8)
  }

  const charged = (moment: MomentOf<"charged">) => {
    const x = moment.x + Math.cos(moment.facing) * DARTS.muzzle
    const z = moment.z + Math.sin(moment.facing) * DARTS.muzzle
    fx.layers.glow.spawn({ frames: fx.f.haloRing, x, y: FLIGHT.height, z, size: 0.6, sizeEnd: 2.4, life: 0.2, alpha: 1, fps: 0 })
    fx.layers.glow.spawn({ frames: fx.f.glint, x, y: FLIGHT.height + 0.1, z, size: 1.8, sizeEnd: 0.4, rotation: 0.78, life: 0.16, alpha: 1 })
    fx.context.rig.punch(0.8)
  }

  const reloaded = (moment: MomentOf<"reloaded">) => {
    const player = fx.context.game.view().player
    if (player === null) return
    const { x, z } = drawnAt(fx, player.id, player)
    if (!moment.dash) {
      const back = player.facing + Math.PI
      fx.layers.glow.spawn({ frames: fx.f.glint, x: x + Math.cos(back) * 0.4, y: 0.55, z: z + Math.sin(back) * 0.4, size: 0.8, sizeEnd: 0.2, rotation: 0.3, life: 0.12, alpha: 0.9 })
      return
    }
    fx.layers.flat.spawn({ frames: fx.f.ringSmall, x, y: 0.4, z, size: 2.6, sizeEnd: 0.9, life: 3 / ON_TWOS, alpha: 0.9, alphaEnd: 0.2 })
    for (let index = 0; index < moment.size; index++) {
      const direction = (index / moment.size) * Math.PI * 2
      fx.layers.flat.spawn({ frames: fx.f.dotSquare, x: x + Math.cos(direction) * 1.3, y: 0.45, z: z + Math.sin(direction) * 1.3, vx: -Math.cos(direction) * 4, vz: -Math.sin(direction) * 4, rotation: direction, size: 0.2, sizeEnd: 0.1, life: 0.22, alpha: 1, alphaEnd: 0.3 })
    }
  }

  const gone = (moment: MomentOf<"projectileGone">) => {
    if (!ours.delete(moment.id)) return
    trails.delete(moment.id)
    if (moment.reason === "wall") {
      spray(fx, { count: 6, x: moment.x, y: FLIGHT.height, z: moment.z, angle: 0, cone: Math.PI, speed: [4, 9], size: [0.3, 0.6], frame: () => fx.f.shard, life: 0.24 })
      fx.layers.flat.spawn({ frames: fx.f.weapon.muzzle, x: moment.x, y: FLIGHT.height, z: moment.z, size: 0.9, rotation: fx.rng() * 6, life: 2 / ON_TWOS, fps: 0, alpha: 0.9, alphaEnd: 0.2 })
    } else if (moment.reason === "expired") {
      fx.layers.flat.spawn({ frames: fx.f.ringSmall, x: moment.x, y: FLIGHT.height, z: moment.z, size: 0.3, sizeEnd: 0.8, life: 2 / ON_TWOS, alpha: 0.6, alphaEnd: 0 })
    }
  }

  const trail = (frame: FrameTime) => {
    for (const dart of fx.context.game.view().darts) {
      const { x, z } = drawnAt(fx, dart.id, dart)
      const entry = trails.get(dart.id) ?? { lastX: x, lastZ: z, dots: 0, lines: 0 }
      trails.set(dart.id, entry)
      if (frame.gameDt === 0) continue
      const pierce = dart.move === "pierce"
      const step = Math.hypot(x - entry.lastX, z - entry.lastZ)
      entry.dots += step
      entry.lines += step
      const angle = angleOf(dart.dirX, dart.dirZ)
      while (entry.dots >= FLIGHT.dot) {
        entry.dots -= FLIGHT.dot
        const back = entry.dots
        fx.layers.flat.spawn({ frames: fx.f.dotSquare, x: x - dart.dirX * back, y: FLIGHT.height - 0.02, z: z - dart.dirZ * back, size: pierce ? 0.24 : 0.19, sizeEnd: 0.06, rotation: angle, life: pierce ? 0.45 : 0.36, alpha: 1, alphaEnd: 0.15 })
      }
      if (pierce && entry.lines >= FLIGHT.line) {
        entry.lines = 0
        fx.layers.flat.spawn({ frames: fx.f.speedline, x: x - dart.dirX * 1.2, y: FLIGHT.height, z: z - dart.dirZ * 1.2, vx: dart.dirX * 6, vz: dart.dirZ * 6, rotation: angle, size: 2.6, sizeEnd: 1.4, life: 0.2, hold: 0.3 })
      }
      entry.lastX = x
      entry.lastZ = z
    }
  }

  /** The aim line while the darts charge, grown and flickered on twos. */
  const charge = (frame: FrameTime, fresh: boolean) => {
    const view = fx.context.game.view()
    const player = view.player
    const amount = view.weapon.charge
    if (player === null || player.state !== "Charge" || amount === null) {
      aim.hide()
      fullAt = null
      return
    }
    if (amount >= 1 && fullAt === null) fullAt = frame.gameElapsed
    if (!fresh) return
    const perfect = fullAt !== null && frame.gameElapsed - fullAt < PERFECT_SECONDS
    const at = drawnAt(fx, player.id, player)
    const angle = player.facing
    const tipX = at.x + Math.cos(angle) * (DARTS.muzzle + 0.2)
    const tipZ = at.z + Math.sin(angle) * (DARTS.muzzle + 0.2)
    const stepped = Math.ceil(amount * 6) / 6
    const length = AIM.from + (AIM.to - AIM.from) * stepped
    const full = amount >= 1
    const flicker = drawing % 2 === 0
    aim.place(tipX, FLIGHT.height - 0.1, tipZ, angle, length, full ? AIM.fullWidth * (perfect ? 1.35 : 1) : AIM.width, full ? (flicker || perfect ? 1 : 0.7) : 0.45 + 0.4 * amount)
    for (let index = 0; index < 3; index++) {
      const along = ((drawing * 0.6 + index / 3) % 1) * length
      fx.layers.flat.spawn({ frames: fx.f.weapon.chevron, x: tipX + Math.cos(angle) * along, y: FLIGHT.height - 0.05, z: tipZ + Math.sin(angle) * along, size: full ? 0.6 : 0.45, rotation: angle, life: 1 / ON_TWOS + 0.005, fps: 0, alpha: full ? 1 : 0.7, alphaEnd: full ? 1 : 0.7 })
    }
    if (perfect) fx.layers.glow.spawn({ frames: fx.f.haloRing, x: tipX, y: FLIGHT.height, z: tipZ, size: flicker ? 1.3 : 1.05, color: 0xffffff, life: 1 / ON_TWOS + 0.005, fps: 0, alpha: 0.8, alphaEnd: 0.8 })
  }

  const offs = [
    fx.context.moments.on("shot", shot),
    fx.context.moments.on("charged", charged),
    fx.context.moments.on("reloaded", reloaded),
    fx.context.moments.on("projectileGone", gone)
  ]

  return {
    update: (frame: FrameTime) => {
      const now = Math.floor(frame.gameElapsed * ON_TWOS)
      const fresh = now !== drawing
      drawing = now
      trail(frame)
      charge(frame, fresh)
    },
    clear: () => {
      aim.hide()
      for (const band of streaks.splice(0)) {
        band.hide()
        free.push(band)
      }
      trails.clear()
      ours.clear()
      fullAt = null
    },
    dispose: () => {
      for (const off of offs) off()
      aim.destroy()
      for (const band of [...free, ...streaks]) band.destroy()
    }
  }
}
