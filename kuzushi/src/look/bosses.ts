import { Container3D, Mesh3D } from "@pixi/3d"
import type { BaseMaterial3D, Geometry3D } from "@pixi/3d"
import { spring } from "math/time"

import { setXray, XRAY_BAND } from "../art/depth.ts"
import { paletteOfKind } from "../art/palette.ts"
import type { ActorVisual, FrameTime } from "../host/types.ts"
import { step, Tuning } from "../sim/index.ts"
import type { BossId, BossView, EnemyKind, EnemyView } from "../sim/index.ts"
import { BEHIND, behindProp, body, enemyPose, groundQuad, makePose, useKit } from "./actors.ts"
import { AIR, leapHeight, through } from "./foes.ts"
import { extrude, grow, ring } from "./geometry.ts"
import type { Point } from "./geometry.ts"
import { actorMaterial, setActorFx } from "./shaders/actor.ts"
import type { ActorLook } from "./shaders/actor.ts"
import { lampMaterial, spriteMaterial } from "./shaders/sprite.ts"
import { SHAPES } from "./shapes.ts"
import { onTwos } from "./twos.ts"

/**
 * The three bosses, each a large composition of its zone's shapes with the same ink rims, accent glow and white
 * flashes as every enemy, its parts moving on twos: the Gatekeeper's diamond crest and triangle shoulders lifting into
 * a slam; the Orrery's eye in two tilted rings, its three ring moons orbiting, hunting and cutting, its hands sweeping;
 * Sunder's hexagon crowned by six needles that bristle and fire, a white seam across it, split into halves. Broken, a
 * boss sags with its glow at a third; shifting, it flares and shakes; felled, it burns white and shudders as it breaks.
 */

interface Frame {
  readonly enemy: EnemyView
  readonly view: BossView | null
  readonly frame: FrameTime
  /** 0 to 1 through the windup, else 0. */
  readonly windup: number
  readonly behind: boolean
  /** The body's glow this frame, and its hit flash. */
  readonly glow: number
  readonly flash: number
}

interface Rig {
  update(at: Frame): void
  destroy(): void
}

/** A part built from another kind's body (a crest from the trickster's diamond, a moon from the orbiter's ring), lit in its own material. */
interface Part {
  readonly node: Container3D
  readonly pose: Container3D
  readonly spin: Container3D
  readonly rim: Mesh3D
  readonly solid: Mesh3D
  readonly material: BaseMaterial3D
  readonly look: ActorLook
}

const partOf = (kind: EnemyKind, scale: number): Part => {
  const parts = useKit()
  const look = parts.looks[kind]
  const material = actorMaterial(look, [XRAY_BAND])
  const made = body(kind, material, parts.ink)
  const node = new Container3D({ label: `${kind}-part`, scale: { x: scale, y: scale, z: scale } })
  node.addChild(made.pose)
  return { node, ...made, material, look }
}

const lightPart = (part: Part, at: Frame, glow = 1) => {
  const parts = useKit()
  setXray(part.material, at.behind)
  part.rim.material = at.behind ? parts.xrayInk : parts.ink
  setActorFx(part.material, part.look, { glow: part.look.glow * glow * (at.glow / Math.max(0.01, parts.looks[at.enemy.kind].glow)), flash: at.flash, body: at.behind ? BEHIND : 1 })
}

const jitter = (at: Frame, amount: number) => (onTwos(at.frame) ? amount : -amount)

/** A pattern's windup belongs to the pattern it opens: the view's pattern while this body is the boss itself. */
const patternOf = (at: Frame) => at.view !== null && at.view.id === at.enemy.id ? at.view.pattern : null

