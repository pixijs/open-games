import { Container3D, FlatMaterial, Mesh3D, PlaneGeometry } from "@pixi/3d"
import type { BaseMaterial3D, Camera3D, Geometry3D } from "@pixi/3d"
import type { Texture } from "pixi.js"
import { spring } from "math/time"

import { PLAYER_BAND, setXray, XRAY_BAND } from "../art/depth.ts"
import { linearOf } from "../art/color.ts"
import { PALETTE, paletteOf, paletteOfKind } from "../art/palette.ts"
import type { ActorVisual, FrameTime } from "../host/types.ts"
import { enemyKinds, step, Tuning } from "../sim/index.ts"
import type { ActorKind, BossView, EnemyKind, EnemyView, PlayerView, ProjectileView, WeaponMove, ZoneId } from "../sim/index.ts"
import { arrowhead, arrowheadOutline, circle, extrude, grow, rhombus, ring } from "./geometry.ts"
import type { Point } from "./geometry.ts"
import { bossVisual, releaseBosses } from "./bosses.ts"
import { eliteCrown, foeQuirks, releaseFoes } from "./foes.ts"
import { needleVisual } from "./needle.ts"
import { propBetween } from "./occlusion.ts"
import type { Occluders } from "./occlusion.ts"
import { actorMaterial, barMaterial, setActorFx, setBar } from "./shaders/actor.ts"
import { lampMaterial, spriteMaterial } from "./shaders/sprite.ts"
import type { ActorLook } from "./shaders/actor.ts"
import { DASH_KEYS, FIXED, ORBITER_HOLE, PLAYER_RIDGE, PLAYER_SIZE, RIM, SHAPES, WARDEN_PARTS } from "./shapes.ts"
import type { Shape } from "./shapes.ts"
import type { LookTextures } from "./textures.ts"
import { onTwos } from "./twos.ts"

/**
 * Actor visuals: low solids standing on the floor with glowing glyph tops, an ink rim, a soft contact shadow and a
 * pool of light under them. Poses spring between squash and stretch from the actor's state, hits flash white, and
 * enemies, once hurt, carry a thin health bar that always faces the camera.
 */

type BodyKind = EnemyKind | "player"
type Linear = readonly [number, number, number]

const scaled = ([r, g, b]: Linear, amount: number): Linear => [r * amount, g * amount, b * amount]

interface OrbParts {
  readonly core: FlatMaterial
  readonly streak: FlatMaterial
  readonly pool: FlatMaterial
}

/** One drawing of the player's body on its way into a dash: the solid, its ink rim and its top art. */
interface DashKey {
  readonly body: Geometry3D
  readonly rim: Geometry3D
  readonly glyph: Texture
}

interface Kit {
  readonly quad: PlaneGeometry
  readonly bodies: Readonly<Record<BodyKind, Geometry3D>>
  readonly rims: Readonly<Record<BodyKind, Geometry3D>>
  /** The player's body at each of its dash drawings (DASH_KEYS); the first is its body at rest. */
  readonly dashKeys: ReadonlyArray<DashKey>
  /** A dart's needle and its ink rim, pointing +x. */
  readonly needle: Geometry3D
  readonly needleRim: Geometry3D
  /** The needle's white, bright enough to bloom. */
  readonly needleBody: FlatMaterial
  /** One of the warden's shell plates and its rim, centred on +x. */
  readonly plate: Geometry3D
  readonly plateRim: Geometry3D
  readonly looks: Readonly<Record<BodyKind, ActorLook>>
  readonly ink: FlatMaterial
  /** The player's rim, in the player's draw-order band. */
  readonly playerInk: FlatMaterial
  /** An enemy's rim while a prop stands in front of it, drawn through the prop. */
  readonly xrayInk: FlatMaterial
  readonly shadow: FlatMaterial
  readonly textures: LookTextures
  readonly orbs: Readonly<Record<ProjectileView["owner"], OrbParts>>
  /** Whether the floor on screen is pale. */
  readonly pale: () => boolean
  /** Enemy shots in each zone's accent, and the zone on screen. */
  readonly zoneOrbs: Readonly<Record<ZoneId, { readonly enemy: OrbParts; readonly pale: OrbParts }>>
  readonly zone: () => ZoneId
  /** The boss in the room, for the bosses' own parts. */
  readonly boss: () => BossView | null
  /** The view's camera, to tell when a prop stands between it and the player. */
  readonly camera: Camera3D
  /** The solids of the world on screen, which may stand between the camera and the player. */
  readonly occluders: () => Occluders
}

let kit: Kit | undefined

