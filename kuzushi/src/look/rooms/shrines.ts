import { Mesh3D } from "@pixi/3d"
import type { FlatMaterial } from "@pixi/3d"

import type { FrameTime } from "../../host/types.ts"
import type { DropView, GameView, WeaponId } from "../../sim/index.ts"
import { spriteMaterial } from "../shaders/sprite.ts"
import { DRAWINGS, keyed } from "../twos.ts"
import type { RoomBuild } from "./build.ts"

/**
 * A room's altars and spring (docs/DESIGN.md, Look: Altars and springs). An altar is a low square plinth with the
 * weapon's first move ink-drawn on its face, and above it the weapon's kanji floating in a thin paper ring, bobbing on
 * twos and brightening while the player stands near enough to take it; taken with nothing put back, the ring empties
 * and the drawing fades. A spring is a round pool of paper-white light in a stone lip, rippling on twos; spent, a dry
 * ink ring. A spring a boss leaves rises where it fell, on twos: the stone lip inks in with an overshoot round a dry
 * bed, then (once the zone's CLEAR banner has gone) a starburst and a shaft of paper light flash up, the pool fills
 * with light, and one wide ripple runs out before the pool settles.
 * A clear's drops (a diamond, FOCUS's spark) pop up where the last enemy fell, on twos, and float turning over a
 * soft pool of light with a ring that pulses out, until picked up.
 */

/** Drawings since a spring rose, for one that was there when the room was built. */
const RISEN = 99
/** Drawings a boss's spring waits, its lip inked and its bed dry, before it fills: the zone's CLEAR banner sits over it till then. */
const FILL_AFTER = 26

type SpringSpot = NonNullable<NonNullable<GameView["room"]>["spring"]>

interface Spring {
  readonly spot: SpringSpot
  /** When it rose (real seconds), or -Infinity when it was there as the room was built. */
  readonly risenAt: number
  readonly lip: Mesh3D
  readonly rim: Mesh3D
  readonly pool: FlatMaterial
  readonly poolMesh: Mesh3D
  readonly dryMesh: Mesh3D
  readonly rings: ReadonlyArray<Mesh3D>
  readonly ripples: ReadonlyArray<FlatMaterial>
  readonly surge: FlatMaterial
  readonly surgeMesh: Mesh3D
  readonly star: FlatMaterial
  readonly starMesh: Mesh3D
  readonly shaft: FlatMaterial
  readonly shaftMesh: Mesh3D
}

interface Drop {
  readonly sprite: Mesh3D
  readonly material: FlatMaterial
  readonly pool: Mesh3D
  readonly ring: Mesh3D
  readonly ringMaterial: FlatMaterial
  /** When it appeared (real seconds), or -Infinity when it lay there as the room was built. */
  readonly at: number
}

/**
 * Poses a spring `inked` drawings after it appeared: its lip inks in at once, and the rest (the pool filling, the
 * burst, shaft and wide ripple, then its ripples) `FILL_AFTER` drawings later, once the zone's CLEAR banner has gone.
 */
const poseSpring = (spring: Spring, spent: boolean, drawing: number, inked: number) => {
  const { spot } = spring
  const risen = inked - FILL_AFTER
  const lip = keyed(inked, [0.25, 0.75, 1.14, 0.96, 1])
  const height = keyed(inked, [0.2, 0.6, 1.3, 1])
  spring.lip.scale.set((spot.radius + 0.32) * lip, 0.12 * height, (spot.radius + 0.32) * lip)
  spring.rim.scale.set((spot.radius + 0.62) * lip, 0.05, (spot.radius + 0.62) * lip)
  const fill = keyed(risen, [0, 0, 0.3, 0.6, 0.85, 1.06, 1])
  spring.poolMesh.visible = !spent && fill > 0
  spring.poolMesh.scale.set(spot.radius * 2.15 * fill, spot.radius * 2.15 * fill, 1)
  spring.pool.data.boost = keyed(risen, [0, 0, 3.4, 2.9, 2.4, 2.1, 1.9]) + (drawing % 2) * 0.25
  spring.dryMesh.visible = spent || risen < 3
  spring.rings.forEach((ring, index) => {
    ring.visible = !spent && risen >= 6
    const age = ((drawing + index * 5) % 15) / 15
    const size = spot.radius * 2 * (0.25 + age * 0.85)
    ring.scale.set(size, size, 1)
    const material = spring.ripples[index]
    if (material !== undefined) material.data.boost = 1.4 * (1 - age)
  })
  const wave = (risen - 3) / 8
  spring.surgeMesh.visible = wave >= 0 && wave < 1
  const reach = spot.radius * 2 * (1.1 + wave * 2.6)
  spring.surgeMesh.scale.set(reach, reach, 1)
  spring.surge.data.boost = 2.2 * (1 - wave)
  const flash = keyed(risen - 2, [2.6, 1.9, 1, 0.4, 0])
  spring.starMesh.visible = risen >= 2 && flash > 0
  const starSize = spot.radius * keyed(risen - 2, [3, 4.2, 4.8, 5.1])
  spring.starMesh.scale.set(risen % 2 === 0 ? starSize : -starSize, starSize, 1)
  spring.star.data.boost = flash
  const shaft = keyed(risen - 2, [0.6, 1, 1, 0.7, 0.4, 0.15, 0])
  spring.shaftMesh.visible = risen >= 2 && shaft > 0
  spring.shaftMesh.scale.set(spot.radius * (1.9 - shaft * 0.5), 1.4 + shaft * 3.6, 1)
  spring.shaftMesh.position.y = (1.4 + shaft * 3.6) / 2
  spring.shaft.data.boost = 1.8 * shaft
}

