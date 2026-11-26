import { Container3D, CylinderGeometry, Mesh3D } from "@pixi/3d"
import type { BaseMaterial3D, FlatMaterial } from "@pixi/3d"
import type { Texture } from "pixi.js"

import { OVERLAY_BAND } from "../../art/depth.ts"
import { paletteOf } from "../../art/palette.ts"
import type { FrameTime } from "../../host/types.ts"
import { doorLine, DOORWAY, onSide, ZONES } from "../../sim/index.ts"
import type { GameView, RoomView, Side } from "../../sim/index.ts"
import { KERB, SUNKEN } from "../parts.ts"
import { lampMaterial, spriteMaterial } from "../shaders/sprite.ts"
import { DRAWINGS, keyed } from "../twos.ts"
import type { RoomBuild } from "./build.ts"
import type { DoorIcon } from "./kit.ts"

/**
 * A room's doorways, each designed per zone (docs/DESIGN.md, Look: Doors). A side shows a door to the next room or, in
 * a boss room, the zone gate; a side with nothing behind it is plain wall (the zone's builder runs it through). A door
 * is built in its own frame: across its opening (x) and out along it (z, 0 at the floor's edge, outward positive),
 * turned to its side.
 *
 * - The Courtyard: two square posts and a lintel in the wall's gap over a worn threshold; locked, the gap is plugged
 *   with ink under a thick brush stroke, which drops in on twos and splits apart into splatter when the room clears.
 * - The Spiral: two stele flanking a cut in the ring wall; locked, an iris of stone plates slides shut from them round
 *   an amber seam, and slides back to open.
 * - The Void: two needle posts at the end of the door's landing; locked, a membrane of hatched violet lines draws
 *   across between them and snaps and falls away when the room clears.
 *
 * A locked door hangs a seal emblem in the accent in its doorway (the south door's on its right post, off the lane the
 * hero arrives by), a ring of ticks round the icon of the marked room behind it, facing the camera so it reads from
 * every side mid-fight; the door into a boss room has taller posts and its emblem pulses slowly. An open door is lit:
 * a soft fan of the zone's light spills from it across the floor, a dim blade of light stands in it, two paper
 * chevrons on its threshold point out, and a marked door carries the icon of the room behind it in paper above it.
 * A boss room's far wall holds the zone gate, which splits open on the boss's defeat onto a glare of the next zone's
 * light: a blade in the doorway and a fan across the floor with streaks of the next zone's accent through it.
 */

/** A seal drawn per zone: where it stands this frame, from drawings since it shut and since it broke (null: not yet). */
interface Seal {
  pose(shut: number | null, broke: number | null, beat: number): void
}

/** A mesh and the material whose strength poses it. */
interface Lit {
  readonly mesh: Mesh3D
  readonly material: FlatMaterial
}

interface Door {
  readonly side: Side
  readonly boss: boolean
  readonly seal: Seal | null
  readonly marker: Mesh3D | null
  readonly emblem: Container3D
  readonly emblemMaterials: ReadonlyArray<FlatMaterial>
  readonly glow: Lit
  readonly spill: Lit
  readonly chevron: Lit
  locked: boolean
  shutAt: number | null
  brokeAt: number | null
}

/**
 * The south door's emblem and open marker hang on its right post, `across` from the door's middle and `height` over
 * the floor, not in the doorway: the hero arrives 1.6 inside that door, and an emblem there would sit right under it.
 */
const SOUTH_EMBLEM = { across: 2.5, height: 1.75 } as const

/**
 * An open door's light: how strong its fan across the floor, its blade in the doorway and its chevrons are once its
 * seal's flash has faded, and the fan's size (across and into the room).
 */
const OPEN_LIGHT = { spill: 0.2, blade: 0.26, chevron: 1, fanWidth: 5.2, fanDepth: 5.6 } as const