const looksFor = (textures: LookTextures): Readonly<Record<BodyKind, ActorLook>> => {
  const enemy = (kind: EnemyKind): ActorLook => ({
    glyph: textures[kind],
    side: linearOf(paletteOfKind(kind).dangerDeep),
    rim: linearOf(paletteOfKind(kind).danger),
    glow: 1.55,
    emissive: 1,
    rimStrength: 0.55
  })
  return {
    chaser: enemy("chaser"),
    shooter: enemy("shooter"),
    bruiser: enemy("bruiser"),
    trickster: enemy("trickster"),
    orbiter: enemy("orbiter"),
    warden: enemy("warden"),
    lancer: enemy("lancer"),
    splitter: enemy("splitter"),
    splitling: enemy("splitling"),
    sweeper: enemy("sweeper"),
    pulsar: enemy("pulsar"),
    leaper: enemy("leaper"),
    cutter: enemy("cutter"),
    gatekeeper: enemy("gatekeeper"),
    orrery: enemy("orrery"),
    sunder: enemy("sunder"),
    player: { glyph: textures.player, side: scaled(linearOf(PALETTE.paper), 0.62), rim: [1, 1, 1], glow: 1.22, emissive: 0.5, rimStrength: 0.9 }
  }
}

const orbParts = (textures: LookTextures, owner: ProjectileView["owner"]): OrbParts => {
  const enemy = owner === "enemy"
  return {
    core: spriteMaterial(enemy ? textures.orb : textures.glow, enemy ? 0xffffff : PALETTE.paper, enemy ? 1.7 : 2.8, "add"),
    streak: spriteMaterial(textures.streak, enemy ? PALETTE.red : PALETTE.paper, enemy ? 1.8 : 2.2, "add"),
    pool: spriteMaterial(textures.glow, enemy ? PALETTE.red : PALETTE.paper, 0.75, "add")
  }
}

/** A zone's enemy shot: its core in the zone's accent, a streak and a pool of light in it. */
const zoneOrbParts = (textures: LookTextures, zone: ZoneId): { readonly enemy: OrbParts; readonly pale: OrbParts } => {
  const { danger, dangerDeep } = paletteOf(zone)
  const art = textures.zoneOrbs[zone]
  return {
    enemy: {
      core: spriteMaterial(art.orb, 0xffffff, 1.7, "add"),
      streak: spriteMaterial(textures.streak, danger, 1.8, "add"),
      pool: spriteMaterial(textures.glow, danger, 0.75, "add")
    },
    pale: {
      core: spriteMaterial(art.pale, 0xffffff, 1, "normal"),
      streak: spriteMaterial(textures.streak, dangerDeep, 1, "normal"),
      pool: spriteMaterial(textures.glow, dangerDeep, 0.35, "normal")
    }
  }
}

/** The solid of each body: the orbiter a ring, the warden its core (its plates are separate), the rest extruded. */
const bodyGeometry = (kind: BodyKind): Geometry3D => {
  const shape = SHAPES[kind]
  switch (kind) {
    case "player": return arrowhead(PLAYER_SIZE, shape.height, PLAYER_RIDGE, shape.extent)
    case "orbiter": return ring(ORBITER_HOLE, shape.extent, shape.height, shape.extent)
    case "warden": return extrude(circle(WARDEN_PARTS.core, 40), shape.height, shape.extent)
    default: return extrude(shape.outline, shape.height, shape.extent)
  }
}

const RIM_DROP = 0.012

/** An ink rim just under the top edge of `outline` standing `shape.height` tall. */
const rimAround = (outline: ReadonlyArray<Point>, shape: Shape): Geometry3D =>
  extrude(grow(outline, shape.rim), shape.height - RIM_DROP, shape.extent + shape.rim, shape.height * 0.5)

/** The ink rim just under each body's top edge. */
const rimGeometry = (kind: BodyKind): Geometry3D => {
  const shape = SHAPES[kind]
  const top = shape.height - RIM_DROP
  switch (kind) {
    case "orbiter": return ring(ORBITER_HOLE - RIM, shape.extent + RIM, top, shape.extent + RIM, 0, Math.PI * 2, shape.height * 0.5)
    case "warden": return extrude(circle(WARDEN_PARTS.core + RIM, 40), top, shape.extent + RIM, shape.height * 0.5)
    default: return rimAround(shape.outline, shape)
  }
}

const dashKeysFor = (bodies: Readonly<Record<BodyKind, Geometry3D>>, rims: Readonly<Record<BodyKind, Geometry3D>>, textures: LookTextures): ReadonlyArray<DashKey> => {
  const shape = SHAPES.player
  return DASH_KEYS.map((notch, index): DashKey => {
    const glyph = textures.playerKeys[index] ?? textures.player
    if (index === 0) return { body: bodies.player, rim: rims.player, glyph }
    return { body: arrowhead(PLAYER_SIZE, shape.height, PLAYER_RIDGE, shape.extent, notch), rim: rimAround(arrowheadOutline(PLAYER_SIZE, notch), shape), glyph }
  })
}