interface Altar {
  readonly kanji: Mesh3D
  readonly kanjiMaterial: FlatMaterial
  readonly face: FlatMaterial
  readonly baseY: number
  weapon: WeaponId | null
}

export interface Shrines {
  update(view: GameView, frame: FrameTime): void
}

export const addShrines = (build: RoomBuild): Shrines => {
  const { room, parts, node, kit } = build
  const plinth = build.ink(0x76767c, { wear: 0.12, streaks: 0.2 })
  const slab = build.ink(0x8c8c92, { wear: 0.1, streaks: 0 })
  const base = build.ink(0x5a5a60, { wear: 0.08, streaks: 0.1 })
  const altars = room.altars.map((spot): Altar => {
    node.addChild(
      parts.box(spot.x, spot.z, 0.66, 0.66, 0, 0.14, base),
      parts.box(spot.x, spot.z, 0.46, 0.46, 0.14, 0.62, plinth),
      parts.box(spot.x, spot.z, 0.56, 0.56, 0.62, 0.74, slab)
    )
    const weapon = spot.weapon
    const face = parts.keep(spriteMaterial(kit.moves[weapon ?? "blade"], 0xffffff, 1, "normal"))
    face.alpha = weapon === null ? 0.2 : 1
    node.addChild(new Mesh3D({ geometry: parts.plane, material: face, position: { x: spot.x, y: 0.38, z: spot.z + 0.465 }, scale: { x: 0.7, y: 0.42, z: 1 }, castShadow: false, receiveShadow: false }))
    const kanjiMaterial = parts.keep(spriteMaterial(kit.kanji[weapon ?? "blade"], 0xffffff, 1.2, "normal"))
    const kanji = new Mesh3D({ geometry: parts.plane, material: kanjiMaterial, billboardMode: "spherical", position: { x: spot.x, y: 1.75, z: spot.z }, scale: { x: 1.05, y: 1.05, z: 1 }, castShadow: false, receiveShadow: false })
    kanji.visible = weapon !== null
    node.addChild(kanji)
    return { kanji, kanjiMaterial, face, baseY: 1.75, weapon }
  })

  const springInk = build.ink(0x6c6c72, { wear: 0.12, streaks: 0 })
  const makeSpring = (spot: SpringSpot, risenAt: number): Spring => {
    const pool = parts.keep(spriteMaterial(kit.pool, 0xffffff, 1.9, "add"))
    const dry = parts.keep(spriteMaterial(kit.dry, 0xffffff, 1, "normal"))
    const ripples = [0, 1, 2].map(() => parts.keep(spriteMaterial(kit.ripple, 0xffffff, 1.4, "add")))
    const surge = parts.keep(spriteMaterial(kit.ripple, 0xffffff, 2, "add"))
    const star = parts.keep(spriteMaterial(kit.burst, 0xffffff, 2.2, "add", [], true))
    const shaft = parts.keep(spriteMaterial(kit.glare, 0xffffff, 1.8, "add"))
    const lip = parts.column(spot.x, spot.z, spot.radius + 0.32, 0, 0.12, springInk)
    const rim = parts.column(spot.x, spot.z, spot.radius + 0.62, 0, 0.05, base)
    const poolMesh = parts.flat(spot.x, 0.13, spot.z, spot.radius * 2.15, spot.radius * 2.15, pool)
    const dryMesh = parts.flat(spot.x, 0.13, spot.z, spot.radius * 2.1, spot.radius * 2.1, dry)
    const rings = ripples.map((material) => parts.flat(spot.x, 0.14, spot.z, 1, 1, material))
    const surgeMesh = parts.flat(spot.x, 0.15, spot.z, 1, 1, surge)
    const starMesh = parts.flat(spot.x, 0.16, spot.z, 1, 1, star)
    const shaftMesh = new Mesh3D({ geometry: parts.plane, material: shaft, billboardMode: "cylindrical", position: { x: spot.x, y: 1.6, z: spot.z }, scale: { x: spot.radius * 1.6, y: 3.2, z: 1 }, castShadow: false, receiveShadow: false })
    node.addChild(rim, lip, dryMesh, poolMesh, ...rings, surgeMesh, starMesh, shaftMesh)
    return { spot, risenAt, lip, rim, pool, poolMesh, dryMesh, rings, ripples, surge, surgeMesh, star, starMesh, shaft, shaftMesh }
  }
  let spring = room.spring === null ? null : makeSpring(room.spring, Number.NEGATIVE_INFINITY)

  const makeDrop = (drop: DropView, at: number): Drop => {
    const material = parts.keep(spriteMaterial(kit.drops[drop.kind], 0xffffff, 1, "normal"))
    const sprite = new Mesh3D({ geometry: parts.plane, material, billboardMode: "spherical", position: { x: drop.x, y: 0.9, z: drop.z }, scale: { x: 0.8, y: 0.8, z: 1 }, castShadow: false, receiveShadow: false })
    const pool = parts.flat(drop.x, 0.03, drop.z, 1.4, 1.4, parts.keep(spriteMaterial(kit.pool, 0xffffff, 0.12, "add")))
    const ringMaterial = parts.keep(spriteMaterial(kit.ripple, 0xffffff, 1.2, "add"))
    const ring = parts.flat(drop.x, 0.04, drop.z, 1, 1, ringMaterial)
    node.addChild(pool, ring, sprite)
    return { sprite, material, pool, ring, ringMaterial, at }
  }
  const drops = new Map<number, Drop>(room.drops.flatMap((drop) => (drop.taken ? [] : [[drop.index, makeDrop(drop, Number.NEGATIVE_INFINITY)] as const])))

  const poseDrop = (drop: Drop, taken: boolean, index: number, drawing: number, since: number) => {
    for (const mesh of [drop.sprite, drop.pool, drop.ring]) mesh.visible = !taken
    if (taken) return
    const rise = keyed(since, [0.15, 1.6, 1.15, 0.92, 1])
    const bob = Math.sin((drawing / DRAWINGS) * 2.6 + index * 2.1) * 0.08
    drop.sprite.position.y = 0.25 + 0.85 * rise + bob
    const size = 1.15 * keyed(since, [0.3, 1.35, 1.1, 1]) * (drawing % 2 === 0 ? 1 : 1.04)
    drop.sprite.scale.set(size * Math.max(0.45, Math.abs(Math.cos(((drawing % 16) / 16) * Math.PI * 2))), size, 1)
    drop.material.data.boost = keyed(since, [2.4, 1.8, 1.3, 1])
    const pulse = ((drawing + index * 4) % 14) / 14
    const reach = keyed(since, [0.6, 1.8, 2.4]) + (since >= 3 ? pulse * 0.9 : 0)
    drop.ring.scale.set(reach, reach, 1)
    drop.ringMaterial.data.boost = since < 3 ? keyed(since, [2, 1.6, 1]) : 0.9 * (1 - pulse)
  }

  return {
    update: (view, frame) => {
      const shown = view.room
      if (shown === null) return
      const drawing = Math.floor(frame.elapsed * DRAWINGS)
      shown.altars.forEach((spot, index) => {
        const altar = altars[index]
        if (altar === undefined) return
        if (spot.weapon !== altar.weapon) {
          altar.weapon = spot.weapon
          if (spot.weapon !== null) {
            altar.kanjiMaterial.textures.baseColor = kit.kanji[spot.weapon]
            altar.face.textures.baseColor = kit.moves[spot.weapon]
          }
        }
        altar.kanji.visible = spot.weapon !== null
        altar.face.alpha = spot.weapon === null ? 0.2 : 1
        const bob = Math.sin((drawing / DRAWINGS) * 2.2 + index * 1.7) * 0.07
        altar.kanji.position.y = altar.baseY + bob + (spot.near ? 0.12 : 0)
        const size = spot.near ? 1.22 + (drawing % 2) * 0.04 : 1.05
        altar.kanji.scale.set(size, size, 1)
        altar.kanjiMaterial.data.boost = spot.near ? 1.9 : 1.2
      })
      for (const drop of shown.drops) {
        const made = drops.get(drop.index) ?? (drop.taken ? undefined : makeDrop(drop, frame.elapsed))
        if (made === undefined) continue
        drops.set(drop.index, made)
        poseDrop(made, drop.taken, drop.index, drawing, made.at === Number.NEGATIVE_INFINITY ? RISEN : Math.floor((frame.elapsed - made.at) * DRAWINGS))
      }
      if (shown.spring === null) return
      if (spring === null) spring = makeSpring(shown.spring, frame.elapsed)
      poseSpring(spring, shown.spring.spent, drawing, spring.risenAt === Number.NEGATIVE_INFINITY ? RISEN + FILL_AFTER : Math.floor((frame.elapsed - spring.risenAt) * DRAWINGS))
    }
  }
}
