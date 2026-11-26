import { FlatMaterial, Mesh3D, PlaneGeometry } from "@pixi/3d"
import type { Container3D } from "@pixi/3d"

import { PALETTE, rgbOf } from "../../art/palette.ts"
import type { FrameTime } from "../../host/types.ts"
import type { MarkView, MomentOf } from "../../sim/index.ts"
import { Arc } from "../arcs.ts"
import { ON_TWOS } from "../cues.ts"
import { angleOf, drawnAt, pick, spray, spread } from "../fx.ts"
import type { Fx } from "../fx.ts"
import { paletteNow } from "./kit.ts"
import type { WeaponKit } from "./kit.ts"

const quad = new PlaneGeometry({ width: 1, height: 1, flipV: true })

/** A flat 印 over the ground: the seal's centre while it waits, and the stamp it leaves. */
interface Stamp {
  readonly mesh: Mesh3D
  readonly material: FlatMaterial
}

interface Waiting {
  readonly arc: Arc
  readonly glyph: Stamp | null
  readonly variant: number
}

/** How many strokes a ring is inked in, one more each drawing or so. */
const STROKES = 10
/** How long the stamp a burst leaves stays on the floor, in seconds of game time. */
const STAMP_LIFE = 4
/** After this share of its delay a waiting ring flickers brighter: it is about to burst. */
const DUE = 0.75

/**
 * Sigils on screen. A cast flicks the hero's tip; where it lands the brush touches down and a white ring inks round
 * the mark stroke by stroke through the delay, a seal drawn at its centre (印 for the seal), flickering once it is
 * due. The burst is an ink starburst under a white brush ring rimmed in the zone's accent, splatter, and an ink stamp
 * left on the floor that fades; the ring itself flares and dries out in the accent. The seal is larger and stamps 印.
 */