/** Builds the shared geometry and materials; look's install calls it before any actor appears. Returns the teardown. */
export const prepareActors = (
  textures: LookTextures,
  camera: Camera3D,
  occluders: () => Occluders,
  pale: () => boolean,
  boss: () => BossView | null,
  zone: () => ZoneId
): (() => void) => {
  const bodyKinds: ReadonlyArray<BodyKind> = [...enemyKinds, "player"]
  const bodies = Object.fromEntries(bodyKinds.map((kind) => [kind, bodyGeometry(kind)])) as Record<BodyKind, Geometry3D>
  const rims = Object.fromEntries(bodyKinds.map((kind) => [kind, rimGeometry(kind)])) as Record<BodyKind, Geometry3D>
  const half = (Math.PI / WARDEN_PARTS.plates) * WARDEN_PARTS.span
  const extent = SHAPES.warden.extent
  const made: Kit = {
    quad: new PlaneGeometry({ width: 1, height: 1, flipV: true }),
    bodies,
    rims,
    dashKeys: dashKeysFor(bodies, rims, textures),
    needle: extrude(rhombus(NEEDLE.length, NEEDLE.width), NEEDLE.thick, NEEDLE.length / 2),
    needleRim: extrude(grow(rhombus(NEEDLE.length, NEEDLE.width), 0.035), NEEDLE.thick - 0.01, NEEDLE.length / 2, -0.01),
    needleBody: lampMaterial(PALETTE.paper, 1.9),
    plate: ring(WARDEN_PARTS.inner, WARDEN_PARTS.outer, WARDEN_PARTS.height, extent, -half, half, 0, 12),
    plateRim: ring(WARDEN_PARTS.inner - RIM, WARDEN_PARTS.outer + RIM, WARDEN_PARTS.height - 0.012, extent + RIM, -half - 0.05, half + 0.05, WARDEN_PARTS.height * 0.5, 12),
    looks: looksFor(textures),
    ink: new FlatMaterial({ baseColor: PALETTE.ink }),
    playerInk: new FlatMaterial({ baseColor: PALETTE.ink, extraBits: [PLAYER_BAND] }),
    xrayInk: new FlatMaterial({ baseColor: PALETTE.ink, extraBits: [XRAY_BAND] }),
    shadow: spriteMaterial(textures.shadow, 0xffffff, 1, "normal"),
    textures,
    orbs: { enemy: orbParts(textures, "enemy"), player: orbParts(textures, "player") },
    camera,
    occluders,
    pale,
    zoneOrbs: { courtyard: zoneOrbParts(textures, "courtyard"), spiral: zoneOrbParts(textures, "spiral"), void: zoneOrbParts(textures, "void") },
    zone,
    boss
  }
  setXray(made.xrayInk, true)
  kit = made
  return () => {
    kit = undefined
    releaseFoes()
    releaseBosses()
    made.quad.destroy()
    for (const geometry of [...Object.values(bodies), ...Object.values(rims), made.plate, made.plateRim, made.needle, made.needleRim]) geometry.destroy()
    made.needleBody.destroy()
    for (const key of made.dashKeys.slice(1)) {
      key.body.destroy()
      key.rim.destroy()
    }
    made.ink.destroy()
    made.playerInk.destroy()
    made.xrayInk.destroy()
    made.shadow.destroy()
    for (const parts of [...Object.values(made.orbs), ...Object.values(made.zoneOrbs).flatMap((set) => [set.enemy, set.pale])]) for (const material of Object.values(parts)) material.destroy()
  }
}

export const useKit = (): Kit => {
  if (kit === undefined) throw new Error("createActorVisual: installLook has not prepared the actors yet")
  return kit
}

/** The point `behindProp` tests, reused for every actor. */
const seen = { x: 0, y: 0, z: 0 }

/** Whether one of the solids on screen stands between the camera and (x, y, z). */
export const behindProp = (parts: Pick<Kit, "occluders" | "camera">, x: number, y: number, z: number): boolean => {
  seen.x = x
  seen.y = y
  seen.z = z
  return propBetween(parts.occluders(), parts.camera.position, seen)
}

/** A quad lying on the floor, centred under the actor. */
export const groundQuad = (material: FlatMaterial, size: number, lift: number): Mesh3D =>
  new Mesh3D({
    geometry: useKit().quad,
    material,
    rotation: { x: -Math.PI / 2, y: 0, z: 0 },
    position: { x: 0, y: lift, z: 0 },
    scale: { x: size, y: size, z: 1 },
    castShadow: false,
    receiveShadow: false
  })

/** The solid and its ink rim, built pointing +x; squash it through the pose node and turn it about its axis through `spin`. */
export const body = (kind: BodyKind, material: BaseMaterial3D, ink: FlatMaterial): { readonly pose: Container3D; readonly spin: Container3D; readonly rim: Mesh3D; readonly solid: Mesh3D } => {
  const parts = useKit()
  const pose = new Container3D({ label: `${kind}-pose` })
  const spin = new Container3D()
  const rim = new Mesh3D({ geometry: parts.rims[kind], material: ink, castShadow: false, receiveShadow: false })
  const solid = new Mesh3D({ geometry: parts.bodies[kind], material, castShadow: true, receiveShadow: false })
  spin.addChild(rim, solid)
  pose.addChild(spin)
  return { pose, spin, rim, solid }
}