const gatekeeper = (core: Container3D): Rig => {
  const radius = Tuning.ENEMY.gatekeeper.radius
  const crest = partOf("trickster", 1.45)
  const shoulders = [1, -1].map((side) => ({ side, part: partOf("shooter", 1.55) }))
  crest.node.position.set(0, SHAPES.gatekeeper.height - 0.1, 0)
  core.addChild(crest.node)
  for (const { side, part } of shoulders) {
    part.node.position.set(0, 0.15, side * radius * 0.92)
    part.node.rotation.y = -side * Math.PI / 2
    core.addChild(part.node)
  }
  const lifted = spring.create(0)
  const spread = spring.create(0)
  return {
    update: (at) => {
      const { enemy } = at
      const pattern = patternOf(at)
      const state = at.view?.state ?? "fighting"
      const slamming = enemy.state === "Windup" && pattern === "slam"
      const charging = enemy.state === "Windup" && pattern === "charge"
      const lift = slamming ? at.windup : enemy.state === "Quake" ? -0.15 : state === "shifting" ? 1 : enemy.state === "Stagger" ? -0.3 : 0
      const flare = slamming ? at.windup * 0.6 : state === "shifting" ? 1 : enemy.state === "Burst" ? 0.4 : charging ? -0.3 * at.windup : enemy.state === "Lunge" ? -0.4 : enemy.state === "Stagger" ? -0.35 : 0
      spring.update(lifted, lift, enemy.state === "Quake" ? 0.02 : 0.08, 0.5, at.frame.gameDt)
      spring.update(spread, flare, 0.08, 0.5, at.frame.gameDt)
      const shake = state === "shifting" || state === "defeated" ? jitter(at, 0.05) : 0
      crest.node.position.set(shake, SHAPES.gatekeeper.height - 0.1 + lifted.value * 0.95, 0)
      crest.node.rotation.z = enemy.state === "Stagger" ? 0.35 : charging ? -0.25 * at.windup : 0
      crest.spin.rotation.y = enemy.state === "Move" ? (Math.floor(at.frame.gameElapsed * 3) % 2 === 0 ? 0.05 : -0.05) : 0
      lightPart(crest, at, slamming ? 1.3 : 1)
      for (const { side, part } of shoulders) {
        part.node.position.set(-spread.value * 0.35 * (enemy.state === "Burst" && onTwos(at.frame) ? 1.6 : 1), 0.15 + lifted.value * 0.55, side * (radius * 0.92 + Math.max(0, spread.value) * 0.45))
        part.node.rotation.x = side * spread.value * 0.5
        lightPart(part, at)
      }
    },
    destroy: () => {
      crest.material.destroy()
      for (const { part } of shoulders) part.material.destroy()
    }
  }
}

/** One of the Orrery's hands: a tapered blade along +x as long as its sweep reaches. */
const handOutline = (reach: number, width: number): ReadonlyArray<Point> => [[reach, 0], [reach * 0.22, width], [0.2, width * 0.5], [0.2, -width * 0.5], [reach * 0.22, -width]]

/** The Orrery's two rings: their radii, and how each tilts and turns round its eye. */
const ORRERY_RINGS = [
  { inner: 2.0, outer: 2.2, tilt: { x: 0.55, z: 0.25, rate: 0.7 } },
  { inner: 2.5, outer: 2.68, tilt: { x: -0.7, z: -0.15, rate: -0.45 } }
] as const

interface OrreryParts {
  readonly rings: ReadonlyArray<{ readonly solid: Geometry3D; readonly rim: Geometry3D; readonly tilt: { readonly x: number; readonly z: number; readonly rate: number } }>
  readonly hand: Geometry3D
  readonly handRim: Geometry3D
}

let orreryParts: OrreryParts | undefined

const orreryKit = (): OrreryParts => {
  if (orreryParts !== undefined) return orreryParts
  const reach = Tuning.ORRERY.hands.radius
  const outline = handOutline(reach, 0.26)
  orreryParts = {
    rings: ORRERY_RINGS.map(({ inner, outer, tilt }) => ({
      solid: ring(inner, outer, 0.1, 3, 0, Math.PI * 2, 0, 64),
      rim: ring(inner - 0.05, outer + 0.05, 0.05, 3, 0, Math.PI * 2, -0.01, 64),
      tilt
    })),
    hand: extrude(outline, 0.16, reach, 0.04),
    handRim: extrude(grow(outline, 0.05), 0.1, reach, 0.03)
  }
  return orreryParts
}

