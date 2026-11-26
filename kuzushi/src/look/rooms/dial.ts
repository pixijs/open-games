import { Box, Container3D, Mesh3D, SphereGeometry, TorusGeometry } from "@pixi/3d"
import type { BaseMaterial3D, Camera3D, DirectionalLight } from "@pixi/3d"
import { mulberry32 } from "math/random"

import { PALETTE } from "../../art/palette.ts"
import type { FrameTime } from "../../host/types.ts"
import { DOORWAY, onSide, sides } from "../../sim/index.ts"
import type { Block, GameView, Pillar } from "../../sim/index.ts"
import { addColumn, addRingWall, addSpire, columnGeometry, liveSpire, spireLife } from "../dial-parts.ts"
import type { DialInk } from "../dial-parts.ts"
import { aimSun } from "../lighting.ts"
import type { Occluders } from "../occlusion.ts"
import { SUNKEN } from "../parts.ts"
import { isPillar, needles, SPIRAL_SUN, SUN_TURN } from "../spiral.ts"
import { lampMaterial } from "../shaders/sprite.ts"
import type { RoomBuild, ZoneLook } from "./build.ts"
import { doorwaysOf, mirroredSurface, whenDrawn } from "./build.ts"
import { addDialPieces } from "./dial-pieces.ts"
import { seedOf } from "./seed.ts"

/**
 * A Spiral room: its drawn dial of flagstones inside a ring wall with a coping, stele at the hours outside it (taller
 * to the north) and needles of stone beyond, the room's columns, and in well and dial rooms the spire whose slit the
 * beam leaves from. The gnomon's stump carries a sundial's blade; the Orrery's room stands inside a great armillary of
 * rings sunk into the ground round it, moons riding them; every other room has its own landmark beyond the wall
 * (`dial-pieces.ts`). A low cold sun wheels round once every 96 s of play.
 */

/** A centre pillar at least this wide is a spire, with the beam's slit; narrower, the gnomon's stump. */
const SPIRE_RADIUS = 1.3

export const buildDial = (build: RoomBuild, sun: DirectionalLight, camera: Camera3D): ZoneLook => {
  const { parts, layout, node, room, template } = build
  const radius = layout.floor.kind === "round" ? layout.floor.radius : layout.halfWidth
  const outer = radius + layout.wall
  const random = mulberry32.create(seedOf(build.id) ^ 0x5917)
  const next = () => mulberry32.sample(random)
  const glowing: Array<BaseMaterial3D> = []
  const ink: DialInk = (color, options) => {
    const material = build.ink(color, options)
    glowing.push(material)
    return material
  }

  const drawn = build.art.floor(build.id)
  const surface = mirroredSurface(drawn ?? build.kit.grey, -template.halfWidth, -template.halfDepth, template.halfWidth * 2, template.halfDepth * 2, room.mirror)
  const floorMaterial = ink(0xffffff, { surface, grainAmount: 0.3, mottling: 0.12, brush: 0.34, shade: 0.08 })
  const floor = parts.column(0, 0, radius, -0.4, 0, floorMaterial)
  floor.castShadow = false
  const ground = parts.flat(0, -SUNKEN, 0, 320, 320, build.ink(PALETTE.concrete800, { grainAmount: 0.6, mottling: 0.5, brush: 0.4, shade: 0.15 }))
  ground.receiveShadow = true
  node.addChild(ground, floor)
  whenDrawn(build, drawn === null, (late) => {
    floorMaterial.textures.surface = late
  })

  const wallStone = build.ink(PALETTE.concrete600, { wear: 0.06, streaks: 0.2 })
  const coping = build.ink(PALETTE.concrete400, { wear: 0.05, streaks: 0 })
  const steleInk = build.ink(PALETTE.concrete500, { wear: 0.08, streaks: 0.4 })
  const middle = radius + layout.wall / 2
  const segments = Math.round(radius * 4.8)
  const doorways = doorwaysOf(build)
  const gaps = sides.filter((side) => doorways.has(side)).map((side) => {
    const out = onSide(side, 1)
    return Math.atan2(out.z, out.x)
  })
  const cut = Math.asin(Math.min(1, (DOORWAY.width / 2 + 0.64) / middle))
  const near = (angle: number, reach: number) => gaps.some((gap) => Math.abs(Math.atan2(Math.sin(angle - gap), Math.cos(angle - gap))) < reach)
  addRingWall(node, parts, layout, radius, segments, wallStone, coping, (angle) => near(angle, cut + Math.PI / segments))
  const steles: Array<Block> = []
  for (let hour = 0; hour < 12; hour += 1) {
    const angle = (hour / 12) * Math.PI * 2 + Math.PI / 12
    const north = -Math.sin(angle)
    if (north < -0.3 || near(angle, cut + 0.12)) continue
    const height = layout.wallHeight + 0.6 + Math.max(0, north) * 3.4 + (hour % 3 === 0 ? 1.2 : 0) + (room.kind === "boss" ? 1.4 : 0)
    const x = Math.cos(angle) * (outer + 0.45)
    const z = Math.sin(angle) * (outer + 0.45)
    node.addChild(parts.box(x, z, 0.42, 0.3, -SUNKEN, height, steleInk, -angle))
    steles.push({ x, z, halfWidth: 0.45, halfDepth: 0.45, height })
  }

  const centre = layout.pillars.find((pillar) => Math.hypot(pillar.x, pillar.z) < 0.5) ?? null
  const geometry = columnGeometry(parts)
  const columns = layout.pillars.filter((pillar) => pillar !== centre).map((pillar) => addColumn(node, parts, ink, geometry, pillar))
  const spire = centre !== null && centre.radius >= SPIRE_RADIUS ? addSpire(node, parts, ink, build.textures, centre) : null
  if (centre !== null && spire === null) {
    node.addChild(
      parts.column(centre.x, centre.z, centre.radius, 0, centre.height * 0.55, ink(PALETTE.concrete500, { wear: 0.08, streaks: 0.3, shape: { kind: "cylinder", x: centre.x, y: centre.height * 0.275, z: centre.z, radius: centre.radius, halfHeight: centre.height * 0.275 } })),
      parts.column(centre.x, centre.z, centre.radius + 0.08, centre.height * 0.55, centre.height * 0.68, ink(PALETTE.concrete300, { wear: 0.06, streaks: 0 })),
      parts.box(centre.x, centre.z - 0.2, 0.08, centre.radius * 0.9, centre.height * 0.68, centre.height + 1.4, ink(PALETTE.concrete400, { wear: 0.06, streaks: 0.2 }))
    )
  }

  const far = build.ink(PALETTE.concrete600, { wear: 0.09, streaks: 0.45 })
  for (const shape of needles(outer, seedOf(build.id), Math.round(outer * 1.4))) {
    const mesh = isPillar(shape)
      ? parts.column(shape.x, shape.z, shape.radius, -SUNKEN, shape.height, far)
      : parts.box(shape.x, shape.z, shape.halfWidth, shape.halfDepth, -SUNKEN, shape.height, far, Math.atan2(shape.z, shape.x))
    mesh.castShadow = false
    node.addChild(mesh)
  }

  const orbits = room.kind === "boss" ? armillary(build, outer, next) : null
  const pieces = addDialPieces(build, outer)

  const blocks = [...steles, ...pieces.blocks]
  const life = spireLife()
  const rest: ReadonlyArray<Pillar> = [...columns.map((column) => column.shape), ...(spire?.solid ?? []), ...(centre !== null && spire === null ? [centre] : [])]
  let occluders: Occluders = { blocks, pillars: rest }
  const sunSetup = { ...SPIRAL_SUN, bounds: Box.fromCenterSize({ x: 0, y: 6, z: 0 }, { x: outer * 2 + 40, y: 30, z: outer * 2 + 40 }) }
  aimSun(sun, sunSetup)
  return {
    get occluders() {
      return occluders
    },
    pale: false,
    update: (view: GameView, frame: FrameTime) => {
      const standing = liveSpire(spire, columns, glowing, life, view, camera.position, frame.dt, frame.elapsed)
      occluders = { blocks, pillars: centre !== null && spire === null ? [...standing, centre] : standing }
      aimSun(sun, sunSetup, sunSetup.azimuth + frame.gameElapsed * SUN_TURN)
      orbits?.(frame.gameElapsed)
      pieces.update(frame.elapsed)
    }
  }
}