/** Squash and stretch along the facing, sprung so poses overshoot and settle like drawn keys. */
export const makePose = () => {
  const along = spring.create(1)
  const up = spring.create(1)
  return {
    to: (stretch: number, height: number, dt: number) => {
      spring.update(along, stretch, 0.06, 0.45, dt)
      spring.update(up, height, 0.06, 0.45, dt)
    },
    apply: (node: Container3D, extra = 1) => node.scale.set(along.value * extra, up.value * extra, extra / Math.sqrt(Math.max(0.2, along.value)))
  }
}

/**
 * How fast the player's body folds into the dart as a dash starts and opens back out after it, per second of game
 * time: in by the dash's third frame, out over a fifth of a second.
 */
const DART = { into: 45, out: 10 } as const

/** How much of the player's body shows on the off drawings of its hurt blink: a ghost, never gone. */
const GHOST = 0.3

/**
 * How much of an actor's body shows while a prop stands in front of it: the player always draws over everything, an
 * enemy then draws through the prop, so either reads as seen through it.
 */
export const BEHIND = 0.42

type Pose = readonly [number, number]

/**
 * Each weapon move's key poses, windup, active and recover, as stretch along the facing and height: the cuts snap
 * long and flat, the cleave winds deeper and lands flatter, a dart recoils, the pierce kicks hard, a sigil's tip flicks
 * forward and holds there, and the slam crouches, hangs, then lands squashed flat.
 */
const MOVE_POSES: Readonly<Record<WeaponMove, readonly [Pose, Pose, Pose]>> = {
  cut: [[0.8, 1.2], [1.28, 0.85], [1, 1]],
  crosscut: [[0.8, 1.2], [1.28, 0.85], [1, 1]],
  spin: [[0.8, 1.2], [1.28, 0.85], [1, 1]],
  cleave: [[0.66, 1.34], [1.46, 0.74], [1.08, 0.9]],
  slam: [[0.84, 1.24], [1.5, 0.52], [1.1, 0.86]],
  dart: [[0.92, 1.06], [0.76, 1.12], [0.96, 1.02]],
  pierce: [[0.7, 1.2], [0.62, 1.22], [0.9, 1.06]],
  sigil: [[0.86, 1.18], [1.32, 0.84], [1.18, 0.92]],
  seal: [[0.76, 1.28], [1.42, 0.78], [1.24, 0.88]]
}

/** The pose a state calls for: stretch along the facing, and height. */
const playerPose = (player: PlayerView): Pose => {
  if (player.move !== null && player.attackPhase !== null && player.state !== "Charge") {
    const [windup, active, recover] = MOVE_POSES[player.move]
    return player.attackPhase === "windup" ? windup : player.attackPhase === "active" ? active : recover
  }
  switch (player.state) {
    case "Dash": return [1.5, 0.7]
    case "Charge": return [0.84, 1.16]
    case "Parry": return [0.85, 1.25]
    case "Special": return [1.15, 1.15]
    case "Attack":
    case "Slam":
    case "Down":
    case "Free": return [1, 1]
  }
}

/**
 * The slam's hop, a drawing every four steps (on twos) through its windup: a crouch, the rise, the top held for two
 * drawings, the drop. Heights in world units, and the nose's pitch (down) on each.
 */
const HOP: ReadonlyArray<readonly [number, number]> = [[0.05, 0.12], [0.95, -0.22], [1.45, -0.1], [1.45, 0.08], [0.55, 0.45]]

const hopOf = (player: PlayerView): readonly [number, number] => {
  if (player.state !== "Slam" || player.attackPhase !== "windup") return [0, 0]
  const drawing = Math.min(HOP.length - 1, Math.floor((player.progress * Tuning.MOVE.slam.windup.steps) / 4))
  return HOP[drawing] ?? [0, 0]
}

/** How far toward the dart pose a charge folds the back notch, at full charge. */
const CHARGE_FOLD = 0.85