const orrery = (node: Container3D, core: Container3D): Rig => {
  const parts = useKit()
  const made = orreryKit()
  const accent = paletteOfKind("orrery").danger
  const ringGlow = lampMaterial(accent, 1.6, true)
  const handGlow = lampMaterial(accent, 2, true)
  const rings = made.rings.map((geometry, index) => {
    const tilt = new Container3D({ position: { x: 0, y: 0.75, z: 0 } })
    const turn = new Container3D()
    const rim = new Mesh3D({ geometry: geometry.rim, material: parts.ink, castShadow: false, receiveShadow: false })
    turn.addChild(rim, new Mesh3D({ geometry: geometry.solid, material: ringGlow, castShadow: true, receiveShadow: false }))
    tilt.addChild(turn)
    core.addChild(tilt)
    return { tilt, turn, rim, spec: geometry.tilt, angle: index * 1.3 }
  })
  const moons = Array.from({ length: 3 }, () => {
    const part = partOf("orbiter", 1)
    node.addChild(part.node)
    return { part, spin: 0, last: { x: 0, z: 0 } }
  })
  const hands = [0, 1].map(() => {
    const hand = new Container3D({ label: "orrery-hand", position: { x: 0, y: 0.45, z: 0 } })
    const rim = new Mesh3D({ geometry: made.handRim, material: parts.ink, castShadow: false, receiveShadow: false })
    hand.addChild(rim, new Mesh3D({ geometry: made.hand, material: handGlow, castShadow: true, receiveShadow: false }))
    hand.visible = false
    node.addChild(hand)
    return { hand, rim, reach: spring.create(0) }
  })
  const rate = spring.create(1)
  const flat = spring.create(0)
  return {
    update: (at) => {
      const { enemy, view, frame } = at
      const dt = frame.gameDt
      const volley = view?.pattern === "volley" && (enemy.state === "Windup" || enemy.state === "Volley")
      const broken = view?.state === "broken" || view?.state === "defeated"
      spring.update(rate, volley ? (enemy.state === "Volley" ? 9 : 2 + at.windup * 6) : enemy.state === "Pulse" ? 4 : broken ? 0.1 : 1, 0.1, 0.7, frame.dt)
      spring.update(flat, volley ? 1 : broken ? -0.6 : enemy.state === "Pulse" ? 0.8 : 0, 0.1, 0.6, frame.dt)
      for (const each of rings) {
        each.angle += each.spec.rate * rate.value * dt
        each.turn.rotation.y = each.angle
        each.tilt.rotation.x = each.spec.x * (1 - flat.value)
        each.tilt.rotation.z = each.spec.z * (1 - flat.value) + (view?.state === "shifting" ? jitter(at, 0.06) : 0)
        each.tilt.position.y = 0.75 - (broken ? 0.35 : 0)
        each.rim.material = at.behind ? parts.xrayInk : parts.ink
      }
      ringGlow.data.boost = (volley || view?.shelled === true ? 2.6 : enemy.state === "Pulse" && onTwos(frame) ? 3 : 1.6) * (broken ? 0.4 : 1)

      const nodeX = node.position.x
      const nodeZ = node.position.z
      const shown = view?.moons ?? []
      moons.forEach((moon, index) => {
        const at2 = shown[index]
        moon.part.node.visible = at2 !== undefined
        if (at2 === undefined) return
        const moving = Math.hypot(at2.x - moon.last.x, at2.z - moon.last.z)
        moon.last = { x: at2.x, z: at2.z }
        const hop = at2.phase === "leave" || at2.phase === "back" ? 0.6 : at2.phase === "cut" ? 0.15 : 0
        moon.part.node.position.set(at2.x - nodeX, broken ? 0.02 : 0.35 + hop + (at2.phase === "aim" ? jitter(at, 0.04) : 0), at2.z - nodeZ)
        moon.spin += dt * (at2.phase === "cut" ? 22 : at2.phase === "aim" ? 14 : broken ? 0 : 5)
        moon.part.spin.rotation.y = moon.spin
        const stretch = at2.phase === "cut" && moving > 0.01 ? 1.5 : 1
        moon.part.pose.scale.set(stretch, 1 / stretch, 1)
        lightPart(moon.part, at, at2.phase === "aim" ? (onTwos(frame) ? 2 : 1.3) : at2.phase === "cut" ? 1.6 : 1)
      })

      const arms = view?.arms ?? []
      hands.forEach((each, index) => {
        const arm = arms[index]
        spring.update(each.reach, arm === undefined ? 0 : arm.reach / Tuning.ORRERY.hands.radius, 0.05, 0.7, frame.dt)
        each.hand.visible = each.reach.value > 0.03
        if (arm !== undefined) each.hand.rotation.y = -arm.angle
        each.hand.scale.set(Math.max(0.001, each.reach.value), 1, 0.7 + 0.3 * each.reach.value)
        each.rim.material = at.behind ? parts.xrayInk : parts.ink
      })
      handGlow.data.boost = enemy.state === "Sweep" ? 2.8 : 1.8
    },
    destroy: () => {
      ringGlow.destroy()
      handGlow.destroy()
      for (const moon of moons) moon.part.material.destroy()
    }
  }
}