/** The gate's glare: its fan across the floor (never past 0.35), the accent's streaks through it, the blade, the haze. */
const GATE_LIGHT = { fan: 0.32, rays: 0.4, blade: 1.25, haze: 0.22, fanWidth: 7.5, fanDepth: 9 } as const

/** A door's yaw: its frame's +z turned to point out through its side. */
const yawOf = (side: Side) => {
  const out = onSide(side, 1)
  return Math.atan2(out.x, out.z)
}

const iconOf = (zone: RoomBuild["zone"], room: RoomView, side: Side, gate: Side | null): DoorIcon | null => {
  if (side === gate) return "gate"
  const mark = room.doors.find((door) => door.side === side)?.mark ?? null
  switch (mark) {
    case null:
    case "combat": return null
    case "boss": return `boss-${zone}`
    default: return mark
  }
}

/** Whether a door is the boss door: the one into a boss room, from either side. */
const isBossDoor = (room: RoomView, side: Side): boolean => {
  const door = room.doors.find((each) => each.side === side)
  return door !== undefined && door.to !== null && (door.mark === "boss" || room.kind === "boss")
}

interface Frame {
  readonly postTop: number
  readonly seal: Seal | null
  /** How high a locked door's emblem hangs, clear above its seal. */
  readonly emblem: number
}

type Kind = "door" | "closed" | "gate"

/** The Courtyard: posts and lintel in the wall's gap over a threshold, and an ink plug under a brush stroke. */
const courtyardDoor = (build: RoomBuild, holder: Container3D, side: Side, kind: Kind, boss: boolean): Frame => {
  const { parts, layout } = build
  const wall = layout.wall
  const south = side === "south"
  const top = south ? KERB : layout.wallHeight
  const postTop = south ? KERB + 0.5 + (boss ? 0.5 : 0) : layout.wallHeight + 1.25 + (boss ? 1.6 : 0)
  if (kind === "closed") return { postTop, seal: null, emblem: 0 }
  const post = build.ink(0x76767c, { wear: 0.1, streaks: 0.3 })
  const cap = build.ink(0x8c8c92, { wear: 0.08, streaks: 0 })
  const half = DOORWAY.width / 2
  for (const across of [-(half + 0.34), half + 0.34]) {
    holder.addChild(parts.box(across, wall / 2, 0.34, 0.4, -SUNKEN, postTop, post), parts.box(across, wall / 2, 0.42, 0.48, postTop, postTop + 0.14, cap))
  }
  if (!south) holder.addChild(parts.box(0, wall / 2, half + 0.7, 0.36, postTop - 0.44, postTop - 0.02, build.ink(0x6c6c72, { wear: 0.1, streaks: 0.2 })))
  if (boss && !south) holder.addChild(parts.box(0, wall / 2, half + 0.86, 0.46, postTop + 0.14, postTop + 0.34, cap))
  holder.addChild(parts.box(0, wall / 2, half, wall / 2, -SUNKEN, 0, build.ink(0x6a6a70, { wear: 0.12, streaks: 0.1, grainAmount: 0.45 })))
  const plugTop = top + 0.18
  if (kind === "gate") return { postTop, seal: null, emblem: 0 }
  const seal = new Container3D({ label: "seal" })
  const plug = build.ink(0x48484d, { brush: 0.6, shade: 0.2, wear: 0.04, streaks: 0.6 })
  const left = parts.box(-half / 2, wall / 2, half / 2, wall / 2 - 0.04, 0, plugTop, plug)
  const right = parts.box(half / 2, wall / 2, half / 2, wall / 2 - 0.04, 0, plugTop, plug)
  const strokeMaterial = parts.keep(spriteMaterial(build.kit.stroke, 0xffffff, 1, "normal"))
  const stroke = parts.flat(0, plugTop + 0.02, wall / 2, half * 2 + 1.4, wall + 0.9, strokeMaterial)
  seal.addChild(left, right, stroke)
  holder.addChild(seal)
  return {
    postTop,
    emblem: plugTop + 0.85,
    seal: {
      pose: (shut, broke) => {
        seal.visible = shut !== null && (broke === null || broke < 4)
        if (!seal.visible || shut === null) return
        if (broke === null) {
          seal.position.set(0, keyed(shut, [3.2, 0.9, -0.08, 0]), 0)
          seal.scale.set(1, keyed(shut, [1.25, 1.1, 0.78, 1]), 1)
          left.position.x = -half / 2
          right.position.x = half / 2
          left.rotation.z = right.rotation.z = 0
          stroke.visible = true
          return
        }
        stroke.visible = false
        const spread = keyed(broke, [0.25, 1.1, 2.2, 3.4])
        left.position.x = -half / 2 - spread
        right.position.x = half / 2 + spread
        left.position.y = right.position.y = (plugTop / 2) + keyed(broke, [0.3, 0.8, 0.9, 0.5])
        left.rotation.z = keyed(broke, [0.15, 0.5, 0.9, 1.3])
        right.rotation.z = -left.rotation.z
      }
    }
  }
}