const playerVisual = (): ActorVisual => {
  const parts = useKit()
  const look = parts.looks.player
  const material = actorMaterial(look, [PLAYER_BAND])
  const glow = spriteMaterial(parts.textures.glow, PALETTE.paper, 0.26, "add")
  const node = new Container3D({ label: "player" })
  const { pose, rim, solid } = body("player", material, parts.playerInk)
  const turn = new Container3D()
  turn.addChild(pose)
  const shadow = groundQuad(parts.shadow, PLAYER_SIZE * 3.2, 0.012)
  node.addChild(shadow, groundQuad(glow, 2.6, 0.016), turn)
  const shape = makePose()
  const spin = spring.create(0)
  let flash = 0
  let spinning = false
  let dart = 0
  let drawn = 0
  return {
    node,
    place: (x, z, facing) => {
      node.position.set(x, 0, z)
      turn.rotation.y = -facing
    },
    update: (actor, frame) => {
      if (actor.role !== "player") return
      const player = actor.player
      // Going down shatters the arrowhead in vfx; the body draws over every effect, so it would hide that. A boss's
      // name card films low from the hero's side, where the flat arrowhead would stand edge-on in the foreground.
      node.visible = player.state !== "Down" && parts.boss()?.state !== "intro"
      if (!node.visible) return
      const dt = frame.dt
      const dashing = player.state === "Dash"
      const charging = player.state === "Charge"
      const folded = dashing ? 1 : charging ? Math.min(1, player.progress) * CHARGE_FOLD : 0
      dart += (folded - dart) * (1 - Math.exp(-frame.gameDt * (folded > dart ? DART.into : DART.out)))
      const key = Math.round(dart * (parts.dashKeys.length - 1))
      const drawing = parts.dashKeys[key]
      if (key !== drawn && drawing !== undefined) {
        drawn = key
        solid.geometry = drawing.body
        rim.geometry = drawing.rim
        material.textures.glyph = drawing.glyph
      }
      const [stretch, height] = playerPose(player)
      shape.to(stretch, height, dt)
      shape.apply(pose)
      const [lift, pitch] = hopOf(player)
      const full = charging && player.progress >= 1
      turn.position.set(0, lift, full && onTwos(frame) ? 0.025 : 0)
      const raised = 1 + lift * 0.12
      turn.scale.set(raised, raised, raised)
      pose.rotation.z = -pitch
      shadow.scale.set(PLAYER_SIZE * 3.2 * (1 - lift * 0.35), PLAYER_SIZE * 3.2 * (1 - lift * 0.35), 1)
      if (player.move === "spin" && player.attackPhase === "active") {
        spin.value -= dt * 34
        spinning = true
      } else {
        if (spinning) spin.value %= Math.PI * 2
        spinning = false
        spring.dampAngle(spin, 0, 0.05, dt)
      }
      pose.rotation.y = spin.value
      flash = Math.max(0, flash - dt * 6)
      if (player.state === "Parry" && player.parryOpen) flash = Math.max(flash, 0.45)
      if (player.attackPhase === "active" && (player.move === "sigil" || player.move === "seal" || player.move === "slam")) flash = Math.max(flash, 0.5)
      const hurt = player.invulnerable && player.state !== "Dash" && player.state !== "Special"
      const ghost = hurt && onTwos(frame)
      const behind = behindProp(parts, node.position.x, 0.15, node.position.z)
      const charged = player.state === "Special" ? 2.2 : dashing ? 1.6 : full ? 2 : charging ? 1 + player.progress * 0.6 : 1
      setActorFx(material, look, { glow: look.glow * (charged > 1 ? 1.25 : 1), flash, body: ghost ? GHOST : behind ? BEHIND : 1 })
      glow.data.boost = 0.26 * charged
    },
    destroy: () => {
      node.destroy({ children: true })
      material.destroy()
      glow.destroy()
    }
  }
}

/** A dart's needle: its length and width at rest (the pierce draws longer), its thickness, and how high it flies. */
const NEEDLE = { length: 0.9, width: 0.14, thick: 0.06, height: 0.5, pierce: { long: 1.7, wide: 1.25 } } as const

/** A dart in flight: a white needle with an ink rim, a streak of light behind it and a pool of light under it. */
const dartVisual = (): ActorVisual => {
  const parts = useKit()
  const node = new Container3D({ label: "dart" })
  const turn = new Container3D({ position: { x: 0, y: NEEDLE.height, z: 0 } })
  const streak = new Mesh3D({ geometry: parts.quad, material: parts.orbs.player.streak, rotation: { x: -Math.PI / 2, y: 0, z: 0 }, position: { x: -0.95, y: 0, z: 0 }, scale: { x: 1.9, y: 0.26, z: 1 }, castShadow: false, receiveShadow: false })
  turn.addChild(
    streak,
    new Mesh3D({ geometry: parts.needleRim, material: parts.ink, castShadow: false, receiveShadow: false }),
    new Mesh3D({ geometry: parts.needle, material: parts.needleBody, castShadow: false, receiveShadow: false })
  )
  const pool = groundQuad(parts.orbs.player.pool, 1.3, 0.018)
  node.addChild(groundQuad(parts.shadow, 0.5, 0.012), pool, turn)
  return {
    node,
    place: (x, z, facing) => {
      node.position.set(x, 0, z)
      turn.rotation.y = -facing
    },
    update: (actor, frame) => {
      if (actor.role !== "dart") return
      const pierce = actor.dart.move === "pierce"
      const flicker = onTwos(frame) ? 1 : 1.06
      turn.scale.set((pierce ? NEEDLE.pierce.long : 1) * flicker, 1, pierce ? NEEDLE.pierce.wide : 1)
      streak.scale.set(pierce ? 3.4 : 1.9, pierce ? 0.34 : 0.26, 1)
      streak.position.x = pierce ? -1.6 : -0.95
    },
    destroy: () => node.destroy({ children: true })
  }
}