export const installSigils = (fx: Fx, kit: WeaponKit, parent: Container3D) => {
  const arcs: Array<Arc> = []
  const allArcs: Array<Arc> = []
  const stamps: Array<Stamp> = []
  const allStamps: Array<Stamp> = []
  const waiting = new Map<number, Waiting>()
  let drawing = -1
  let seeds = 0

  const takeArc = (): Arc => {
    const fresh = () => {
      const arc = new Arc(kit.ring, kit.ringStrip, (seeds += 1))
      allArcs.push(arc)
      return arc
    }
    const arc = arcs.pop() ?? fresh()
    parent.addChild(arc.node)
    return arc
  }
  const giveArc = (arc: Arc) => {
    arc.hide()
    arcs.push(arc)
  }
  const takeStamp = (color: number): Stamp => {
    const fresh = (): Stamp => {
      const material = new FlatMaterial({ baseColor: color, baseColorTexture: kit.seal, alphaMode: "blend", doubleSided: true })
      const stamp = { mesh: new Mesh3D({ geometry: quad, material, rotation: { x: -Math.PI / 2, y: 0, z: 0 }, castShadow: false, receiveShadow: false }), material }
      allStamps.push(stamp)
      return stamp
    }
    const stamp = stamps.pop() ?? fresh()
    stamp.material.baseColor = color
    stamp.mesh.visible = true
    parent.addChild(stamp.mesh)
    return stamp
  }
  const giveStamp = (stamp: Stamp) => {
    stamp.mesh.visible = false
    stamps.push(stamp)
  }

  const placeStamp = (stamp: Stamp, x: number, y: number, z: number, size: number, turn: number, alpha: number) => {
    stamp.mesh.position.set(x, y, z)
    stamp.mesh.rotation.set(-Math.PI / 2, 0, turn)
    stamp.mesh.scale.set(size, size, 1)
    stamp.material.alpha = alpha
  }

  /** The ring dries out in the accent and is gone: what every mark does as it leaves, burst or swept away. */
  const dry = (entry: Waiting) => {
    const edge = rgbOf(paletteNow(fx).danger)
    if (entry.glyph !== null) giveStamp(entry.glyph)
    const poses = [[0, 1, 0.2, 2.6], [0.1, 1, 0.5, 1.8], [0.3, 1, 0.8, 1.2]] as const
    fx.cues.play({
      clock: "game",
      life: poses.length / ON_TWOS,
      fps: ON_TWOS,
      draw: (index) => {
        const pose = poses[index]
        if (pose !== undefined) entry.arc.pose(pose[0], pose[1], pose[2], pose[3], entry.variant + index, 1, edge)
      },
      end: () => giveArc(entry.arc)
    })
  }

  const show = (mark: MarkView) => {
    const seal = mark.move === "seal"
    const entry = waiting.get(mark.id) ?? (() => {
      const arc = takeArc()
      arc.place(mark.x, 0.05, mark.z, fx.rng() * Math.PI * 2, mark.radius, fx.rng() < 0.5, 0, 0)
      const made: Waiting = { arc, glyph: seal ? takeStamp(0xffffff) : null, variant: Math.floor(fx.rng() * 2) }
      waiting.set(mark.id, made)
      return made
    })()
    const head = Math.min(1, Math.ceil(mark.progress * STROKES) / STROKES)
    const due = mark.progress >= DUE
    const flare = due && drawing % 2 === 0
    entry.arc.pose(0, head, 0, flare ? 2.3 : 1.5, entry.variant + (drawing % 2), 1)
    const inked = Math.min(1, Math.ceil(mark.progress * 4) / 3)
    if (entry.glyph !== null) placeStamp(entry.glyph, mark.x, 0.07, mark.z, mark.radius * 0.95, 0, inked * (flare ? 1 : 0.85))
    else fx.layers.floor.spawn({ frames: fx.f.weapon.sealSquare, x: mark.x, y: 0.06, z: mark.z, size: mark.radius * 0.8, rotation: -Math.PI / 2, life: 1 / ON_TWOS + 0.005, fps: 0, alpha: inked * (flare ? 1 : 0.8), alphaEnd: inked * (flare ? 1 : 0.8) })
    if (due) fx.layers.flatGlow.spawn({ frames: fx.f.halo, x: mark.x, y: 0.06, z: mark.z, size: mark.radius * 2.2, color: 0xffffff, life: 1 / ON_TWOS + 0.005, fps: 0, alpha: flare ? 0.32 : 0.18, alphaEnd: flare ? 0.32 : 0.18 })
  }

  const cast = (marked: MomentOf<"marked">) => {
    const player = fx.context.game.view().player
    if (player !== null) {
      const at = drawnAt(fx, player.id, player)
      const x = at.x + Math.cos(player.facing) * 0.6
      const z = at.z + Math.sin(player.facing) * 0.6
      fx.layers.glow.spawn({ frames: fx.f.glint, x, y: 0.6, z, size: marked.move === "seal" ? 2 : 1.4, sizeEnd: 0.3, rotation: 0.6, life: 0.14, alpha: 1 })
      const toward = angleOf(marked.x - x, marked.z - z)
      fx.layers.flat.spawn({ frames: fx.f.speedline, x: x + Math.cos(toward) * 0.8, y: 0.5, z: z + Math.sin(toward) * 0.8, vx: Math.cos(toward) * 10, vz: Math.sin(toward) * 10, rotation: toward, size: 1.6, sizeEnd: 0.6, life: 0.16, hold: 0.4 })
    }
    fx.layers.floor.spawn({ frames: fx.f.inkDrop, x: marked.x, y: 0.03, z: marked.z, size: marked.radius * 0.35, rotation: fx.rng() * 6, life: 2 / ON_TWOS, fps: 0, alpha: 0.9, alphaEnd: 0.4 })
    fx.layers.flat.spawn({ frames: fx.f.dryRing, x: marked.x, y: 0.06, z: marked.z, size: marked.radius * 0.6, sizeEnd: marked.radius * 1.4, life: 3 / ON_TWOS, alpha: 0.55, alphaEnd: 0 })
  }

  const burst = (moment: MomentOf<"burst">) => {
    const { x, z, radius } = moment
    const seal = moment.move === "seal"
    const palette = paletteNow(fx)
    const diameter = radius * 2
    fx.layers.flat.spawn({ frames: fx.f.burst[0] ?? 0, x, y: 0.15, z, size: diameter * 1.15, sizeEnd: diameter * 1.3, rotation: fx.rng() * Math.PI * 2, color: PALETTE.ink, life: 2 / ON_TWOS, fps: 0, alpha: 1, alphaEnd: 0.8 })
    fx.layers.flatGlow.spawn({ frames: fx.f.weapon.brushRing, x, y: 0.12, z, size: diameter * 1.1, sizeEnd: diameter * 1.45, rotation: fx.rng() * 6, color: palette.danger, life: 0.3, alpha: 1, alphaEnd: 0 })
    fx.layers.flat.spawn({ frames: fx.f.weapon.brushRing, x, y: 0.16, z, size: diameter * 0.95, sizeEnd: diameter * 1.3, rotation: fx.rng() * 6, life: 3 / ON_TWOS, alpha: 1, alphaEnd: 0.2 })
    fx.layers.glow.spawn({ frames: fx.f.halo, x, y: 0.35, z, size: radius * 1.1, sizeEnd: radius * 0.3, color: 0xffffff, life: 0.1, alpha: 0.6, fps: 0 })
    for (let index = 0; index < (seal ? 5 : 3); index++) {
      const direction = fx.rng() * Math.PI * 2
      const out = radius * (0.5 + fx.rng() * 0.5)
      fx.layers.floor.spawn({ frames: pick(fx.rng, fx.f.splats, 0), x: x + Math.cos(direction) * out, y: 0.027, z: z + Math.sin(direction) * out, size: 1 + fx.rng() * 0.8, rotation: direction, life: 6, hold: 0.7, alpha: 0.85, alphaEnd: 0, fps: 0 })
    }
    spray(fx, { count: seal ? 10 : 6, x, y: 0.3, z, angle: 0, cone: Math.PI, speed: [6, 12], size: [0.4, 0.8], frame: (index) => (index % 2 === 0 ? fx.f.spark : fx.f.shard), life: 0.26 })
    if (seal) {
      for (let index = 0; index < 10; index++) {
        const direction = (index / 10) * Math.PI * 2 + spread(fx.rng, 0.15)
        fx.layers.flat.spawn({ frames: fx.f.speedline, x: x + Math.cos(direction) * radius * 0.6, y: 0.3, z: z + Math.sin(direction) * radius * 0.6, vx: Math.cos(direction) * 14, vz: Math.sin(direction) * 14, rotation: direction, size: 2, sizeEnd: 1, life: 0.22, hold: 0.35 })
      }
      const stamp = takeStamp(PALETTE.ink)
      const turn = spread(fx.rng, 0.12)
      fx.cues.play({
        clock: "game",
        life: STAMP_LIFE,
        fps: ON_TWOS,
        draw: (index, age) => placeStamp(stamp, x, 0.03, z, radius * 1.5 * (index === 0 ? 1.12 : 1), turn, 0.9 * Math.min(1, (STAMP_LIFE - age) / 1.5)),
        end: () => giveStamp(stamp)
      })
    } else {
      fx.layers.floor.spawn({ frames: fx.f.weapon.sealSquare, x, y: 0.028, z, size: radius * 1.25, rotation: -Math.PI / 2 + spread(fx.rng, 0.12), color: PALETTE.ink, life: STAMP_LIFE, hold: 0.6, alpha: 0.85, alphaEnd: 0, fps: 0 })
    }
    fx.impacts.pulse("ink", seal ? 0.55 : 0.32)
    fx.context.rig.punch(seal ? 2.6 : 1.1)
    fx.context.rig.shake(seal ? 0.24 : 0.11, { x, z, shape: "explosion", duration: seal ? 0.34 : 0.22 })
  }

  const offs = [
    fx.context.moments.on("marked", (marked) => {
      if (marked.weapon === "sigil") cast(marked)
    }),
    fx.context.moments.on("burst", (moment) => {
      if (moment.weapon === "sigil") burst(moment)
    })
  ]

  const release = (id: number) => {
    const entry = waiting.get(id)
    if (entry === undefined) return
    waiting.delete(id)
    dry(entry)
  }

  return {
    update: (frame: FrameTime) => {
      const now = Math.floor(frame.gameElapsed * ON_TWOS)
      const fresh = now !== drawing
      drawing = now
      const all = fx.context.game.view().weapon.marks
      if (all.length === 0 && waiting.size === 0) return
      const marks = all.filter((mark) => mark.move === "sigil" || mark.move === "seal")
      const seen = new Set(marks.map((mark) => mark.id))
      for (const id of waiting.keys()) if (!seen.has(id)) release(id)
      if (fresh || marks.some((mark) => !waiting.has(mark.id))) for (const mark of marks) show(mark)
    },
    clear: () => {
      for (const entry of waiting.values()) {
        giveArc(entry.arc)
        if (entry.glyph !== null) giveStamp(entry.glyph)
      }
      waiting.clear()
    },
    dispose: () => {
      for (const off of offs) off()
      for (const arc of allArcs) arc.destroy()
      for (const stamp of allStamps) {
        stamp.mesh.destroy()
        stamp.material.destroy()
      }
    }
  }
}