/** The Spiral: two stele flanking a cut in the ring over a threshold, and an iris of stone plates round an amber seam. */
const spiralDoor = (build: RoomBuild, holder: Container3D, side: Side, kind: Kind, boss: boolean): Frame => {
  const { parts, layout } = build
  const wall = layout.wall
  const south = side === "south"
  const top = south ? KERB : layout.wallHeight
  const postTop = south ? KERB + 0.55 + (boss ? 0.5 : 0) : layout.wallHeight + 1.9 + (boss ? 1.8 : 0)
  if (kind === "closed") return { postTop, seal: null, emblem: 0 }
  const stele = build.ink(0x6c6c72, { wear: 0.1, streaks: 0.45 })
  const cap = build.ink(0x8c8c92, { wear: 0.08, streaks: 0 })
  const half = DOORWAY.width / 2
  const lamp = parts.keep(lampMaterial(paletteOf(build.zone).light, 1.4))
  for (const across of [-(half + 0.34), half + 0.34]) {
    holder.addChild(parts.box(across, wall / 2, 0.34, 0.42, -SUNKEN, postTop, stele), parts.box(across, wall / 2, 0.4, 0.48, postTop, postTop + 0.16, cap))
    if (!south) holder.addChild(parts.box(across, wall / 2 - 0.43, 0.06, 0.02, postTop - 1.1, postTop - 0.35, lamp))
  }
  holder.addChild(parts.box(0, DOORWAY.recess / 2, half, DOORWAY.recess / 2, -SUNKEN, 0, build.ink(0x707076, { wear: 0.14, streaks: 0.1, grainAmount: 0.45 })))
  const plateTop = top + 0.75
  if (kind === "gate") return { postTop, seal: null, emblem: 0 }
  const seal = new Container3D({ label: "seal" })
  const plate = build.ink(0x5c5c62, { wear: 0.14, streaks: 0.2, brush: 0.45 })
  const plates = [-1.125, -0.375, 0.375, 1.125].map((x, index) => {
    const mesh = parts.box(0, 0, 0.42, 0.1, 0, plateTop, plate)
    const holderPlate = new Container3D({ position: { x, y: 0, z: wall / 2 + (index % 2 === 0 ? -0.12 : 0.12) } })
    holderPlate.rotation.z = (index < 2 ? 1 : -1) * 0.08
    holderPlate.addChild(mesh)
    seal.addChild(holderPlate)
    return { holder: holderPlate, home: x }
  })
  const seam = parts.box(0, wall / 2, 0.03, 0.2, plateTop * 0.35, plateTop - 0.08, parts.keep(lampMaterial(paletteOf(build.zone).danger, 1.6)))
  seal.addChild(seam)
  holder.addChild(seal)
  return {
    postTop,
    emblem: plateTop + 0.65,
    seal: {
      pose: (shut, broke, beat) => {
        const share = shut === null ? 0 : broke === null ? keyed(shut, [0.15, 0.6, 1.06, 1]) : keyed(broke, [0.8, 0.35, 0])
        seal.visible = share > 0.01
        for (const each of plates) each.holder.position.x = each.home + Math.sign(each.home) * (1 - share) * (half + 0.4)
        seam.visible = share > 0.95
        seam.scale.y = 1 + (beat % 2) * 0.04
      }
    }
  }
}