export const enemyPose = (enemy: EnemyView): readonly [number, number] => {
  switch (enemy.state) {
    case "Windup": return [0.82, 0.62]
    case "Lunge":
    case "Glide": return [1.45, 0.8]
    case "Burst":
    case "Volley":
    case "Moons": return [1.2, 0.85]
    case "Sweep": return [1.12, 0.88]
    case "Pulse": return [1.15, 0.8]
    case "Leap": return [0.85, 1.2]
    case "Cut": return [1.3, 0.78]
    case "Quake": return [1.3, 0.6]
    case "Recover": return [0.95, 1.05]
    case "Stagger": return [0.9, 0.8]
    case "Spawning":
    case "Move":
    case "Blink":
    case "Falling": return [1, 1]
  }
}

/**
 * The lancer's thin body stays saturated red through its windup (brightening would wash it pale): it quivers instead,
 * and flashes white only from here on, its last three steps.
 */
const LANCER_FLASH = 1 - 3 / Tuning.LANCER.windup.steps

const SPAWN_SECONDS = Tuning.SPAWN.time.steps / step.hz

/** States that brighten an enemy's glow: it is striking. */
const ATTACKING: ReadonlySet<EnemyView["state"]> = new Set(["Lunge", "Burst", "Volley", "Sweep", "Pulse", "Cut", "Quake"])
const FALL_SECONDS = Tuning.RING_OUT.fall.steps / step.hz

/** Overshoots past 1 and settles, for a pop into place. */
const backOut = (t: number) => {
  const c = 2.2
  const u = t - 1
  return 1 + (c + 1) * u * u * u + c * u * u
}

/**
 * What the shared enemy pose leaves to each kind: the orbiter's spin, the warden's shell, the lancer's hover, the
 * splitter breathing along its seam and the splitling's twitch.
 */
export interface Quirks {
  /** `behind`: a prop stands in front of it, so it draws through the prop at the dimmed body level. */
  update(enemy: EnemyView, frame: FrameTime, glow: number, flash: number, behind: boolean): void
  destroy(): void
}

const NO_QUIRKS: Quirks = { update: () => {}, destroy: () => {} }

/** The warden's shell: plates that drift round its eye, close and spin up while it fires, then open and sag, dimmed. */
const wardenShell = (lift: Container3D, look: ActorLook): Quirks => {
  const parts = useKit()
  const material = actorMaterial(look, [XRAY_BAND])
  const shell = new Container3D({ label: "warden-shell" })
  const rims: Array<Mesh3D> = []
  const plates = Array.from({ length: WARDEN_PARTS.plates }, (_, index) => {
    const holder = new Container3D({ rotation: { x: 0, y: (index / WARDEN_PARTS.plates) * Math.PI * 2, z: 0 } })
    const plate = new Container3D()
    const rim = new Mesh3D({ geometry: parts.plateRim, material: parts.ink, castShadow: false, receiveShadow: false })
    rims.push(rim)
    plate.addChild(rim, new Mesh3D({ geometry: parts.plate, material, castShadow: true, receiveShadow: false }))
    holder.addChild(plate)
    shell.addChild(holder)
    return plate
  })
  lift.addChild(shell)
  const open = spring.create(0)
  let angle = 0
  return {
    update: (enemy, frame, glow, flash, behind) => {
      const opened = enemy.state === "Recover"
      const shielded = enemy.shielded === true
      spring.update(open, opened ? 0.36 : shielded ? -0.05 : 0, 0.08, 0.5, frame.dt)
      const windup = enemy.state === "Windup" ? (enemy.telegraph?.progress ?? 0) : 0
      const rate = enemy.state === "Volley" ? 7 : windup > 0 ? 1.5 + windup * 5 : opened ? 0.1 : 0.5
      angle += rate * frame.gameDt
      shell.rotation.y = angle
      const jitter = enemy.state === "Stagger" && onTwos(frame) ? 0.04 : 0
      const sag = Math.max(0, open.value)
      for (const plate of plates) {
        plate.position.set(open.value + jitter, -sag * 0.3, 0)
        plate.rotation.z = -sag * 1.1
      }
      setXray(material, behind)
      for (const rim of rims) rim.material = behind ? parts.xrayInk : parts.ink
      setActorFx(material, look, { glow: glow * (shielded ? 1.5 : opened ? 0.4 : 1), flash: Math.max(flash, shielded && windup > 0.85 && onTwos(frame) ? 0.5 : 0), body: behind ? BEHIND : 1 })
    },
    destroy: () => material.destroy()
  }
}