interface SunderParts {
  readonly halves: Readonly<Record<"left" | "right", { readonly solid: Geometry3D; readonly rim: Geometry3D }>>
  readonly seam: Geometry3D
}

let sunderParts: SunderParts | undefined

/** Half of Sunder's hexagon, cut along its seam's normal: the side of +z (`left` of its facing) or -z. */
const halfHexagon = (radius: number, side: 1 | -1): ReadonlyArray<Point> => {
  const corner = (angle: number): Point => [Math.cos(angle) * radius, Math.sin(angle) * radius * side]
  return [[radius, 0], corner(Math.PI / 3), corner((2 * Math.PI) / 3), [-radius, 0]]
}

const sunderKit = (): SunderParts => {
  if (sunderParts !== undefined) return sunderParts
  const shape = SHAPES.sunder
  const radius = Tuning.ENEMY.sunder.radius * 1.05
  const half = (side: 1 | -1) => {
    const outline = halfHexagon(radius, side)
    return { solid: extrude(outline, shape.height, shape.extent), rim: extrude(grow(outline, shape.rim), shape.height - 0.012, shape.extent + shape.rim, shape.height * 0.5) }
  }
  sunderParts = {
    halves: { left: half(1), right: half(-1) },
    seam: extrude([[radius * 1.02, 0.05], [-radius * 1.02, 0.05], [-radius * 1.02, -0.05], [radius * 1.02, -0.05]], 0.03, radius, 0)
  }
  return sunderParts
}