/**
 * The Orrery's room sits inside a great armillary: three rings round the dial just outside its wall, each tilted a
 * little a different way, so their high arcs stand behind the north wall and their low arcs sink under the ground to
 * the south, each carrying a moon that rides round it with a lamp of paper light. Returns what turns them.
 */
const armillary = (build: RoomBuild, outer: number, next: () => number): ((time: number) => void) => {
  const { parts, node } = build
  const bronze = build.ink(PALETTE.concrete400, { wear: 0.12, streaks: 0.2, grainAmount: 0.5 })
  const moonInk = build.ink(PALETTE.concrete300, { wear: 0.1, streaks: 0 })
  const lamp = parts.keep(lampMaterial(0xffffff, 1.8))
  const sphere = parts.keep(new SphereGeometry({ radius: 1, widthSegments: 24, heightSegments: 16 }))
  const rings = [
    { radius: outer + 1.4, tilt: 0.1, turn: -0.3, speed: 0.05 },
    { radius: outer + 3.2, tilt: 0.15, turn: 0.45, speed: -0.035 },
    { radius: outer + 5.2, tilt: 0.21, turn: 1.15, speed: 0.025 }
  ].map((spec) => {
    const turn = new Container3D({ position: { x: 0, y: -0.25, z: 0 }, rotation: { x: 0, y: spec.turn, z: 0 } })
    const holder = new Container3D({ rotation: { x: spec.tilt, y: 0, z: 0 } })
    turn.addChild(holder)
    const torus = parts.keep(new TorusGeometry({ radius: spec.radius, tube: 0.32, radialSegments: 10, tubularSegments: 160 }))
    holder.addChild(new Mesh3D({ geometry: torus, material: bronze, rotation: { x: Math.PI / 2, y: 0, z: 0 } }))
    const rider = new Container3D()
    const moon = new Mesh3D({ geometry: sphere, material: moonInk, position: { x: spec.radius, y: 0, z: 0 }, scale: { x: 1.1, y: 1.1, z: 1.1 } })
    const glow = new Mesh3D({ geometry: sphere, material: lamp, position: { x: spec.radius, y: 0, z: 0 }, scale: { x: 0.28, y: 0.28, z: 0.28 } })
    glow.castShadow = false
    rider.addChild(moon, glow)
    holder.addChild(rider)
    node.addChild(turn)
    return { rider, speed: spec.speed, phase: next() * Math.PI * 2 }
  })
  return (time) => {
    for (const ring of rings) ring.rider.rotation.y = ring.phase + time * ring.speed * Math.PI * 2
  }
}