/** The Void: two needle posts at the landing's end, and a membrane of hatched accent lines between them. */
const voidDoor = (build: RoomBuild, holder: Container3D, _side: Side, kind: Kind, boss: boolean): Frame => {
  const { parts } = build
  const postTop = boss ? 4.4 : 2.7
  const at = DOORWAY.recess - 0.28
  const half = DOORWAY.width / 2
  if (kind === "closed") return { postTop, seal: null, emblem: 0 }
  const needle = parts.keep(new CylinderGeometry({ radiusTop: 0.02, radiusBottom: 1, height: 1, radialSegments: 4 }))
  const stone = build.ink(0x76767c, { wear: 0.12, streaks: 0.5 })
  const light = parts.keep(lampMaterial(paletteOf(build.zone).light, 2.2))
  for (const across of [-(half + 0.1), half + 0.1]) {
    holder.addChild(new Mesh3D({ geometry: needle, material: stone, position: { x: across, y: postTop / 2, z: at }, scale: { x: 0.2, y: postTop, z: 0.2 }, rotation: { x: 0, y: Math.PI / 4, z: 0 } }))
    holder.addChild(parts.box(across, at, 0.28, 0.28, 0, 0.16, stone))
    const orb = parts.box(across, at, 0.07, 0.07, postTop + 0.18, postTop + 0.32, light)
    orb.castShadow = false
    holder.addChild(orb)
  }
  const seal = new Container3D({ label: "seal" })
  const line = parts.keep(lampMaterial(paletteOf(build.zone).danger, 2.4))
  const bars = Array.from({ length: 7 }, (_, index) => {
    const y = 0.28 + index * 0.33
    const tilt = (index % 2 === 0 ? 1 : -1) * 0.07
    return [-1, 1].map((sideOf) => {
      const pivot = new Container3D({ position: { x: sideOf * (half + 0.05), y, z: at } })
      const bar = parts.box(-sideOf * (half / 2 + 0.03), 0, half / 2 + 0.05, 0.022, -0.022, 0.022, line)
      bar.castShadow = false
      pivot.addChild(bar)
      pivot.rotation.z = tilt * sideOf
      seal.addChild(pivot)
      return { pivot, bar, sideOf, row: index, tilt: tilt * sideOf }
    })
  }).flat()
  holder.addChild(seal)
  return {
    postTop,
    emblem: 1.3,
    seal: {
      pose: (shut, broke, beat) => {
        seal.visible = shut !== null && (broke === null || broke < 4)
        if (!seal.visible || shut === null) return
        for (const each of bars) {
          if (broke === null) {
            const drawn = Math.max(0, Math.min(1, (shut * 2.4 - each.row * 0.8) / 2))
            each.pivot.scale.x = drawn
            each.pivot.visible = drawn > 0
            each.pivot.rotation.z = each.tilt + ((beat + each.row) % 2 === 0 ? 0.012 : -0.012)
            each.pivot.position.y = 0.28 + each.row * 0.33
            continue
          }
          each.pivot.scale.x = 1
          each.pivot.rotation.z = each.tilt - each.sideOf * keyed(broke, [0.35, 0.9, 1.35, 1.5])
          each.pivot.position.y = 0.28 + each.row * 0.33 - keyed(broke, [0, 0.4, 1.4, 3])
        }
      }
    }
  }
}

const STYLES = { courtyard: courtyardDoor, spiral: spiralDoor, void: voidDoor } as const