const sunder = (core: Container3D, solid: Mesh3D, rim: Mesh3D, lift: Container3D): Rig => {
  const made = sunderKit()
  const radius = Tuning.ENEMY.sunder.radius
  const whole = { solid: solid.geometry, rim: rim.geometry }
  const seamGlow = lampMaterial(0xffffff, 1.6)
  const seam = new Mesh3D({ geometry: made.seam, material: seamGlow, castShadow: false, receiveShadow: false, position: { x: 0, y: SHAPES.sunder.height + 0.005, z: 0 }, rotation: { x: 0, y: -Math.PI / 3, z: 0 } })
  core.addChild(seam)
  const needles = Array.from({ length: 6 }, (_, index) => {
    const angle = (index / 6) * Math.PI * 2
    const holder = new Container3D({ rotation: { x: 0, y: -angle, z: 0 } })
    const part = partOf("lancer", 1.25)
    part.node.position.set(radius * 1.02, 0.45, 0)
    part.node.rotation.z = 0.42
    holder.addChild(part.node)
    core.addChild(holder)
    return { holder, part, angle, side: Math.sin(angle) > 0.01 ? 1 : Math.sin(angle) < -0.01 ? -1 : 0 }
  })
  const bristle = spring.create(0)
  let shown: "whole" | "left" | "right" = "whole"
  let regrow = 1
  return {
    update: (at) => {
      const { enemy, view, frame } = at
      const half = view === null || view.twin === null ? "whole" : view.twin === enemy.id ? "right" : "left"
      if (half !== shown) {
        shown = half
        const geometry = half === "whole" ? whole : made.halves[half]
        solid.geometry = geometry.solid
        rim.geometry = geometry.rim
      }
      const pattern = patternOf(at)
      const needling = pattern === "needles"
      if (needling && enemy.state === "Recover" && regrow >= 1) regrow = 0
      regrow = Math.min(1, regrow + frame.gameDt / (Tuning.SUNDER.needles.open.steps / step.hz))
      spring.update(bristle, enemy.state === "Windup" ? at.windup : view?.state === "shifting" ? 1.2 : enemy.state === "Stagger" ? -0.4 : 0, 0.06, 0.5, frame.dt)
      for (const needle of needles) {
        const onSide = half === "whole" || (half === "left" ? needle.side >= 0 : needle.side <= 0)
        const front = Math.cos(needle.angle) > 0.4
        const fired = needling && front && enemy.state === "Recover"
        needle.part.node.visible = onSide && !fired
        const grow = fired ? 0 : needling && front ? Math.max(0.15, regrow) : 1
        const out = radius * 1.02 + Math.max(0, bristle.value) * 0.5
        needle.part.node.position.set(out + (enemy.state === "Windup" && onTwos(frame) ? 0.04 : 0), 0.45 - Math.min(0, bristle.value) * -0.3, 0)
        needle.part.node.rotation.z = 0.42 + bristle.value * 0.35
        needle.part.node.scale.set(1.25 * grow * (1 + Math.max(0, bristle.value) * 0.3), 1.25 * grow, 1.25 * grow)
        lightPart(needle.part, at, enemy.state === "Windup" ? 1.4 : 1)
      }
      seam.visible = half === "whole"
      seamGlow.data.boost = view?.state === "defeated" ? (onTwos(frame) ? 4 : 2.4) : enemy.state === "Windup" ? 1.6 + at.windup * 1.6 : 1.2
      if (enemy.state === "Leap") {
        lift.position.y += leapHeight(through(enemy.timeLeft, AIR.sunder), 4.2)
        core.rotation.y += frame.gameDt * 5
      } else if (enemy.state !== "Glide") {
        core.rotation.y *= Math.max(0, 1 - frame.dt * 10)
      }
    },
    destroy: () => {
      seamGlow.destroy()
      for (const needle of needles) needle.part.material.destroy()
    }
  }
}

/** Glow and pose by boss state: dim when broken, bright and shaking while it shifts. */
const glowOf = (view: BossView | null): number => view === null ? 1 : view.state === "broken" ? 1 / 3 : view.state === "shifting" ? 1.6 : view.state === "defeated" ? 1.8 : 1