const quirksOf = (kind: EnemyKind, lift: Container3D, pose: Container3D, spin: Container3D, look: ActorLook, id: () => number): Quirks => {
  switch (kind) {
    case "warden": return wardenShell(lift, look)
    case "orbiter": {
      return {
        update: (enemy, frame) => {
          spin.rotation.y += (enemy.state === "Lunge" ? 18 : enemy.state === "Windup" ? 11 : 5) * frame.gameDt
        },
        destroy: () => {}
      }
    }
    case "lancer": {
      return {
        update: (enemy, frame) => {
          const windup = enemy.state === "Windup" ? (enemy.telegraph?.progress ?? 0) : 0
          const quiver = windup > 0 && onTwos(frame) ? 0.03 : 0
          pose.position.set(-0.24 * windup, 0, quiver)
          spin.rotation.x = Math.sin(frame.elapsed * 2.3 + id()) * 0.12 + (windup > 0 && onTwos(frame) ? 0.08 : 0)
          if (enemy.state !== "Falling" && enemy.state !== "Spawning") lift.position.y += 0.06 + Math.sin(frame.elapsed * 3.4 + id()) * 0.03
        },
        destroy: () => {}
      }
    }
    case "splitter": {
      return {
        update: (_enemy, frame) => {
          const breath = Math.sin(frame.gameElapsed * 4.2) * 0.045
          spin.scale.set(1 - breath, 1, 1 + breath)
        },
        destroy: () => {}
      }
    }
    case "splitling": {
      return {
        update: (enemy, frame) => {
          spin.rotation.y = enemy.state === "Move" ? (onTwos(frame) ? 0.14 : -0.14) : 0
        },
        destroy: () => {}
      }
    }
    default: return foeQuirks(kind, lift, pose, spin, id) ?? NO_QUIRKS
  }
}

const enemyVisual = (kind: EnemyKind): ActorVisual => {
  const parts = useKit()
  const look = parts.looks[kind]
  const shape = SHAPES[kind]
  const material = actorMaterial(look, [XRAY_BAND])
  const accent = paletteOfKind(kind).danger
  const glow = spriteMaterial(parts.textures.glow, accent, 0.9, "add")
  const bar = barMaterial(scaled(linearOf(accent), 2.2))
  const node = new Container3D({ label: kind })
  const lift = new Container3D()
  const turn = new Container3D()
  const { pose, spin, rim } = body(kind, material, parts.ink)
  turn.addChild(pose)
  lift.addChild(turn)
  const barMesh = new Mesh3D({
    geometry: parts.quad,
    material: bar,
    billboardMode: "spherical",
    position: { x: 0, y: shape.height + 0.55, z: -Tuning.ENEMY[kind].radius - 0.35 },
    scale: { x: kind === "bruiser" || kind === "warden" ? 1.25 : 0.95, y: 0.085, z: 1 },
    castShadow: false,
    receiveShadow: false
  })
  const shadow = groundQuad(parts.shadow, shape.extent * 2.7, 0.012)
  const pool = groundQuad(glow, shape.extent * 4.2, 0.016)
  node.addChild(shadow, pool, lift, barMesh)
  let seenId = 0
  const quirks = quirksOf(kind, lift, pose, spin, look, () => seenId)
  const squash = makePose()
  const punch = spring.create(1)
  let flash = 0
  let lastHp = Number.NaN
  let chip = 1
  let chipHold = 0
  let crown: ReturnType<typeof eliteCrown> | null = null
  /** Seconds since it appeared, and whether it is a splitling thrown out of a splitter, which pops in with a white flash. */
  let age = 0
  let popIn: boolean | null = null
  const turns = !FIXED.has(kind)
  return {
    node,
    place: (x, z, facing) => {
      node.position.set(x, 0, z)
      if (turns) turn.rotation.y = -facing
    },
    update: (actor, frame) => {
      if (actor.role !== "enemy") return
      const enemy = actor.enemy
      const dt = frame.dt
      seenId = enemy.id
      popIn ??= kind === "splitling" && enemy.state !== "Spawning"
      age += dt
      const pop = popIn ? Math.min(1, age / 0.22) : 1
      const ratio = Math.max(0, Math.min(1, enemy.hp / enemy.maxHp))
      if (!Number.isNaN(lastHp) && enemy.hp < lastHp) {
        flash = 1
        punch.value = 1.28
        chipHold = 0.28
      }
      lastHp = enemy.hp
      flash = Math.max(0, flash - dt * 7, popIn ? 1 - pop : 0)
      spring.update(punch, 1, 0.07, 0.35, dt)
      chipHold = Math.max(0, chipHold - dt)
      chip = chipHold > 0 ? chip : Math.max(ratio, chip - dt * 1.6)

      const [stretch, height] = enemyPose(enemy)
      squash.to(stretch, height, dt)
      squash.apply(pose, punch.value)
      const spawning = enemy.state === "Spawning" ? Math.max(0, Math.min(1, 1 - enemy.timeLeft / SPAWN_SECONDS)) : 1
      const fall = enemy.state === "Falling" ? Math.max(0, Math.min(1, 1 - enemy.timeLeft / FALL_SECONDS)) : 0
      const size = (enemy.state === "Spawning" ? backOut(spawning) : popIn ? 0.35 + 0.65 * backOut(pop) : 1) * (1 - fall * 0.35)
      const elite = enemy.elite === true
      if (elite && crown === null) {
        crown = eliteCrown(kind)
        lift.addChild(crown.node)
      }
      const grown = size * (elite ? Tuning.ELITE.radius : 1)
      lift.scale.set(grown, grown, grown)
      const windup = enemy.state === "Windup" ? (enemy.telegraph?.progress ?? 0) : 0
      lift.position.set(windup > 0 && onTwos(frame) ? 0.035 * windup : 0, (spawning - 1) * 0.35 - fall * fall * 7, 0)
      lift.rotation.set(fall * 2.6, 0, fall * 1.3)
      node.visible = enemy.state !== "Blink"
      barMesh.visible = fall === 0 && ratio < 0.999
      shadow.visible = fall === 0
      pool.visible = fall === 0

      const shell = enemy.shielded === true ? 1.3 : 1
      const steady = kind === "lancer"
      const pulse = (windup > 0 && !steady ? (onTwos(frame) ? 1.45 : 1.15) + windup * 0.4 : 1) * shell
      const attacking = (ATTACKING.has(enemy.state) ? 1.35 : 1) * (elite ? 1.3 : 1)
      const exposed = kind === "warden" && enemy.state === "Recover" && onTwos(frame) ? 0.22 : 0
      const release = steady && windup >= LANCER_FLASH ? 0.7 : 0
      const shown = look.glow * pulse * attacking * (0.4 + 0.6 * spawning) * (1 - fall * 0.6)
      const hit = Math.max(flash, enemy.state === "Stagger" ? 0.25 : 0, exposed, release)
      const behind = node.visible && fall === 0 && behindProp(parts, node.position.x, shape.height * 0.5, node.position.z)
      setXray(material, behind)
      rim.material = behind ? parts.xrayInk : parts.ink
      setActorFx(material, look, { glow: shown, flash: hit, body: behind ? BEHIND : 1 })
      glow.data.boost = 0.9 * pulse * attacking * spawning
      setBar(bar, ratio, chip, spawning)
      quirks.update(enemy, frame, shown, hit, behind)
      crown?.update(frame, behind)
    },
    destroy: () => {
      quirks.destroy()
      node.destroy({ children: true })
      material.destroy()
      glow.destroy()
      bar.destroy()
    }
  }
}

