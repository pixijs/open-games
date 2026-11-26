import { Container3D } from "@pixi/3d"
import type { Camera3D, DirectionalLight } from "@pixi/3d"

import type { FrameTime } from "../../host/types.ts"
import { DOORWAY, isTemplateId, templateOf } from "../../sim/index.ts"
import type { GameView, RoomView, ZoneId } from "../../sim/index.ts"
import { dialFade } from "../dial-parts.ts"
import { makeParts } from "../parts.ts"
import { ZONE_FILL } from "../shaders/ink.ts"
import type { InkFade } from "../shaders/ink.ts"
import type { LookTextures } from "../textures.ts"
import { nearFade } from "../void-parts.ts"
import type { World } from "../worlds.ts"
import type { RoomArt } from "./art.ts"
import { gateSide } from "./build.ts"
import type { RoomBuild } from "./build.ts"
import { buildDial } from "./dial.ts"
import { addDoors } from "./doors.ts"
import { buildIslands } from "./islands.ts"
import type { RoomKit } from "./kit.ts"
import { addShrines } from "./shrines.ts"
import { buildYard } from "./yard.ts"

export { makeRoomArt } from "./art.ts"
export type { RoomArt } from "./art.ts"
export { loadRoomKit } from "./kit.ts"
export type { RoomKit } from "./kit.ts"
export { gateSide } from "./build.ts"

/** What every room is built from: the look's textures, the rooms' sprites and drawn floors, the sun and the camera. */
export interface RoomDeps {
  readonly textures: LookTextures
  readonly kit: RoomKit
  readonly art: RoomArt
  readonly sun: DirectionalLight
  readonly camera: Camera3D
}

/** How each zone's surfaces fade into the dark round a room: the walled yards and dials slowly, the Void's slabs fast. */
const fadeOf = (zone: ZoneId, room: RoomView): InkFade => {
  const { halfWidth, halfDepth, wall, floor } = room.layout
  const reachX = halfWidth + Math.max(wall, DOORWAY.recess)
  const reachZ = halfDepth + Math.max(wall, DOORWAY.recess)
  switch (zone) {
    case "courtyard": return { halfWidth: reachX, halfDepth: reachZ, corner: 0, start: 0.6, end: 12, depth: 2, high: 0.6, strength: 0.95 }
    case "spiral": return dialFade(reachX, reachZ, floor.kind === "round" ? reachX : 0)
    case "void": return nearFade(halfWidth, halfDepth)
  }
}

/**
 * The room the player is in, finished in its zone's look (docs/DESIGN.md, Look): the zone's floor, walls, props and
 * scenery, its doors, altars and spring. Only this room exists; worlds.ts builds it as the player arrives, under a
 * transition's cover.
 */
export const buildRoom = (zone: ZoneId, room: RoomView, deps: RoomDeps): World => {
  const id = room.template
  if (!isTemplateId(id)) throw new Error(`buildRoom: no template "${id}"`)
  const parts = makeParts(deps.textures)
  const node = new Container3D({ label: `room-${id}` })
  const fade = fadeOf(zone, room)
  let alive = true
  const build: RoomBuild = {
    zone,
    room,
    id,
    template: templateOf(id),
    layout: room.layout,
    parts,
    kit: deps.kit,
    art: deps.art,
    textures: deps.textures,
    node,
    fade,
    ink: (color, options = {}) => parts.ink({ color, fade, fill: ZONE_FILL[zone], grainScale: 0.45, ...options }),
    gate: gateSide(zone, room),
    alive: () => alive
  }
  const look = zone === "courtyard" ? buildYard(build, deps.sun) : zone === "spiral" ? buildDial(build, deps.sun, deps.camera) : buildIslands(build, deps.sun)
  const doors = addDoors(build)
  const shrines = addShrines(build)
  return {
    node,
    get occluders() {
      return look.occluders
    },
    pale: look.pale,
    update: (view: GameView, frame: FrameTime) => {
      look.update(view, frame)
      doors.update(view, frame)
      shrines.update(view, frame)
    },
    dispose: () => {
      alive = false
      node.destroy({ children: true })
      parts.dispose()
    }
  }
}