export const bossVisual = (kind: BossId): ActorVisual => {
  const parts = useKit()
  const look = parts.looks[kind]
  const shape = SHAPES[kind]
  const accent = paletteOfKind(kind).danger
  const material = actorMaterial(look, [XRAY_BAND])
  const glow = spriteMaterial(parts.textures.glow, accent, 1.1, "add")
  const node = new Container3D({ label: kind })
  const lift = new Container3D()
  const turn = new Container3D()
  const { pose, spin, rim, solid } = body(kind, material, parts.ink)
  turn.addChild(pose)
  lift.addChild(turn)
  const shadow = groundQuad(parts.shadow, shape.extent * 2.9, 0.012)
  const pool = groundQuad(glow, shape.extent * 5, 0.016)
  node.addChild(shadow, pool, lift)
  const rig = kind === "gatekeeper" ? gatekeeper(spin) : kind === "orrery" ? orrery(node, spin) : sunder(spin, solid, rim, lift)
  const squash = makePose()
  const punch = spring.create(1)
  let flash = 0
  let lastHp = Number.NaN
  return {
    node,
    place: (x, z, facing) => {
      node.position.set(x, 0, z)
      turn.rotation.y = -facing
    },
    update: (actor, frame) => {
      if (actor.role !== "enemy") return
      const enemy = actor.enemy
      const boss = parts.boss()
      const view = boss !== null && (boss.id === enemy.id || boss.twin === enemy.id) ? boss : null
      const dt = frame.dt
      if (!Number.isNaN(lastHp) && enemy.hp < lastHp) {
        flash = 1
        punch.value = 1.12
      }
      lastHp = enemy.hp
      flash = Math.max(0, flash - dt * 7)
      spring.update(punch, 1, 0.07, 0.35, dt)
      const [stretch, height] = enemyPose(enemy)
      squash.to(1 + (stretch - 1) * 0.6, 1 + (height - 1) * 0.6, frame.gameDt > 0 ? dt : 0)
      squash.apply(pose, punch.value)
      const windup = enemy.state === "Windup" ? windupOf(enemy, view) : 0
      const defeated = view?.state === "defeated"
      const sinking = defeated ? view.progress : 0
      lift.position.set(windup > 0 && onTwos(frame) ? 0.05 * windup : defeated ? (onTwos(frame) ? 0.08 : -0.08) : 0, -sinking * sinking * 0.6, 0)
      lift.scale.set(1 - sinking * 0.25, 1 - sinking * 0.25, 1 - sinking * 0.25)
      node.visible = enemy.state !== "Blink"
      const pulse = windup > 0 ? (onTwos(frame) ? 1.45 : 1.15) + windup * 0.4 : 1
      const shown = look.glow * pulse * glowOf(view) * (enemy.state === "Lunge" || enemy.state === "Burst" || enemy.state === "Volley" ? 1.3 : 1)
      const hit = Math.max(flash, defeated && onTwos(frame) ? 0.85 : 0, view?.state === "shifting" && onTwos(frame) ? 0.35 : 0, view?.open === true && view.state !== "broken" && onTwos(frame) ? 0.2 : 0)
      const behind = node.visible && behindProp(parts, node.position.x, shape.height * 0.5, node.position.z)
      setXray(material, behind)
      rim.material = behind ? parts.xrayInk : parts.ink
      setActorFx(material, look, { glow: shown, flash: hit, body: behind ? BEHIND : 1 })
      glow.data.boost = 1.1 * pulse * glowOf(view)
      const airborne = enemy.state === "Leap"
      shadow.scale.set(shape.extent * 2.9 * (airborne ? 0.7 : 1), shape.extent * 2.9 * (airborne ? 0.7 : 1), 1)
      rig.update({ enemy, view, frame, windup, behind, glow: shown, flash: hit })
    },
    destroy: () => {
      rig.destroy()
      node.destroy({ children: true })
      material.destroy()
      glow.destroy()
    }
  }
}

/** How far through its windup a boss body is: its own telegraph's progress in the boss view. */
const windupOf = (enemy: EnemyView, view: BossView | null): number => {
  const mine = view?.telegraphs.find((telegraph) => telegraph.id === enemy.id)
  return mine?.progress ?? 0
}

/** Shared parts made on first use; released with the actors. */
export const releaseBosses = () => {
  if (orreryParts !== undefined) {
    for (const each of orreryParts.rings) {
      each.solid.destroy()
      each.rim.destroy()
    }
    orreryParts.hand.destroy()
    orreryParts.handRim.destroy()
    orreryParts = undefined
  }
  if (sunderParts !== undefined) {
    for (const half of Object.values(sunderParts.halves)) {
      half.solid.destroy()
      half.rim.destroy()
    }
    sunderParts.seam.destroy()
    sunderParts = undefined
  }
}