/** The zone gate's two leaves in the wall, and the glare behind them once they part. */
interface Gate {
  readonly side: Side
  readonly leaves: ReadonlyArray<Container3D>
  /** Each part of the glare with its full strength. */
  readonly glare: ReadonlyArray<{ readonly lit: Lit; readonly full: number }>
  readonly rays: Mesh3D
  openAt: number | null
}

/** A flat of `texture` in `holder`'s frame spilling from the doorway into the room: its foot at the floor's edge. */
const fanInto = (build: RoomBuild, texture: Texture, color: number, width: number, depth: number, y: number): Lit => {
  const material = build.parts.keep(spriteMaterial(texture, color, 0, "add"))
  return { mesh: build.parts.flat(0, y, 0.6 - depth / 2, width, depth, material), material }
}

const buildGate = (build: RoomBuild, holder: Container3D, side: Side): Gate => {
  const { parts, layout } = build
  const wall = Math.max(layout.wall, 1)
  const half = DOORWAY.width / 2
  const top = side === "south" ? KERB + 0.3 : layout.wallHeight + 0.7
  const stone: BaseMaterial3D = build.ink(0x5a5a60, { wear: 0.12, streaks: 0.35, brush: 0.45 })
  const leaves = [-1, 1].map((sideOf) => {
    const leaf = new Container3D({ position: { x: sideOf * half / 2, y: -SUNKEN, z: wall } })
    leaf.addChild(parts.box(0, -wall / 2, half / 2 - 0.02, wall / 2, 0, top + SUNKEN, stone))
    holder.addChild(leaf)
    return leaf
  })
  const ahead = paletteOf(ZONES[build.zone].next ?? build.zone)
  const low = side === "south"
  const core = parts.keep(spriteMaterial(build.kit.glare, ahead.light, 0, "add"))
  const blade = new Mesh3D({ geometry: parts.plane, material: core, billboardMode: "cylindrical", position: { x: 0, y: low ? 0.9 : 2.2, z: wall + 0.6 }, scale: { x: DOORWAY.width * 0.9, y: low ? 1.8 : 4.6, z: 1 }, castShadow: false, receiveShadow: false })
  const hazeMaterial = parts.keep(spriteMaterial(build.textures.glow, ahead.light, 0, "add"))
  const haze = new Mesh3D({ geometry: parts.plane, material: hazeMaterial, billboardMode: "spherical", position: { x: 0, y: low ? 0.6 : 1.8, z: wall + 1.2 }, scale: { x: 4, y: 4, z: 1 }, castShadow: false, receiveShadow: false })
  const fan = fanInto(build, build.kit.fan, ahead.light, GATE_LIGHT.fanWidth, GATE_LIGHT.fanDepth, 0.03)
  const rays = fanInto(build, build.kit.rays, ahead.danger, GATE_LIGHT.fanWidth * 0.9, GATE_LIGHT.fanDepth * 0.85, 0.035)
  const glare = [
    { lit: { mesh: haze, material: hazeMaterial }, full: GATE_LIGHT.haze },
    { lit: { mesh: blade, material: core }, full: GATE_LIGHT.blade },
    { lit: fan, full: GATE_LIGHT.fan },
    { lit: rays, full: GATE_LIGHT.rays }
  ]
  for (const { lit } of glare) {
    lit.mesh.visible = false
    holder.addChild(lit.mesh)
  }
  return { side, leaves, glare, rays: rays.mesh, openAt: null }
}

export interface Doors {
  update(view: GameView, frame: FrameTime): void
}

/**
 * Builds every side's doorway for the room in `build` and returns what poses them each frame: seals shutting and
 * breaking on twos as the room locks and clears, the emblems in locked doorways, an open door's light and chevrons, the gate parting.
 */