const orbVisual = (): ActorVisual => {
  const parts = useKit()
  const node = new Container3D({ label: "orb" })
  const height = 0.5
  const core = new Mesh3D({ geometry: parts.quad, material: parts.orbs.enemy.core, billboardMode: "spherical", position: { x: 0, y: height, z: 0 }, scale: { x: 0.95, y: 0.95, z: 1 }, castShadow: false, receiveShadow: false })
  const tail = new Container3D({ position: { x: 0, y: height - 0.02, z: 0 } })
  const streak = new Mesh3D({ geometry: parts.quad, material: parts.orbs.enemy.streak, rotation: { x: -Math.PI / 2, y: 0, z: 0 }, position: { x: -0.8, y: 0, z: 0 }, scale: { x: 1.8, y: 0.42, z: 1 }, castShadow: false, receiveShadow: false })
  tail.addChild(streak)
  const pool = groundQuad(parts.orbs.enemy.pool, 1.9, 0.018)
  node.addChild(groundQuad(parts.shadow, 0.55, 0.012), pool, tail, core)
  let shown = parts.orbs.enemy
  return {
    node,
    place: (x, z) => node.position.set(x, 0, z),
    update: (actor, frame) => {
      if (actor.role !== "orb") return
      const orb = actor.orb
      const zoned = parts.zoneOrbs[parts.zone()]
      const look = orb.owner === "enemy" ? (parts.pale() ? zoned.pale : zoned.enemy) : parts.orbs[orb.owner]
      if (look !== shown) {
        shown = look
        core.material = look.core
        streak.material = look.streak
        pool.material = look.pool
      }
      tail.rotation.y = -Math.atan2(orb.dirZ, orb.dirX)
      const size = onTwos(frame) ? 0.95 : 1.06
      core.scale.set(size, size, 1)
    },
    destroy: () => node.destroy({ children: true })
  }
}

/** The render systems call this for every new actor entity. */
export const createActorVisual = (kind: ActorKind): ActorVisual => {
  switch (kind) {
    case "player": return playerVisual()
    case "orb": return orbVisual()
    case "dart": return dartVisual()
    case "needle": return needleVisual()
    case "gatekeeper":
    case "orrery":
    case "sunder": return bossVisual(kind)
    default: return enemyVisual(kind)
  }
}