export const addDoors = (build: RoomBuild): Doors => {
  const { room, layout, parts, node, kit, zone } = build
  const { danger, light: zoneLight } = paletteOf(zone)
  const style = STYLES[zone]
  const doors: Array<Door> = []
  let gate: Gate | null = null
  for (const each of layout.doors) {
    const isGate = each.side === build.gate
    const kind: Kind = isGate ? "gate" : each.state === "closed" ? "closed" : "door"
    const line = doorLine(layout, each.side)
    const at = onSide(each.side, line)
    const holder = new Container3D({ label: `door-${each.side}`, position: { x: at.x, y: 0, z: at.z }, rotation: { x: 0, y: yawOf(each.side), z: 0 } })
    node.addChild(holder)
    const boss = isGate || isBossDoor(room, each.side)
    const frame = style(build, holder, each.side, kind, boss)
    if (kind === "gate") gate = buildGate(build, holder, each.side)
    const icon = kind === "closed" ? null : iconOf(zone, room, each.side, build.gate)
    const billboard = (texture: Texture, color: number, boost: number, size: number, y: number) => {
      const material = parts.keep(spriteMaterial(texture, color, boost, "normal", [OVERLAY_BAND]))
      return { material, mesh: new Mesh3D({ geometry: parts.plane, material, billboardMode: "spherical", position: { x: 0, y, z: 0 }, scale: { x: size, y: size, z: 1 }, castShadow: false, receiveShadow: false }) }
    }
    const south = each.side === "south"
    const above = south ? onSide(each.side, line + (zone === "void" ? DOORWAY.recess - 0.28 : layout.wall / 2), -SOUTH_EMBLEM.across) : onSide(each.side, line + Math.max(layout.wall, DOORWAY.recess - 0.3) / 2)
    const marker = icon === null ? null : billboard(kit.icons[icon], 0xffffff, 1.15, 1.15, south ? SOUTH_EMBLEM.height : frame.postTop + 0.95).mesh
    if (marker !== null) {
      marker.position.set(above.x, marker.position.y, above.z)
      node.addChild(marker)
    }
    if (kind !== "door") continue
    const inside = south ? above : onSide(each.side, line + 0.7)
    const hang = south ? SOUTH_EMBLEM.height : frame.emblem
    const emblem = new Container3D({ label: "seal-emblem", position: { x: inside.x, y: 0, z: inside.z } })
    const ring = billboard(kit.ward, danger, 1.5, 1.6, hang)
    const sign = icon === null ? null : billboard(kit.icons[icon], danger, 1.8, 0.82, hang)
    emblem.addChild(ring.mesh, ...(sign === null ? [] : [sign.mesh]))
    emblem.visible = false
    node.addChild(emblem)
    const glowAt = onSide(each.side, line + 0.9)
    const glowMaterial = parts.keep(spriteMaterial(kit.glare, zoneLight, 0, "add"))
    const glow = { mesh: new Mesh3D({ geometry: parts.plane, material: glowMaterial, billboardMode: "cylindrical", position: { x: glowAt.x, y: south ? 0.9 : 1.3, z: glowAt.z }, scale: { x: DOORWAY.width, y: south ? 1.8 : 2.8, z: 1 }, castShadow: false, receiveShadow: false }), material: glowMaterial }
    glow.mesh.visible = false
    node.addChild(glow.mesh)
    const spill = fanInto(build, kit.fan, zoneLight, OPEN_LIGHT.fanWidth, OPEN_LIGHT.fanDepth, 0.03)
    const chevronMaterial = parts.keep(spriteMaterial(kit.chevron, 0xffffff, 1, "normal"))
    const chevron = { mesh: parts.flat(0, 0.05, zone === "void" ? DOORWAY.recess * 0.45 : Math.min(layout.wall, DOORWAY.recess) * 0.4, 1.5, 1.3, chevronMaterial), material: chevronMaterial }
    for (const lit of [spill, chevron]) {
      lit.mesh.visible = false
      holder.addChild(lit.mesh)
    }
    const locked = room.doors.find((door) => door.side === each.side)?.state === "locked"
    doors.push({ side: each.side, boss, seal: frame.seal, marker, emblem, emblemMaterials: [ring.material, ...(sign === null ? [] : [sign.material])], glow, spill, chevron, locked, shutAt: locked ? Number.NEGATIVE_INFINITY : null, brokeAt: null })
  }
  if (gate !== null && room.doors.some((door) => door.side === gate?.side)) gate.openAt = Number.NEGATIVE_INFINITY

  return {
    update: (view, frame) => {
      const shown = view.room
      if (shown === null) return
      const now = frame.elapsed
      const beat = Math.floor(now * DRAWINGS)
      const since = (time: number | null) => (time === null ? null : time === Number.NEGATIVE_INFINITY ? 99 : Math.floor((now - time) * DRAWINGS))
      for (const door of doors) {
        const locked = shown.doors.find((each) => each.side === door.side)?.state === "locked"
        if (locked !== door.locked) {
          door.locked = locked
          if (locked) {
            door.shutAt = now
            door.brokeAt = null
          } else door.brokeAt = now
        }
        const shut = since(door.shutAt)
        const broke = since(door.brokeAt)
        door.seal?.pose(shut, broke, beat)
        const sealed = shut !== null && broke === null
        const pulse = door.boss ? 0.5 + 0.5 * Math.sin(now * 2.6) : 1
        const grow = keyed(shut ?? 0, [0, 1.7, 1.25, 1])
        door.emblem.visible = sealed && grow > 0
        door.emblem.scale.set(grow, grow, grow)
        door.emblem.position.y = (1 - grow) * 0.4
        for (const material of door.emblemMaterials) material.data.boost = (1.25 + pulse * 0.6) * (beat % 2 === 0 ? 1 : 0.9)
        if (door.marker !== null) door.marker.visible = !sealed
        const open = !sealed
        const settled = broke === null ? 1 : keyed(broke, [0, 0, 0, 0.3, 0.7, 1])
        const flash = broke === null ? 0 : keyed(broke, [1.2, 0.95, 0.65, 0.4, 0.2, 0])
        const flicker = beat % 2 === 0 ? 1 : 0.86
        const light = open ? Math.max(flash, OPEN_LIGHT.blade * settled * flicker) : 0
        door.glow.mesh.visible = light > 0
        door.glow.material.data.boost = light
        door.spill.mesh.visible = open
        door.spill.material.data.boost = OPEN_LIGHT.spill * settled * flicker
        const pop = broke === null ? 1 : keyed(broke, [0, 0, 0, 0, 1.35, 1])
        door.chevron.mesh.visible = open && pop > 0
        door.chevron.mesh.scale.set(1.5 * pop, 1.3 * pop, 1)
        door.chevron.material.data.boost = OPEN_LIGHT.chevron * (beat % 4 < 2 ? 1 : 0.8)
      }
      if (gate !== null) {
        const open = shown.doors.some((door) => door.side === gate?.side)
        if (open && gate.openAt === null) gate.openAt = now
        const parted = since(gate.openAt)
        const share = parted === null ? 0 : keyed(parted, [0.04, 0.12, 0.3, 0.55, 0.8, 1])
        gate.leaves.forEach((leaf, index) => {
          const sideOf = index === 0 ? -1 : 1
          leaf.rotation.x = share * 1.4
          leaf.position.x = sideOf * (DOORWAY.width / 4 + share * 0.7)
          leaf.position.y = -SUNKEN - share * share * 2.6
          leaf.visible = share < 1
        })
        const flicker = beat % 2 === 0 ? 1 : 0.88
        for (const { lit, full } of gate.glare) {
          lit.mesh.visible = share > 0.1
          lit.material.data.boost = full * share * flicker
        }
        gate.rays.scale.x = GATE_LIGHT.fanWidth * 0.9 * (beat % 2 === 0 ? 1 : 1.04)
      }
    }
  }
}
